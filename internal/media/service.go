package media

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// Service possède l'opération globale ; la mémoire n'est jamais la vérité de disponibilité.
type Service struct {
	videos   VideoReader
	repo     Repository
	storage  Storage
	provider Provider
	ctx      context.Context
	cancel   context.CancelFunc
	timeout  time.Duration
	mu       sync.Mutex
	active   video.VideoSourceID
	failures map[video.VideoSourceID]string
	workers  sync.WaitGroup
	closed   bool
}

// NewService rapproche le stockage avant d'accepter des acquisitions.
func NewService(ctx context.Context, videos VideoReader, repo Repository, storage Storage, provider Provider, timeout time.Duration) (*Service, error) {
	if timeout <= 0 {
		return nil, fmt.Errorf("invalid download timeout")
	}
	files, err := repo.List(ctx)
	if err != nil {
		return nil, err
	}
	if err := storage.Recover(ctx, files); err != nil {
		return nil, err
	}
	owned, cancel := context.WithCancel(ctx)
	return &Service{videos: videos, repo: repo, storage: storage, provider: provider, ctx: owned, cancel: cancel, timeout: timeout, failures: make(map[video.VideoSourceID]string)}, nil
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
	f, err := s.repo.BySource(ctx, sourceID)
	if err == nil {
		if err := s.storage.Check(f); err != nil {
			return State{File: &f}, fmt.Errorf("%w: %v", ErrUnavailable, err)
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
	go s.download(source)
	return State{Status: "downloading"}, nil
}

func (s *Service) download(source video.VideoSource) {
	defer s.workers.Done()
	ctx, cancel := context.WithTimeout(s.ctx, s.timeout)
	defer cancel()
	err := s.acquire(ctx, source)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = 0
	if err != nil {
		// Mémoire bornée sans historique : les erreurs anciennes peuvent être oubliées.
		if len(s.failures) >= 64 {
			for id := range s.failures {
				delete(s.failures, id)
				break
			}
		}
		s.failures[source.ID] = Code(err)
		log.Printf("media download source=%d: %v", source.ID, err)
	}
}

func (s *Service) acquire(ctx context.Context, source video.VideoSource) error {
	stage, err := s.storage.Prepare()
	if err != nil {
		return err
	}
	defer func() {
		if err := s.storage.Discard(stage); err != nil {
			log.Printf("media staging cleanup: %v", err)
		}
	}()
	acquired, err := s.provider.Download(ctx, source, stage)
	if err != nil {
		return err
	}
	if acquired.Size <= 0 || acquired.DurationMS <= 0 || (acquired.Format != "mp4" && acquired.Format != "webm") {
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
	_, err = s.repo.Save(ctx, File{VideoID: source.VideoID, OriginSourceID: &source.ID, Path: path, Format: acquired.Format, Size: acquired.Size, DurationMS: acquired.DurationMS, AddedAt: time.Now().UTC().Truncate(time.Millisecond)})
	if err != nil {
		// Un résultat de commit incertain ne justifie jamais d'effacer un fichier référencé.
		checkCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		files, readErr := s.repo.List(checkCtx)
		if readErr == nil {
			referenced := false
			for _, f := range files {
				if f.Path == path {
					referenced = true
					break
				}
			}
			if !referenced {
				if cleanupErr := s.storage.RemovePublished(path); cleanupErr != nil {
					log.Printf("media orphan cleanup: %v", cleanupErr)
				}
			}
		}
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
	if f.OriginSourceID != nil && s.active == *f.OriginSourceID {
		return ErrBusy
	}
	if err := s.storage.StageDelete(f); err != nil {
		return err
	}
	if err := s.repo.Delete(ctx, id); err != nil {
		// Le rapprochement restaurera ou effacera selon la base en cas d'issue incertaine.
		checkCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, readErr := s.repo.Get(checkCtx, id); readErr == nil {
			_ = s.storage.Restore(f)
		}
		return err
	}
	if f.OriginSourceID != nil {
		delete(s.failures, *f.OriginSourceID)
	}
	return s.storage.FinishDelete(f)
}
