package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
)

// Ces plafonds expérimentaux restent locaux à l'adapter, sans configuration supplémentaire.
const (
	// MaxRequestBytes borne le corps HTTP avant son décodage par le SDK.
	MaxRequestBytes = 64 << 10
	// MaxResultBytes borne le résultat MCP final, métadonnées SDK incluses, hors enveloppe JSON-RPC.
	MaxResultBytes = 8 << 20
	// OperationTimeout borne chaque lecture applicative.
	OperationTimeout = 30 * time.Second
	// MaxConcurrentReads fixe la capacité immédiate, sans file d’attente.
	MaxConcurrentReads = 4
)

// requestReadTimeout réserve le budget réseau sans consommer la marge d’envoi
// avant le démarrage de la lecture applicative.
const requestReadTimeout = 15 * time.Second

var supportedProtocolVersions = []string{"2026-07-28", "2025-11-25", "2025-06-18"}

type requestContextKey struct{}

// Handler possède les lectures MCP et attend leur fin avant la fermeture du stockage.
type Handler struct {
	ctx           context.Context
	cancel        context.CancelFunc
	transport     http.Handler
	authorities   map[string]bool
	origins       map[string]bool
	protection    *http.CrossOriginProtection
	calls         chan struct{}
	requests      chan struct{}
	timeout       time.Duration
	responseBytes int
	mu            sync.Mutex
	closed        bool
	active        sync.WaitGroup
}

// ValidateAuthorities valide des autorités locales explicites, sans wildcard ni URL.
// Le port est obligatoire, notamment pour distinguer publication hôte et écoute Docker.
func ValidateAuthorities(authorities []string) error {
	if len(authorities) == 0 {
		return fmt.Errorf("MCP requires explicit local authorities")
	}
	for _, authority := range authorities {
		if _, err := localAuthority(authority); err != nil {
			return err
		}
	}
	return nil
}

// localAuthority impose une comparaison canonique et exclut toute autorité réseau générale.
func localAuthority(authority string) (string, error) {
	host, port, err := net.SplitHostPort(authority)
	number, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || number < 1 || number > 65535 || port != strconv.Itoa(number) {
		return "", fmt.Errorf("MCP authorities require a local host and numeric port")
	}
	host = strings.ToLower(host)
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", fmt.Errorf("MCP authorities must be localhost or loopback IP addresses")
	}
	return net.JoinHostPort(host, port), nil
}

// New assemble quatre outils locaux sur le transport stateless officiel.
// Les logs SDK sont désactivés : ils peuvent contenir des erreurs ou en-têtes arbitraires.
func New(ctx context.Context, readers Readers, authorities []string) (*Handler, error) {
	if err := ValidateAuthorities(authorities); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	h := &Handler{
		ctx:           ctx,
		cancel:        cancel,
		authorities:   make(map[string]bool),
		origins:       make(map[string]bool),
		protection:    http.NewCrossOriginProtection(),
		calls:         make(chan struct{}, MaxConcurrentReads),
		requests:      make(chan struct{}, MaxConcurrentReads),
		timeout:       OperationTimeout,
		responseBytes: MaxResultBytes,
	}
	for _, authority := range authorities {
		normalized, _ := localAuthority(authority)
		h.authorities[normalized] = true
		origin := "http://" + normalized
		h.origins[origin] = true
		if err := h.protection.AddTrustedOrigin(origin); err != nil {
			cancel()
			return nil, fmt.Errorf("invalid MCP trusted origin")
		}
	}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := sdk.NewServer(serverImplementation, &sdk.ServerOptions{
		Logger:                    quiet,
		SupportedProtocolVersions: supportedProtocolVersions,
		Capabilities:              &sdk.ServerCapabilities{Tools: &sdk.ToolCapabilities{}},
		SetCacheable: func(_ context.Context, _ sdk.Request, cache *sdk.Cacheable) {
			cache.TTLMs, cache.CacheScope = 0, "private"
		},
	})
	h.addTools(server, readers)
	server.AddReceivingMiddleware(h.toolResults)
	h.transport = sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, &sdk.StreamableHTTPOptions{
		Stateless:                    true,
		JSONResponse:                 true,
		MaxRequestBodyBytes:          MaxRequestBytes,
		PropagateRequestCancellation: true,
		Logger:                       quiet,
	})
	return h, nil
}

