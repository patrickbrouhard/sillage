// Package filesystem conserve les snapshots locaux sans décider de leur rétention durable.
package filesystem

import (
	"context"
	"fmt"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxSnapshotBytes = 16 << 20

// Transcripts conserve des snapshots immuables et délègue leur décodage au parser source.
type Transcripts struct {
	root  string
	parse func([]byte) (transcript.TranscriptContent, error)
}

// NewTranscripts fixe le répertoire local et le parser, sans créer de fichier.
func NewTranscripts(root string, parse func([]byte) (transcript.TranscriptContent, error)) *Transcripts {
	return &Transcripts{root: root, parse: parse}
}

// Publish écrit entièrement un nouveau fichier avant de rendre son chemin disponible.
// Le chemin stocké est relatif à la racine ; les noms ne dépendent pas du contenu distant.
func (s *Transcripts) Publish(ctx context.Context, data []byte) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(data) == 0 || len(data) > maxSnapshotBytes {
		return "", fmt.Errorf("invalid snapshot size")
	}
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(s.root, ".pending-")
	if err != nil {
		return "", err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return "", err
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	name := "snapshot-" + strings.TrimPrefix(filepath.Base(temporary), ".pending-") + ".json3"
	if err := os.Rename(temporary, filepath.Join(s.root, name)); err != nil {
		return "", err
	}
	return name, nil
}

// Read relit uniquement un snapshot local borné ; toute corruption reste une erreur locale.
func (s *Transcripts) Read(ctx context.Context, path string) (transcript.TranscriptContent, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if path == "" || filepath.Base(path) != path || path == "." || path == ".." {
		return nil, fmt.Errorf("invalid snapshot path")
	}
	file, err := os.Open(filepath.Join(s.root, path))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSnapshotBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSnapshotBytes {
		return nil, fmt.Errorf("snapshot exceeds 16 MiB")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	content, err := s.parse(data)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return content, nil
}
