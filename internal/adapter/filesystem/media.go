package filesystem

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/media"
)

var mediaName = regexp.MustCompile(`^media-[a-f0-9]{32}\.(mp4|webm)$`)
var pendingName = regexp.MustCompile(`^\.pending-[0-9]+$`)

// Media conserve exclusivement les fichiers nommés par Sillage dans sa racine.
type Media struct{ root string }

// NewMedia fixe la racine sans effectuer d'accès disque.
func NewMedia(root string) *Media { return &Media{root: root} }

func (s *Media) path(name string) (string, error) {
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

// Recover rapproche seulement les noms maîtrisés ; une référence douteuse interdit le nettoyage.
func (s *Media) Recover(ctx context.Context, files []media.File) error {
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return err
	}
	root, err := os.Lstat(s.root)
	if err != nil {
		return err
	}
	if !root.IsDir() || root.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid media root")
	}
	referenced := make(map[string]bool)
	for _, f := range files {
		if _, err := s.path(f.Path); err != nil {
			return err
		}
		referenced[f.Path] = true
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	// Valider toutes les entrées concernées avant la première mutation.
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".deleting") && referenced[strings.TrimSuffix(name, ".deleting")] {
			original := filepath.Join(s.root, strings.TrimSuffix(name, ".deleting"))
			if _, err := os.Lstat(original); !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("ambiguous interrupted deletion")
			}
		}
		if mediaName.MatchString(name) || (strings.HasSuffix(name, ".deleting") && mediaName.MatchString(strings.TrimSuffix(name, ".deleting"))) {
			if _, err := regular(filepath.Join(s.root, name)); err != nil {
				return err
			}
		} else if pendingName.MatchString(name) {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("invalid staging directory")
			}
		}
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := entry.Name()
		path := filepath.Join(s.root, name)
		switch {
		case pendingName.MatchString(name):
			if err := os.RemoveAll(path); err != nil {
				return err
			}
		case strings.HasSuffix(name, ".deleting") && mediaName.MatchString(strings.TrimSuffix(name, ".deleting")):
			original := strings.TrimSuffix(name, ".deleting")
			if referenced[original] {
				if _, err := os.Lstat(filepath.Join(s.root, original)); !errors.Is(err, os.ErrNotExist) {
					return fmt.Errorf("ambiguous interrupted deletion")
				}
				if err := os.Rename(path, filepath.Join(s.root, original)); err != nil {
					return err
				}
			} else if err := os.Remove(path); err != nil {
				return err
			}
		case mediaName.MatchString(name) && !referenced[name]:
			if err := os.Remove(path); err != nil {
				return err
			}
		}
	}
	return syncDirectory(s.root)
}

// Prepare réserve un répertoire sur le filesystem de destination.
func (s *Media) Prepare() (string, error) { return os.MkdirTemp(s.root, ".pending-") }

// Discard ne nettoie que la zone temporaire réservée par cet adapter.
func (s *Media) Discard(stage string) error {
	if filepath.Clean(filepath.Dir(stage)) != filepath.Clean(s.root) || !pendingName.MatchString(filepath.Base(stage)) {
		return fmt.Errorf("invalid staging path")
	}
	return os.RemoveAll(stage)
}

// Publish synchronise puis renomme le fichier complet avant toute écriture SQL.
func (s *Media) Publish(ctx context.Context, stage string, acquired media.Acquired) (string, error) {
	if filepath.Clean(filepath.Dir(stage)) != filepath.Clean(s.root) || !pendingName.MatchString(filepath.Base(stage)) {
		return "", fmt.Errorf("invalid staging path")
	}
	if acquired.Format != "mp4" && acquired.Format != "webm" {
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
	dest, _ := s.path(name)
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
	info, err := regular(path)
	if err != nil {
		return err
	}
	if info.Size() != f.Size {
		return fmt.Errorf("media size changed")
	}
	handle, err := os.Open(path)
	if err != nil {
		return err
	}
	return handle.Close()
}

// RemovePublished nettoie un orphelin dont l'absence de référence SQL est confirmée.
func (s *Media) RemovePublished(name string) error {
	path, err := s.path(name)
	if err != nil {
		return err
	}
	if _, err := regular(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(s.root)
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