// ServeHTTP vérifie Host et chaque Origin avant le SDK, sans consulter les proxies.
// Le plafond de requêtes couvre aussi découverte et initialisation, sans file d'attente.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestlog.Route(r, "/mcp")
	w.Header().Set("Cache-Control", "no-store, private")
	authority, err := localAuthority(r.Host)
	if err != nil || !h.authorities[authority] {
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	}
	if origins, present := r.Header["Origin"]; present {
		if len(origins) != 1 {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		origin := origins[0]
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" ||
			parsed.RawQuery != "" || parsed.Fragment != "" || !h.origins[origin] {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
	}
	if err := h.protection.Check(r); err != nil {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	h.mu.Lock()
	if h.closed || h.ctx.Err() != nil {
		h.mu.Unlock()
		http.Error(w, "server stopping", http.StatusServiceUnavailable)
		return
	}
	h.active.Add(1)
	h.mu.Unlock()
	defer h.active.Done()
	select {
	case h.requests <- struct{}{}:
		defer func() { <-h.requests }()
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "MCP busy; retry later", http.StatusServiceUnavailable)
		return
	}
	// Cette valeur traverse le détachement de contexte du transport historique.
	// Elle protège aussi l'arrêt et la déconnexion sans protocole de session maison.
	ctx, cancel := context.WithTimeout(r.Context(), requestReadTimeout+h.timeout+5*time.Second)
	defer cancel()
	stop := context.AfterFunc(h.ctx, cancel)
	defer stop()
	ctx = context.WithValue(ctx, requestContextKey{}, ctx)
	// Le délai d'envoi est distinct du temps de lecture et évite un client bloqué indéfiniment.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(requestReadTimeout))
	_ = controller.SetWriteDeadline(time.Now().Add(requestReadTimeout + h.timeout + 5*time.Second))
	// Le SDK choisit encore 2025-03-26 si l'en-tête manque, même après restriction
	// des versions. Refuser uniquement les tableaux ferme ce chemin sans analyser ni
	// reconstruire JSON-RPC ; les objets initialize sans en-tête restent inchangés.
	if r.Method == http.MethodPost && r.Body != nil {
		limited := http.MaxBytesReader(w, r.Body, MaxRequestBytes)
		reader := bufio.NewReader(limited)
		for {
			prefix, err := reader.Peek(1)
			if err != nil {
				if _, ok := err.(*http.MaxBytesError); ok {
					http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
					return
				}
				break
			}
			if bytes.IndexByte([]byte(" \t\r\n"), prefix[0]) >= 0 {
				_, _ = reader.ReadByte()
				continue
			}
			if prefix[0] == '[' {
				requestlog.Result(r, "batch_not_supported", nil)
				http.Error(w, "JSON-RPC batches are not supported", http.StatusBadRequest)
				return
			}
			break
		}
		r = r.Clone(ctx)
		r.Body = &bufferedBody{Reader: reader, Closer: limited}
	}
	// Le garde final est une défense exceptionnelle, après mesure du résultat MCP.
	// L'enveloppe peut échapper jusqu'à six octets par octet d'identifiant entrant.
	response := &boundedResponse{header: make(http.Header), limit: MaxResultBytes + 6*MaxRequestBytes + 1024}

	h.transport.ServeHTTP(response, r.WithContext(ctx))
	if response.overflow {
		requestlog.Result(r, "internal_error", nil)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(struct {
			Error errorDTO `json:"error"`
		}{Error: errorDTO{
			Code:            "internal_error",
			Message:         "Unexpected MCP response size; no content was sent.",
			LimitBytes:      response.limit,
			SerializedBytes: response.size,
		}})
		return
	}
	for key, values := range response.header {
		w.Header()[key] = values
	}
	w.Header().Set("Cache-Control", "no-store, private")
	status := response.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = w.Write(response.body.Bytes())
}

// Close interdit les nouveaux appels, annule les lectures et attend les handlers SDK.
// Les services partagés ne sont pas fermés ici ; l'assemblage possède leur cycle de vie.
func (h *Handler) Close() {
	h.mu.Lock()
	h.closed = true
	h.cancel()
	h.mu.Unlock()
	h.active.Wait()
}

// boundedResponse diffère l'envoi jusqu'à la fermeture de la session éphémère du SDK.
// Flush est sans effet : cette tranche ne propose aucun flux serveur ni reprise.
type boundedResponse struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	limit    int
	size     int
	overflow bool
}

// Header isole les en-têtes jusqu’au contrôle final de la réponse.
func (w *boundedResponse) Header() http.Header { return w.header }

// WriteHeader conserve uniquement le premier statut, comme net/http.
func (w *boundedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

// Write abandonne le tampon entier en dépassement, avant tout envoi réseau.
func (w *boundedResponse) Write(data []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	w.size += len(data)
	if w.size > w.limit {
		w.overflow = true
		w.body.Reset()
		return len(data), nil
	}
	if !w.overflow {
		return w.body.Write(data)
	}
	return len(data), nil
}

// Flush reste sans effet pour garantir l’atomicité des réponses JSON non diffusées.
func (w *boundedResponse) Flush() {}

// bufferedBody conserve la fermeture du corps borné après inspection du seul préfixe JSON.
type bufferedBody struct {
	io.Reader
	io.Closer
}
