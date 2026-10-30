// Package deletion orchestre la suppression définitive et la purge autorisée d'une vidéo.
package deletion

import (
	"context"
	"time"

	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// File désigne un fichier attribué par SQLite, relatif à une racine de stockage connue.
type File struct {
	Kind string
	Path string
}

// Repository conserve l'autorisation de purge dans la transaction de suppression métier.
type Repository interface {
	// Delete supprime les données et publie le manifeste atomiquement, ou reprend celui existant.
	Delete(context.Context, video.VideoID) error
	// Pending relit la preuve durable ; absent signifie qu'aucune purge n'est autorisée.
	Pending(context.Context, video.VideoID) ([]File, bool, error)
	// Complete retire le manifeste après synchronisation de tous les effacements.
	Complete(context.Context, video.VideoID) error
	// List fournit uniquement les vidéos ayant un manifeste validé.
	List(context.Context) ([]video.VideoID, error)
}

// Storage efface uniquement les noms explicitement autorisés et synchronise leurs répertoires.
type Storage interface {
	// Remove accepte un fichier déjà absent et refuse chemins étrangers et liens symboliques.
	Remove(context.Context, File) error
}

// Service termine les purges dans l'appel courant ; un manifeste survit à toute interruption.
type Service struct {
	repo     Repository
	storage  Storage
	activity *video.Activity
}

// NewService assemble les ports sans lancer de tâche ni accéder au stockage.
func NewService(repo Repository, storage Storage, activity *video.Activity) *Service {
	return &Service{repo: repo, storage: storage, activity: activity}
}

// Delete retourne true seulement lorsque la suppression métier est prouvée mais la purge incomplète.
func (s *Service) Delete(ctx context.Context, id video.VideoID) (bool, error) {
	if id <= 0 {
		return false, video.ErrInvalidInput
	}
	release, err := s.activity.Delete(id)
	if err != nil {
		return false, err
	}
	defer release()
	err = s.repo.Delete(ctx, id)
	if err != nil {
		// Un transport annulé ou un commit incertain ne suffit jamais à autoriser l'effacement.
		check, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_, exists, readErr := s.repo.Pending(check, id)
		if readErr != nil || !exists {
			return false, err
		}
		return s.purge(check, id), nil
	}
	return s.purge(ctx, id), nil
}

// purge exige une relecture du manifeste même après un commit confirmé.
func (s *Service) purge(ctx context.Context, id video.VideoID) bool {
	files, exists, err := s.repo.Pending(ctx, id)
	if err == nil && !exists {
		return false
	}
	if err == nil {
		for _, file := range files {
			if err = s.storage.Remove(ctx, file); err != nil {
				break
			}
		}
	}
	if err == nil {
		err = s.repo.Complete(ctx, id)
	}
	if err != nil {
		logging.From(ctx).WarnContext(ctx, "Video purge incomplete", "event", "video.purge_pending", "video_id", id, logging.Error(err))
		return true
	}
	logging.From(ctx).InfoContext(ctx, "Video purge completed", "event", "video.deleted", "video_id", id)
	return false
}

// Recover reprend uniquement les autorisations validées ; les orphelins ne sont jamais inventoriés.
// Une anomalie de fichier reste locale au manifeste et n'empêche pas les autres reprises.
func (s *Service) Recover(ctx context.Context) error {
	ids, err := s.repo.List(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return err
		}
		release, err := s.activity.Delete(id)
		if err != nil {
			continue
		}
		s.purge(ctx, id)
		release()
	}
	return nil
}
