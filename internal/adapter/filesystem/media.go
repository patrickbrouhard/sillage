package filesystem

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/media"
)

var mediaName = regexp.MustCompile(`^media-[a-f0-9]{32}\.[a-z0-9][a-z0-9_-]{0,31}$`)
var pendingName = regexp.MustCompile(`^\.pending-[0-9]+$`)

// Media conserve exclusivement les fichiers nommés par Sillage dans sa racine.
type Media struct{ root string }

// NewMedia fixe la racine sans effectuer d'accès disque.
func NewMedia(root string) *Media { return &Media{root: root} }

func (s *Media) path(name string) (string, error) {
	if err := s.checkRoot(); err != nil {
		return "", err
	}
	if !mediaName.MatchString(name) {
		return "", fmt.Errorf("invalid managed media name")
	}
	return filepath.Join(s.root, name), nil
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// regular refuse les liens symboliques ; une disparition est distinguée d'une erreur d'accès.
func regular(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular media file")
	}
	return info, nil
}

// checkRoot refuse une racine remplacée par un lien avant tout accès aux médias.
func (s *Media) checkRoot() error {
	info, err := os.Lstat(s.root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid media root")
	}
	return nil
}

// Recover conserve tous les fichiers abandonnés et restaure seulement une suppression sûre.
// Les erreurs d'une entrée restent locales ; seule une racine inutilisable désactive le stockage.
func (s *Media) Recover(ctx context.Context, files []media.File) error {
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return err
	}
	if err := s.checkRoot(); err != nil {
		return err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	referenced := make(map[string]media.File)
	for _, f := range files {
		if _, err := s.path(f.Path); err != nil {
			logging.From(ctx).WarnContext(ctx, "Invalid media reference", "event", "media.reference_invalid", "media_file_id", f.ID, logging.Error(err))
			continue
		}
		referenced[f.Path] = f
		path := filepath.Join(s.root, f.Path)
		_, originalErr := os.Lstat(path)
		_, deletingErr := os.Lstat(path + ".deleting")
		if errors.Is(originalErr, os.ErrNotExist) && deletingErr == nil {
			// La taille et la lisibilité doivent correspondre avant tout renommage.
			if err := s.checkFile(path+".deleting", f.Size); err != nil {
				logging.From(ctx).DebugContext(ctx, "Media restoration refused", "event", "media.restore_refused", "media_file_id", f.ID, logging.Error(err))
			} else if err := s.Restore(f); err != nil {
				logging.From(ctx).DebugContext(ctx, "Media restoration failed", "event", "media.restore_failed", "media_file_id", f.ID, logging.Error(err))
			} else {
				logging.From(ctx).InfoContext(ctx, "Media file restored", "event", "media.restored", "media_file_id", f.ID)
			}

		}
		if err := s.Check(f); err != nil {
			logging.From(ctx).WarnContext(ctx, "Media file unavailable", "event", "media.unavailable", "media_file_id", f.ID, logging.Error(err))
		}
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := entry.Name()
		_, known := referenced[name]
		if pendingName.MatchString(name) || (mediaName.MatchString(name) && !known) ||
			(strings.HasSuffix(name, ".deleting") && mediaName.MatchString(strings.TrimSuffix(name, ".deleting"))) {
			// Un nom abandonné, même .deleting, ne prouve jamais une intention actuelle d'effacement.
			if _, err := os.Lstat(filepath.Join(s.root, name)); err == nil {
				logging.From(ctx).WarnContext(ctx, "Abandoned media entry preserved", "event", "media.entry_preserved", "managed_name", name)
			}
		}
	}
	return nil
}

// Prepare réserve un répertoire sur le filesystem de destination.
func (s *Media) Prepare() (string, error) {
	if err := s.checkRoot(); err != nil {
		return "", err
	}
	return os.MkdirTemp(s.root, ".pending-")
}

// Discard ne nettoie que la zone temporaire réservée par cet adapter.
func (s *Media) Discard(stage string) error {
	if err := s.checkRoot(); err != nil {
		return err
	}
	if filepath.Clean(filepath.Dir(stage)) != filepath.Clean(s.root) || !pendingName.MatchString(filepath.Base(stage)) {
		return fmt.Errorf("invalid staging path")
	}
	return os.RemoveAll(stage)
}

