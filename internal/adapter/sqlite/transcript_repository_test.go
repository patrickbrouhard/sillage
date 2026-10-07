package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestTranscriptPersistenceRefreshAndNullablePath(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "transcripts.db")
	db := openTestDB(t, path)
	videos := NewVideoRepository(db)
	v, err := videos.Create(ctx, sampleVideo("caption"))
	if err != nil {
		t.Fatal(err)
	}
	repo := NewTranscriptRepository(db)
	source := v.Sources[0].ID
	if _, err := repo.Latest(ctx, source); !errors.Is(err, transcript.ErrNotFound) {
		t.Fatal(err)
	}
	input := transcript.Transcript{VideoSourceID: source, Language: "pt-BR", Provenance: transcript.YouTubeAuto, LastFetchedAt: time.Date(2026, 10, 7, 15, 0, 0, 123456789, time.FixedZone("test", 3600))}
	first, err := repo.Save(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	var storedPath sql.NullString
	var date string
	if err := db.QueryRow("SELECT local_path, last_fetched_at FROM transcripts WHERE id = ?", first.ID).Scan(&storedPath, &date); err != nil || storedPath.Valid || date != "2026-10-07T14:00:00.123Z" {
		t.Fatalf("%v %s %v", storedPath, date, err)
	}
	input.LocalPath = "new.json3"
	input.LastFetchedAt = input.LastFetchedAt.Add(time.Second)
	second, err := repo.Save(ctx, input)
	if err != nil || second.ID != first.ID || !second.LastFetchedAt.After(first.LastFetchedAt) {
		t.Fatalf("%#v %v", second, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	repo = NewTranscriptRepository(db)
	got, err := repo.Latest(ctx, source)
	if err != nil || !reflect.DeepEqual(got, second) {
		t.Fatalf("%#v %v", got, err)
	}
	v, err = NewVideoRepository(db).Get(ctx, v.ID)
	if err != nil || v.Sources[0].OriginalAudioLanguage != "pt-BR" {
		t.Fatalf("%#v %v", v, err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM transcripts").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	input.VideoSourceID = 9999
	if _, err := repo.Save(ctx, input); !errors.Is(err, video.ErrVideoSourceNotFound) {
		t.Fatal(err)
	}
}

func TestTranscriptConstraintsAndSelection(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "transcripts.db"))
	v, err := NewVideoRepository(db).Create(ctx, sampleVideo("selection"))
	if err != nil {
		t.Fatal(err)
	}
	source := v.Sources[0].ID
	insert := `INSERT INTO transcripts (video_source_id, language, provenance, last_fetched_at) VALUES (?, ?, ?, ?)`
	for _, row := range []struct{ language, provenance, date string }{
		{"en", "youtube_auto", "2026-10-07T14:00:00.000Z"},
		{"fr", "youtube_auto", "2026-10-07T14:00:00.100Z"},
		{"pt-BR", "youtube_auto", "2026-10-07T14:00:00.100Z"},
		{"fr", "youtube_manual", "2026-10-07T15:00:00.000Z"},
	} {
		if _, err := db.Exec(insert, source, row.language, row.provenance, row.date); err != nil {
			t.Fatal(err)
		}
	}
	got, err := NewTranscriptRepository(db).Latest(ctx, source)
	if err != nil || got.Language != "pt-BR" {
		t.Fatalf("%#v %v", got, err)
	}
	for _, args := range [][]any{
		{source, "en", "youtube_auto", "2026-10-07T14:00:00.000Z"},
		{9999, "en", "youtube_auto", "2026-10-07T14:00:00.000Z"},
		{source, nil, "youtube_auto", "2026-10-07T14:00:00.000Z"},
		{source, "", "youtube_auto", "2026-10-07T14:00:00.000Z"},
	} {
		if _, err := db.Exec(insert, args...); err == nil {
			t.Fatalf("constraint accepted %v", args)
		}
	}
}

func TestTranscriptSaveRollsBackSourceLanguage(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "rollback.db"))
	v, err := NewVideoRepository(db).Create(ctx, sampleVideo("rollback"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER reject_transcript BEFORE INSERT ON transcripts BEGIN SELECT RAISE(ABORT, 'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	_, err = NewTranscriptRepository(db).Save(ctx, transcript.Transcript{
		VideoSourceID: v.Sources[0].ID, Language: "en", Provenance: transcript.YouTubeAuto, LastFetchedAt: time.Now(),
	})
	if err == nil {
		t.Fatal("expected failure")
	}
	got, err := NewVideoRepository(db).Get(ctx, v.ID)
	if err != nil || got.Sources[0].OriginalAudioLanguage != "" {
		t.Fatalf("%#v %v", got, err)
	}
}
