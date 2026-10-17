package media

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// Service possède l'opération globale ; la mémoire n'est jamais la vérité de disponibilité.
type Service struct {
	videos      VideoReader
	repo        Repository
	storage     Storage
	provider    Provider
	ctx         context.Context
	cancel      context.CancelFunc
	timeout     time.Duration
	mu          sync.Mutex
	active      video.VideoSourceID
	operationID string
	leases      map[int64]int
	failures    map[video.VideoSourceID]string
	workers     sync.WaitGroup
	closed      bool
	storageErr  error
}

// NewService rapproche le stockage avant d'accepter des acquisitions.
func NewService(
	ctx context.Context,
	videos VideoReader,
	repo Repository,
	storage Storage,
	provider Provider,
	timeout time.Duration,
) (*Service, error) {
	if timeout <= 0 {
		return nil, fmt.Errorf("invalid download timeout")
	}
	files, err := repo.List(ctx)
	if err != nil {
		return nil, err
	}
	storageErr := storage.Recover(ctx, files)
	if storageErr != nil {
		logging.From(ctx).ErrorContext(ctx, "Media storage disabled", "event", "media.storage_disabled", logging.Error(storageErr))
	}
	owned, cancel := context.WithCancel(ctx)
	return &Service{
		videos:     videos,
		storageErr: storageErr,
		repo:       repo,
		storage:    storage,
		provider:   provider,
		ctx:        owned,
		cancel:     cancel,
		timeout:    timeout,
		failures:   make(map[video.VideoSourceID]string),
	}, nil
}

// Close interdit les nouveaux départs, annule et attend les opérations avant fermeture de SQLite.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.workers.Wait()
}

