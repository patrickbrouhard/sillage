// Command server fournit provisoirement une preuve de concept en ligne de commande.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/ytdlp"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "Usage: go run ./cmd/server <URL YouTube>")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := run(ctx, os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, inputURL string) error {
	source, err := (ytdlp.Client{}).Extract(ctx, inputURL)
	if err != nil {
		return err
	}
	result := video.Video{Sources: []video.VideoSource{source}}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(result)
}
