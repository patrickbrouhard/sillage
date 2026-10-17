package asset

import (
	"context"
	"errors"
	"fmt"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"log/slog"
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
	logger := logging.From(s.ctx).With("component", "capture", "operation_id", fmt.Sprintf("capture:%d", a.ID), "asset_id", a.ID, "video_id", videoID, "source_id", sourceID, "timestamp_ms", timestamp)
	if origin := logging.RequestID(ctx); origin != "" {
		logger = logger.With("origin_request_id", origin)
	}
	logger.InfoContext(s.ctx, "Capture started", "event", "capture.started")
	go s.generate(logging.WithLogger(s.ctx, logger), a, *source)
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
		return a, nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return a, content, nil
}

func (s *Service) generate(parent context.Context, a Asset, source video.VideoSource) {
	defer s.workers.Done()
	started := time.Now()
	ctx, cancel := context.WithTimeout(parent, s.timeout)
	defer cancel()
	logger := logging.From(ctx)
	path, size, err := s.acquire(ctx, a, source)
	status, code := "available", ""
	if err != nil {
		status, code = "failed", "capture_failed"
		if errors.Is(err, context.Canceled) {
			code = "capture_interrupted"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			code = "capture_timeout"
		}
	}
	s.mu.Lock()
	confirmed := false
	// Le bilan terminal suit la libération d'activité et la confirmation SQL.
	defer func() {
		s.active = 0
		s.mu.Unlock()
		level, event := slog.LevelInfo, "capture.completed"
		if !confirmed {
			level, event = slog.LevelError, "capture.finalization_uncertain"
		} else if status != "available" {
			level, event = slog.LevelError, "capture.failed"
			if code == "capture_interrupted" {
				level, event = slog.LevelInfo, "capture.interrupted"
			}
		}
		attrs := []slog.Attr{slog.String("event", event), slog.String("status", status), slog.Bool("confirmed", confirmed), slog.Bool("file_published", path != ""), slog.Int64("elapsed_ms", time.Since(started).Milliseconds())}
		if code != "" {
			attrs = append(attrs, slog.String("error_code", code))
		}
		if err != nil {
			attrs = append(attrs, logging.Error(err))
		}
		logger.LogAttrs(parent, level, "Capture finished", attrs...)
	}()
	// L'arrêt annule l'extraction, mais laisse un budget indépendant à SQLite.
	finishCtx, stop := context.WithTimeout(logging.WithLogger(context.Background(), logger), 5*time.Second)
	defer stop()
	var stored *string
	if path != "" {
		stored = &path
	}
	if finishErr := s.repo.Finish(finishCtx, a.ID, status, stored, size, code); finishErr != nil {
		logger.WarnContext(finishCtx, "Capture finalization requires verification", "event", "capture.finalization_check", logging.Error(finishErr))
		saved, readErr := s.repo.Get(finishCtx, a.ID)
		if readErr == nil && saved.Status != "pending" {
			status, code = saved.Status, saved.ErrorCode
			confirmed = true
			return
		}
		// Un commit incertain n'autorise jamais l'effacement du PNG publié.
		if retryErr := s.repo.Finish(finishCtx, a.ID, "failed", stored, size, "capture_storage_failed"); retryErr != nil {
			err = retryErr
			return
		}
		status, code = "failed", "capture_storage_failed"
	}
	confirmed = true
}

func (s *Service) acquire(ctx context.Context, a Asset, source video.VideoSource) (string, int64, error) {
	stage, err := s.storage.Prepare()
	if err != nil {
		return "", 0, err
	}
	defer func() {
		if err := s.storage.Discard(stage); err != nil {
			logging.From(ctx).WarnContext(ctx, "Capture cleanup incomplete", "event", "capture.cleanup_failed", logging.Error(err))
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
			logging.From(ctx).WarnContext(ctx, "Capture falling back to remote", "event", "capture.fallback", "from", "local", "to", "remote", logging.Error(err))
		}
	} else {
		if errors.Is(err, media.ErrUnavailable) {
			logging.From(ctx).WarnContext(ctx, "Local media unavailable; using remote", "event", "capture.fallback", "from", "local", "to", "remote", "reason", "local_unavailable")
		}
		err = ErrExtract
	}
	if err != nil {
		if err = s.extractor.Extract(ctx, source, "", *a.TimestampMS, stage); err != nil {
			return "", 0, err
		}
	}
	path, size, err := s.storage.Publish(ctx, stage, a)
	if err == nil {
		logging.From(ctx).DebugContext(ctx, "PNG published", "event", "capture.published", "size_bytes", size)
	}
	return path, size, err
}
