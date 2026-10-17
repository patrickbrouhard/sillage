package filesystem

import (
	"context"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"regexp"

	"github.com/patrickbrouhard/sillage/internal/asset"
)

// Assets limite les lectures et publications à des noms générés dans une racine privée.
type Assets struct{ root string }

// NewAssets ne touche pas au disque afin d'isoler les anomalies de stockage.
func NewAssets(root string) *Assets { return &Assets{root: root} }

var assetName = regexp.MustCompile(`^capture-[0-9]+-[0-9]+ms-[a-f0-9]{32}\.png$`)

func (s *Assets) checkRoot() error {
	info, err := os.Lstat(s.root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid asset root")
	}
	return nil
}

// Prepare réserve une zone éphémère appartenant à l'opération vivante.
func (s *Assets) Prepare() (string, error) {
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return "", err
	}
	if err := s.checkRoot(); err != nil {
		return "", err
	}
	return os.MkdirTemp(s.root, ".pending-")
}

// Discard n'efface jamais les zones abandonnées ni les PNG publiés.
func (s *Assets) Discard(stage string) error {
	if err := s.checkRoot(); err != nil {
		return err
	}
	if filepath.Clean(filepath.Dir(stage)) != filepath.Clean(s.root) || !pendingName.MatchString(filepath.Base(stage)) {
		return fmt.Errorf("invalid asset stage")
	}
	return os.RemoveAll(stage)
}

// Publish décode le PNG complet, synchronise et publie sans écrasement.
func (s *Assets) Publish(ctx context.Context, stage string, a asset.Asset) (string, int64, error) {
	if err := s.checkRoot(); err != nil {
		return "", 0, err
	}
	if filepath.Clean(filepath.Dir(stage)) != filepath.Clean(s.root) || !pendingName.MatchString(filepath.Base(stage)) {
		return "", 0, fmt.Errorf("invalid asset stage")
	}
	info, err := os.Lstat(stage)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", 0, fmt.Errorf("invalid asset stage directory")
	}
	path := filepath.Join(stage, "frame.png")
	if _, err := regular(path); err != nil {
		return "", 0, err
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	// La borne protège le décodage contre une image démesurée ; aucun redimensionnement.
	config, err := png.DecodeConfig(file)
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 100_000_000 {
		return "", 0, fmt.Errorf("invalid PNG dimensions")
	}
	if _, err := file.Seek(0, 0); err != nil {
		return "", 0, err
	}
	if _, err := png.Decode(file); err != nil {
		return "", 0, fmt.Errorf("incomplete PNG: %w", err)
	}
	if err := file.Sync(); err != nil {
		return "", 0, err
	}
	info, err = file.Stat()
	if err != nil {
		return "", 0, err
	}
	if err := ctx.Err(); err != nil {
		return "", 0, err
	}
	name := fmt.Sprintf("capture-%d-%dms-%x.png", a.ID, *a.TimestampMS, randBytes())
	// Link garantit l'absence d'écrasement ; Discard retire ensuite le lien temporaire.
	if err := os.Link(path, filepath.Join(s.root, name)); err != nil {
		return "", 0, err
	}
	if err := syncDirectory(s.root); err != nil {
		return name, info.Size(), err
	}
	return name, info.Size(), nil
}

// Open distingue un contenu indisponible de l'état persistant de génération.
func (s *Assets) Open(a asset.Asset) (asset.Content, error) {
	if err := s.checkRoot(); err != nil {
		return nil, err
	}
	if a.Path == nil || !assetName.MatchString(*a.Path) {
		return nil, fmt.Errorf("invalid asset path")
	}
	path := filepath.Join(s.root, *a.Path)
	info, err := regular(path)
	if err != nil {
		return nil, err
	}
	if info.Size() != a.Size {
		return nil, fmt.Errorf("asset size changed")
	}
	return os.Open(path)
}