// Publish synchronise puis renomme le fichier complet avant toute écriture SQL.
func (s *Media) Publish(ctx context.Context, stage string, acquired media.Acquired) (string, error) {
	if err := s.checkRoot(); err != nil {
		return "", err
	}
	infoStage, err := os.Lstat(stage)
	if err != nil {
		return "", err
	}
	if !infoStage.IsDir() || infoStage.Mode()&os.ModeSymlink != 0 {
		return "", media.ErrInvalid
	}
	if filepath.Clean(filepath.Dir(stage)) != filepath.Clean(s.root) || !pendingName.MatchString(filepath.Base(stage)) {
		return "", fmt.Errorf("invalid staging path")
	}
	if !mediaName.MatchString("media-" + strings.Repeat("0", 32) + "." + acquired.Format) {
		return "", media.ErrInvalid
	}
	source := filepath.Join(stage, "media."+acquired.Format)
	info, err := regular(source)
	if err != nil {
		return "", err
	}
	if info.Size() != acquired.Size || info.Size() <= 0 {
		return "", media.ErrInvalid
	}
	file, err := os.OpenFile(source, os.O_RDWR, 0)
	if err != nil {
		return "", err
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	name := fmt.Sprintf("media-%x.%s", randBytes(), acquired.Format)
	dest, err := s.path(name)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(dest); !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("media destination exists or inaccessible")
	}
	if err := os.Rename(source, dest); err != nil {
		return "", err
	}
	if err := syncDirectory(s.root); err != nil {
		return "", err
	}
	return name, nil
}

func randBytes() []byte {
	b := make([]byte, 16)
	// crypto/rand.Read ne retourne plus d'erreur récupérable avec la version Go du projet.
	_, _ = rand.Read(b)
	return b
}

// Check vérifie la disponibilité sans rescanner ni retélécharger le média.
func (s *Media) Check(f media.File) error {
	path, err := s.path(f.Path)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(path + ".deleting"); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("ambiguous interrupted deletion")
	}
	return s.checkFile(path, f.Size)
}

// checkFile vérifie uniquement un fichier régulier, lisible et de taille attendue.
func (s *Media) checkFile(path string, size int64) error {
	info, err := regular(path)
	if err != nil {
		return err
	}
	if info.Size() != size {
		return fmt.Errorf("media size changed")
	}
	handle, err := os.Open(path)
	if err != nil {
		return err
	}
	return handle.Close()
}

// StageDelete conserve une possibilité de restauration avant la suppression SQL.
func (s *Media) StageDelete(f media.File) error {
	path, err := s.path(f.Path)
	if err != nil {
		return err
	}
	if _, err := regular(path); errors.Is(err, os.ErrNotExist) {
		// Une suppression explicite peut résoudre une référence dont le fichier a disparu.
		if _, err := regular(path + ".deleting"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	} else if err != nil {
		return err
	}
	if _, err := os.Lstat(path + ".deleting"); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("deletion target already exists or inaccessible")
	}
	if err := os.Rename(path, path+".deleting"); err != nil {
		return err
	}
	return syncDirectory(s.root)
}

// Restore annule une suppression dont la ligne SQL existe encore.
func (s *Media) Restore(f media.File) error {
	path, err := s.path(f.Path)
	if err != nil {
		return err
	}
	if _, err := regular(path + ".deleting"); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cannot restore over existing path")
	}
	if err := os.Rename(path+".deleting", path); err != nil {
		return err
	}
	return syncDirectory(s.root)
}

// FinishDelete efface les octets seulement après confirmation de la suppression SQL.
func (s *Media) FinishDelete(f media.File) error {
	path, err := s.path(f.Path)
	if err != nil {
		return err
	}
	if _, err := regular(path + ".deleting"); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := os.Remove(path + ".deleting"); err != nil {
		return err
	}
	return syncDirectory(s.root)
}

// ReadPath expose un chemin vérifié uniquement au consommateur interne qui réserve le média.
func (s *Media) ReadPath(f media.File) (string, error) {
	if err := s.Check(f); err != nil {
		return "", err
	}
	path, err := s.path(f.Path)
	if err != nil {
		return "", err
	}
	return filepath.Abs(path)
}
