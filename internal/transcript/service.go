package transcript

import (
	"context"
	"fmt"
	"github.com/patrickbrouhard/sillage/internal/video"
	"strings"
	"time"
)

// VideoReader permet de vérifier l'appartenance d'une source sans dépendre de HTTP.
type VideoReader interface {
	// Get relit une vidéo et toutes ses sources, ou video.ErrVideoNotFound.
	Get(context.Context, video.VideoID) (video.Video, error)
}

// Acquisition contient le contenu normalisé et les octets source à conserver tels quels.
type Acquisition struct {
	Language string
	Content  TranscriptContent
	Source   []byte
}

// Provider acquiert exclusivement la transcription automatique originale de cette tranche.
type Provider interface {
	// Fetch sélectionne, récupère et valide un contenu sans modifier la persistance.
	Fetch(context.Context, video.VideoSource) (Acquisition, error)
}

// Repository conserve une identité stable et sélectionne la dernière acquisition réussie.
type Repository interface {
	// Save actualise atomiquement la transcription et renseigne la langue audio encore inconnue.
	Save(context.Context, Transcript) (Transcript, error)
	// Latest départage les dates égales par ID décroissant pour la politique youtube_auto.
	Latest(context.Context, video.VideoSourceID) (Transcript, error)
}

// Snapshots publie des fichiers indépendants et relit leur contenu sans accès distant.
type Snapshots interface {
	// Publish rend disponible un nouveau fichier complet sans écraser un snapshot.
	Publish(context.Context, []byte) (string, error)
	// Read retourne le contenu local décodé ou une erreur locale.
	Read(context.Context, string) (TranscriptContent, error)
}

// Service orchestre acquisition et lecture locale via des ports spécialisés.
type Service struct {
	videos     VideoReader
	repository Repository
	provider   Provider
	snapshots  Snapshots
}

// NewService assemble les dépendances sans accéder aux systèmes externes.
func NewService(videos VideoReader, repository Repository, provider Provider, snapshots Snapshots) *Service {
	return &Service{videos: videos, repository: repository, provider: provider, snapshots: snapshots}
}

// Fetch acquiert puis publie une transcription ; un échec préserve la précédente.
func (s *Service) Fetch(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (Result, error) {
	source, err := s.source(ctx, videoID, sourceID)
	if err != nil {
		return Result{}, err
	}
	if source.Provider != "youtube" {
		return Result{}, ErrNotAvailable
	}
	acquired, err := s.provider.Fetch(ctx, source)
	if err != nil {
		return Result{}, err
	}
	if strings.TrimSpace(acquired.Language) == "" || acquired.Content.PlainText() == "" || len(acquired.Source) == 0 {
		return Result{}, ErrFetchFailed
	}
	if source.OriginalAudioLanguage != "" && source.OriginalAudioLanguage != acquired.Language {
		return Result{}, ErrNotAvailable
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	path, err := s.snapshots.Publish(ctx, acquired.Source)
	if err != nil {
		return Result{}, fmt.Errorf("publish transcript snapshot: %w", err)
	}
	// Le nouveau fichier ne remplace jamais l'ancien. Un échec SQL peut laisser
	// un fichier orphelin, mais ne doit pas détruire un snapshot encore lu par un GET.
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	saved, err := s.repository.Save(ctx, Transcript{
		VideoSourceID: sourceID,
		Language:      acquired.Language,
		Provenance:    YouTubeAuto,
		LocalPath:     path,
		LastFetchedAt: time.Now().UTC().Truncate(time.Millisecond),
	})
	if err != nil {
		return Result{}, fmt.Errorf("save transcript: %w", err)
	}
	return Result{Transcript: saved, Content: acquired.Content}, nil
}

// Get restitue la dernière acquisition locale, même si YouTube est indisponible.
func (s *Service) Get(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (Result, error) {
	if _, err := s.source(ctx, videoID, sourceID); err != nil {
		return Result{}, err
	}
	saved, err := s.repository.Latest(ctx, sourceID)
	if err != nil {
		return Result{}, err
	}
	if saved.LocalPath == "" {
		return Result{}, fmt.Errorf("transcript snapshot is absent")
	}
	content, err := s.snapshots.Read(ctx, saved.LocalPath)
	if err != nil {
		return Result{}, fmt.Errorf("read transcript snapshot: %w", err)
	}
	return Result{Transcript: saved, Content: content}, nil
}

// source vérifie les deux identités avant toute acquisition ou lecture de snapshot.
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
			return source, nil
		}
	}
	return video.VideoSource{}, video.ErrVideoSourceNotFound
}
