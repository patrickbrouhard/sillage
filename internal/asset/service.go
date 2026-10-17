package asset

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sync"
	"time"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// Service possède une capture globale indépendante du transport et du téléchargement.
type Service struct {
	videos    Videos
	repo      Repository
	local     LocalMedia
	extractor Extractor
	storage   Storage
	ctx       context.Context
	cancel    context.CancelFunc
	timeout   time.Duration
	mu        sync.Mutex
	active    int64
	closed    bool
	workers   sync.WaitGroup
}

// NewService clôt les intentions interrompues sans toucher aux fichiers conservés.
func NewService(ctx context.Context, videos Videos, repo Repository, local LocalMedia, extractor Extractor, storage Storage, timeout time.Duration) (*Service, error) {
	if timeout <= 0 {
		return nil, fmt.Errorf("invalid capture timeout")
	}
	if err := repo.Interrupt(ctx); err != nil {
		return nil, err
	}
	owned, cancel := context.WithCancel(ctx)
	return &Service{videos: videos, repo: repo, local: local, extractor: extractor, storage: storage, ctx: owned, cancel: cancel, timeout: timeout}, nil
}

// Close attend les processus et les écritures avant fermeture de SQLite.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.workers.Wait()
}

var requestPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,80}$`)

// Start retrouve la même commande ou réserve une nouvelle capture sans file d'attente.
func (s *Service) Start(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID, timestamp int64, requestID string) (Asset, error) {
	if videoID <= 0 || sourceID <= 0 || timestamp < 0 || timestamp > 9007199254740991 || !requestPattern.MatchString(requestID) {
		return Asset{}, video.ErrInvalidInput
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := s.repo.ByRequest(ctx, requestID)
	if err == nil {
		if previous.VideoID != videoID || previous.SourceID == nil || *previous.SourceID != sourceID || previous.TimestampMS == nil || *previous.TimestampMS != timestamp {
			return Asset{}, ErrRequestConflict
		}
		return previous, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Asset{}, err
	}
	if s.closed || s.ctx.Err() != nil || s.active != 0 {
		return Asset{}, ErrBusy
	}
	v, err := s.videos.Get(ctx, videoID)
	if err != nil {
		return Asset{}, err
	}
	var source *video.VideoSource
	for i := range v.Sources {
		if v.Sources[i].ID == sourceID {
			source = &v.Sources[i]
			break
		}
	}
	if source == nil {
		return Asset{}, video.ErrVideoSourceNotFound
	}
	if source.Provider != "youtube" {
		return Asset{}, media.ErrUnsupported
	}
	a, err := s.repo.Create(ctx, Asset{VideoID: videoID, SourceID: &sourceID, TimestampMS: &timestamp, Type: "screenshot", Status: "pending", RequestID: requestID, CreatedAt: time.Now().UTC().Truncate(time.Millisecond)})
	if err != nil {
		return Asset{}, err
	}
	s.active = a.ID
	s.workers.Add(1)
	go s.generate(a, *source)
	return a, nil
}

// Get sépare l'état de génération d'une erreur de lecture des octets.
func (s *Service) Get(ctx context.Context, id int64) (Asset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.repo.Get(ctx, id)
}

// ByRequest récupère une réponse perdue sans nouvelle création.
func (s *Service) ByRequest(ctx context.Context, key string) (Asset, error) {
	if !requestPattern.MatchString(key) {
		return Asset{}, video.ErrInvalidInput
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.repo.ByRequest(ctx, key)
}

// Open ne lance aucune génération et ne modifie pas l'état historique.
func (s *Service) Open(ctx context.Context, id int64) (Asset, Content, error) {
	a, err := s.Get(ctx, id)
	if err != nil {
		return a, nil, err
	}
	if a.Status != "available" {
		return a, nil, ErrUnavailable
	}
	content, err := s.storage.Open(a)
	if err != nil {
		log.Printf("asset content id=%d: %v", id, err)
		return a, nil, ErrUnavailable
	}
	return a, content, nil
}

func (s *Service) generate(a Asset, source video.VideoSource) {
	defer s.workers.Done()
	ctx, cancel := context.WithTimeout(s.ctx, s.timeout)
	defer cancel()
	path, size, err := s.acquire(ctx, a, source)
	// La confirmation et la libération d'activité sont visibles ensemble.
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() { s.active = 0 }()
	finishCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	status, code := "available", ""
	if err != nil {
		status, code = "failed", "capture_failed"
		if errors.Is(err, context.Canceled) {
			code = "capture_interrupted"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			code = "capture_timeout"
		}
		log.Printf("capture id=%d source=%d: %v", a.ID, source.ID, err)
	}
	var stored *string
	if path != "" {
		stored = &path
	}
	if finishErr := s.repo.Finish(finishCtx, a.ID, status, stored, size, code); finishErr != nil {
		// Un commit incertain ne justifie jamais l'effacement du PNG publié.
		log.Printf("capture finalization id=%d: %v", a.ID, finishErr)
		confirmed, readErr := s.repo.Get(finishCtx, a.ID)
		if readErr == nil && confirmed.Status != "pending" {
			return
		}
		if retryErr := s.repo.Finish(finishCtx, a.ID, "failed", stored, size, "capture_storage_failed"); retryErr != nil {
			log.Printf("capture recovery required id=%d: %v", a.ID, retryErr)
		}
	}
}

func (s *Service) acquire(ctx context.Context, a Asset, source video.VideoSource) (string, int64, error) {
	stage, err := s.storage.Prepare()
	if err != nil {
		return "", 0, err
	}
	defer func() {
		if err := s.storage.Discard(stage); err != nil {
			log.Printf("capture cleanup id=%d: %v", a.ID, err)
		}
	}()
	local, release, err := s.local.Borrow(ctx, a.VideoID, source.ID)
	if err != nil && !errors.Is(err, media.ErrNotFound) && !errors.Is(err, media.ErrUnavailable) {
		return "", 0, err
	}
	if local != "" {
		err = s.extractor.Extract(ctx, source, local, *a.TimestampMS, stage)
		release()
		if err != nil {
			if !errors.Is(err, ErrExtract) || ctx.Err() != nil {
				return "", 0, err
			}
			log.Printf("capture id=%d: local extraction failed; trying remote: %v", a.ID, err)
		}
	} else {
		if errors.Is(err, media.ErrUnavailable) {
			log.Printf("capture id=%d: local unavailable; trying remote", a.ID)
		}
		err = ErrExtract
	}
	if err != nil {
		if err = s.extractor.Extract(ctx, source, "", *a.TimestampMS, stage); err != nil {
			return "", 0, err
		}
	}
	return s.storage.Publish(ctx, stage, a)
}
