package filesystem

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/patrickbrouhard/sillage/internal/deletion"
)

var snapshotName = regexp.MustCompile(`^snapshot-[0-9]+\.json3$`)

// Purge borne les effacements à trois racines privées et aux noms générés par Sillage.
type Purge struct{ media, assets, transcripts string }

// NewPurge fixe les racines sans créer de répertoire ni parcourir les fichiers.
func NewPurge(media, assets, transcripts string) *Purge {
	return &Purge{media: media, assets: assets, transcripts: transcripts}
}

// Remove efface un nom autorisé puis synchronise le répertoire, même au réessai.
func (s *Purge) Remove(ctx context.Context, file deletion.File) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var root string
	valid := false
	switch file.Kind {
	case "media":
		root, valid = s.media, mediaName.MatchString(file.Path)
	case "asset":
		root, valid = s.assets, assetName.MatchString(file.Path)
	case "transcript":
		root, valid = s.transcripts, snapshotName.MatchString(file.Path)
	}
	if !valid {
		return fmt.Errorf("invalid purge target")
	}
	before, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		// Une racine absente implique l'absence des fichiers ; synchroniser son parent.
		return syncDirectory(filepath.Dir(root))
	}
	if err != nil {
		return err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid purge root")
	}
	dir, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer dir.Close()
	actual, err := dir.Stat(".")
	if err != nil {
		return err
	}
	if !os.SameFile(before, actual) {
		return fmt.Errorf("purge root changed")
	}
	names := []string{file.Path}
	// Une suppression média interrompue peut avoir laissé la représentation renommée.
	if file.Kind == "media" {
		names = append(names, file.Path+".deleting")
	}
	for _, name := range names {
		info, err := dir.Lstat(name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("invalid purge file")
		}
		if err := dir.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	handle, err := dir.Open(".")
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}