func (s *Service) source(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (video.VideoSource, error) {
	if videoID <= 0 || sourceID <= 0 {
		return video.VideoSource{}, video.ErrInvalidInput
	}
	v, err := s.videos.Get(ctx, videoID)
	if err != nil {
		return video.VideoSource{}, err
	}
	for _, source := range v.Sources {
		if source.ID == sourceID {
			if source.Provider != "youtube" {
				return video.VideoSource{}, ErrUnsupported
			}
			return source, nil
		}
	}
	return video.VideoSource{}, video.ErrVideoSourceNotFound
}

// Get ne fait aucun accès distant ; une référence disque cassée reste une erreur de consultation.
func (s *Service) Get(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (State, error) {
	if _, err := s.source(ctx, videoID, sourceID); err != nil {
		return State{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state(ctx, sourceID)
}

// state exige le verrou : disponibilité, suppression et publication ne doivent pas se croiser.
func (s *Service) state(ctx context.Context, sourceID video.VideoSourceID) (State, error) {
	// L'activité inclut le nettoyage final : available ne doit jamais précéder sa libération.
	if s.active == sourceID {
		return State{Status: "downloading"}, nil
	}
	if s.storageErr != nil {
		return State{}, fmt.Errorf("media storage unavailable: %w", s.storageErr)
	}

	f, err := s.repo.BySource(ctx, sourceID)
	if err == nil {
		if err := s.storage.Check(f); err != nil {
			return State{File: &f}, fmt.Errorf("%w: %w", ErrUnavailable, err)
		}
		return State{Status: "available", File: &f}, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return State{}, err
	}
	if s.active == sourceID {
		return State{Status: "downloading"}, nil
	}
	if code := s.failures[sourceID]; code != "" {
		return State{Status: "failed", ErrorCode: code}, nil
	}
	return State{Status: "not_downloaded"}, nil
}

// Start accepte une commande idempotente tant qu'un fichier ou une opération existe.
func (s *Service) Start(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (State, error) {
	source, err := s.source(ctx, videoID, sourceID)
	if err != nil {
		return State{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.state(ctx, sourceID)
	if err != nil {
		return state, err
	}
	if state.Status == "available" || state.Status == "downloading" {
		logging.From(ctx).DebugContext(ctx, "Download already present", "event", "download.reused", "source_id", sourceID, "operation_id", s.operationID)
		return state, nil
	}
	if s.closed || s.ctx.Err() != nil {
		return State{}, ErrBusy
	}
	if s.active != 0 {
		return State{}, ErrBusy
	}
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	s.active = sourceID
	delete(s.failures, sourceID)
	s.workers.Add(1)
	s.operationID = rand.Text()
	logger := logging.From(s.ctx).With("component", "download", "operation_id", s.operationID, "video_id", videoID, "source_id", sourceID)
	if origin := logging.RequestID(ctx); origin != "" {
		logger = logger.With("origin_request_id", origin)
	}
	logger.InfoContext(s.ctx, "Download started", "event", "download.started")
	go s.download(logging.WithLogger(s.ctx, logger), source)
	return State{Status: "downloading"}, nil
}

func (s *Service) download(parent context.Context, source video.VideoSource) {
	started := time.Now()
	defer s.workers.Done()
	ctx, cancel := context.WithTimeout(parent, s.timeout)
	defer cancel()
	err := s.acquire(ctx, source)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = 0
	s.operationID = ""
	if err != nil {
		// Mémoire bornée sans historique : les erreurs anciennes peuvent être oubliées.
		if len(s.failures) >= 64 {
			for id := range s.failures {
				delete(s.failures, id)
				break
			}
		}
		s.failures[source.ID] = Code(err)
		level, event := slog.LevelError, "download.failed"
		var uncertain *finalizationError
		if errors.As(err, &uncertain) {
			event = "download.finalization_uncertain"
		}
		if errors.Is(err, context.Canceled) {
			level, event = slog.LevelInfo, "download.interrupted"
		}
		logging.From(ctx).LogAttrs(ctx, level, "Download finished", slog.String("event", event), slog.String("error_code", Code(err)), slog.Int64("elapsed_ms", time.Since(started).Milliseconds()), logging.Error(err))
	} else {
		logging.From(ctx).InfoContext(ctx, "Download completed", "event", "download.completed", "elapsed_ms", time.Since(started).Milliseconds())
	}
}

func (s *Service) acquire(ctx context.Context, source video.VideoSource) error {
	stage, err := s.storage.Prepare()
	if err != nil {
		return err
	}
	defer func() {
		if err := s.storage.Discard(stage); err != nil {
			logging.From(ctx).WarnContext(ctx, "Download cleanup incomplete", "event", "download.cleanup_failed", logging.Error(err))
		}
	}()
	acquired, err := s.provider.Download(ctx, source, stage)
	if err != nil {
		return err
	}
	if acquired.Size <= 0 || acquired.DurationMS <= 0 || strings.TrimSpace(acquired.Format) == "" {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.storage.Publish(ctx, stage, acquired)
	if err != nil {
		return err
	}
	logging.From(ctx).DebugContext(ctx, "Media file published", "event", "download.published", "size_bytes", acquired.Size)
	savedFile, err := s.repo.Save(ctx, File{
		VideoID:        source.VideoID,
		OriginSourceID: &source.ID,
		Path:           path,
		Format:         acquired.Format,
		Size:           acquired.Size,
		DurationMS:     acquired.DurationMS,
		VideoCodec:     acquired.VideoCodec,
		AudioCodec:     acquired.AudioCodec,
		Width:          acquired.Width,
		Height:         acquired.Height,
		FPS:            acquired.FPS,
		AudioLanguage:  acquired.AudioLanguage,
		AddedAt:        time.Now().UTC().Truncate(time.Millisecond),
	})
	if err == nil {
		logging.From(ctx).DebugContext(ctx, "Media reference confirmed", "event", "download.finalized", "media_file_id", savedFile.ID)
	}
	if err != nil {
		logging.From(ctx).WarnContext(ctx, "Media finalization requires verification", "event", "download.finalization_check", logging.Error(err))
		// Une confirmation du fichier exact transforme le commit incertain en succès.
		// Sinon les octets publiés restent récupérables ; l'absence SQL n'autorise aucun effacement.
		checkCtx, cancel := context.WithTimeout(logging.WithLogger(context.Background(), logging.From(ctx)), 2*time.Second)
		defer cancel()
		saved, readErr := s.repo.BySource(checkCtx, source.ID)
		if readErr == nil && saved.Path == path && saved.VideoID == source.VideoID &&
			saved.Format == acquired.Format && saved.Size == acquired.Size &&
			saved.DurationMS == acquired.DurationMS {
			return nil
		}
		return &finalizationError{err}
	}

	return err
}

// Delete supprime l'identité exacte, sans cascade vers la connaissance.
func (s *Service) Delete(ctx context.Context, videoID video.VideoID, id int64) error {
	if videoID <= 0 || id <= 0 {
		return video.ErrInvalidInput
	}
	if _, err := s.videos.Get(ctx, videoID); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.storageErr != nil {
		return fmt.Errorf("media storage unavailable: %w", s.storageErr)
	}
	f, err := s.repo.Get(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if f.VideoID != videoID {
		return ErrNotFound
	}
	if s.leases[f.ID] > 0 || (f.OriginSourceID != nil && s.active == *f.OriginSourceID) {
		return ErrBusy
	}
	if err := s.storage.StageDelete(f); err != nil {
		return err
	}
	if err := s.repo.Delete(ctx, id); err != nil {
		// Une référence encore présente autorise une restauration ; sinon préserver les octets.
		checkCtx, cancel := context.WithTimeout(logging.WithLogger(context.Background(), logging.From(ctx)), 2*time.Second)
		defer cancel()
		if _, readErr := s.repo.Get(checkCtx, id); readErr == nil {
			if restoreErr := s.storage.Restore(f); restoreErr != nil {
				logging.From(ctx).WarnContext(ctx, "Media deletion restoration failed", "event", "media.restore_failed", "media_file_id", id, logging.Error(restoreErr))
			}
		}
		return err
	}
	if f.OriginSourceID != nil {
		delete(s.failures, *f.OriginSourceID)
	}
	if err := s.storage.FinishDelete(f); err != nil {
		return err
	}
	logging.From(ctx).InfoContext(ctx, "Media file deleted", "event", "media.deleted", "video_id", videoID, "media_file_id", id)
	return nil
}

// Borrow réserve le fichier complet de cette source contre DELETE, sans bloquer les téléchargements.
func (s *Service) Borrow(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (string, func(), error) {
	if _, err := s.source(ctx, videoID, sourceID); err != nil {
		return "", nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == sourceID {
		return "", nil, ErrNotFound
	}
	if s.storageErr != nil {
		return "", nil, ErrUnavailable
	}
	f, err := s.repo.BySource(ctx, sourceID)
	if err != nil {
		return "", nil, err
	}
	storage, ok := s.storage.(interface{ ReadPath(File) (string, error) })
	if !ok {
		return "", nil, ErrUnavailable
	}
	path, err := storage.ReadPath(f)
	if err != nil {
		return "", nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if s.leases == nil {
		s.leases = make(map[int64]int)
	}
	s.leases[f.ID]++
	var once sync.Once
	return path, func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.leases[f.ID]--
			if s.leases[f.ID] == 0 {
				delete(s.leases, f.ID)
			}
		})
	}, nil
}

// finalizationError signale des octets publiés sans confirmation, sans changer Code.
type finalizationError struct{ cause error }

func (e *finalizationError) Error() string { return "published media finalization uncertain" }
func (e *finalizationError) Unwrap() error { return e.cause }
func (e *finalizationError) LogValue() slog.Value {
	return slog.GroupValue(slog.String("stage", "finalize"), slog.Bool("file_published", true), logging.Error(e.cause))
}
