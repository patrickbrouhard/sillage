package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestMediaProvenanceUniquenessAndKnowledgeSurvivesDeletion(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "test.db"))
	ctx := context.Background()
	videos := NewVideoRepository(db)
	create := func(external string) video.Video {
		v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now().UTC(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: external, Title: external}}})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	v, other := create("first"), create("second")
	repo := NewMediaRepository(db)
	source := v.Sources[0].ID
	f := media.File{VideoID: v.ID, OriginSourceID: &source, Path: "file.mp4", Format: "mp4", Size: 100, DurationMS: 1000, AddedAt: time.Now().UTC().Truncate(time.Millisecond)}
	wrong := f
	wrong.VideoID = other.ID
	if _, err := repo.Save(ctx, wrong); err == nil {
		t.Fatal("accepted foreign source")
	}
	saved, err := repo.Save(ctx, f)
	if err != nil {
		t.Fatal(err)
	}
	duplicate := f
	duplicate.Path = "other.mp4"
	if _, err := repo.Save(ctx, duplicate); err == nil {
		t.Fatal("accepted duplicate source")
	}
	if _, err := db.Exec("INSERT INTO notes (video_id, content_md, created_at, updated_at, revision) VALUES (?, 'knowledge', ?, ?, 1)", v.ID, formatDate(f.AddedAt), formatDate(f.AddedAt)); err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(ctx, saved.ID); err != nil {
		t.Fatal(err)
	}
	var content string
	if err := db.QueryRow("SELECT content_md FROM notes WHERE video_id = ?", v.ID).Scan(&content); err != nil || content != "knowledge" {
		t.Fatalf("%q %v", content, err)
	}
	if _, err := videos.Get(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	// Le modèle général permet plusieurs médias sans provenance, mais jamais un doublon de chemin.
	f.OriginSourceID = nil
	if _, err := repo.Save(ctx, f); err != nil {
		t.Fatal(err)
	}
	f.Path = "another.webm"
	f.Format = "webm"
	if _, err := repo.Save(ctx, f); err != nil {
		t.Fatal(err)
	}
}

// TestMediaMigrationPreservesHistory couvre une base v6 existante, même sans ligne restante.
func TestMediaMigrationPreservesHistory(t *testing.T) {
	for _, empty := range []bool{false, true} {
		t.Run(fmt.Sprint(empty), func(t *testing.T) {
			ctx := context.Background()
			db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			db.SetMaxOpenConns(1)
			if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
				t.Fatal(err)
			}
			files := fstest.MapFS{}
			names, _ := fs.Glob(migrationFiles, "migrations/*.sql")
			for _, name := range names[:6] {
				data, _ := migrationFiles.ReadFile(name)
				files[name] = &fstest.MapFile{Data: data}
			}
			if err := migrate(ctx, db, files); err != nil {
				t.Fatal(err)
			}
			// La fixture historique écrit le schéma v6 sans appeler un repository actuel.
			if _, err := db.Exec("INSERT INTO videos (id, created_at) VALUES (1, ?)", formatDate(time.Now())); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec("INSERT INTO video_sources (id, video_id, provider, title) VALUES (1, 1, 'youtube', 'old')"); err != nil {
				t.Fatal(err)
			}
			v := video.Video{ID: 1, Sources: []video.VideoSource{{ID: 1}}}
			repo := NewMediaRepository(db)
			source := v.Sources[0].ID
			original := media.File{VideoID: v.ID, OriginSourceID: &source, Path: "old.mp4", Format: "mp4", Size: 8, DurationMS: 1000, AddedAt: time.Now().UTC().Truncate(time.Millisecond)}
			saved := original
			err = db.QueryRow(`
 INSERT INTO media_files (video_id, origin_source_id, path, format, size, duration_ms, added_at)
 VALUES (?, ?, ?, ?, ?, ?, ?)
 RETURNING id
 `, original.VideoID, original.OriginSourceID, original.Path, original.Format, original.Size, original.DurationMS, formatDate(original.AddedAt)).Scan(&saved.ID)
			if err != nil {
				t.Fatal(err)
			}
			// Un identifiant déjà utilisé ne doit jamais être réattribué après reconstruction.
			if _, err := db.Exec("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'media_files'"); err != nil {
				t.Fatal(err)
			}
			if empty {
				if err := repo.Delete(ctx, saved.ID); err != nil {
					t.Fatal(err)
				}
			}
			if err := migrate(ctx, db, migrationFiles); err != nil {
				t.Fatal(err)
			}
			if !empty {
				got, err := repo.Get(ctx, saved.ID)
				if err != nil || got.Path != saved.Path || got.OriginSourceID == nil || *got.OriginSourceID != source || !got.AddedAt.Equal(saved.AddedAt) {
					t.Fatalf("%+v %v", got, err)
				}
			}
			original.OriginSourceID = nil
			original.Path = "new.mkv"
			original.Format = "mkv"
			next, err := repo.Save(ctx, original)
			if err != nil || next.ID != 100 {
				t.Fatalf("%+v %v", next, err)
			}
			original.Path = "invalid"
			original.Format = " "
			if _, err := repo.Save(ctx, original); err == nil {
				t.Fatal("empty format accepted")
			}
			rows, err := db.Query("PRAGMA foreign_key_check")
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			if rows.Next() {
				t.Fatal("broken foreign key")
			}
		})
	}
}

// TestMediaMetadataMigration conserve une base v7 sans inventer les métadonnées anciennes.
func TestMediaMetadataMigration(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "v7.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	names, _ := fs.Glob(migrationFiles, "migrations/*.sql")
	for _, name := range names[:7] {
		data, _ := migrationFiles.ReadFile(name)
		files[name] = &fstest.MapFile{Data: data}
	}
	if err := migrate(ctx, db, files); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
 INSERT INTO videos (id, created_at) VALUES (1, '2026-10-16T10:00:00.000Z');
 INSERT INTO media_files (id,video_id,path,format,size,duration_ms,added_at)
 VALUES (41,1,'legacy.mov','mov',100,2000,'2026-10-16T10:00:00.000Z');
 UPDATE sqlite_sequence SET seq = 99 WHERE name = 'media_files';
 `); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, db, migrationFiles); err != nil {
		t.Fatal(err)
	}
	repo := NewMediaRepository(db)
	old, err := repo.Get(ctx, 41)
	if err != nil || old.Path != "legacy.mov" || old.VideoCodec != nil || old.AudioCodec != nil ||
		old.Width != nil || old.Height != nil || old.FPS != nil || old.AudioLanguage != nil {
		t.Fatalf("%+v %v", old, err)
	}
	old.Path = "new.mkv"
	old.Format = "mkv"
	vc, ac, lang := "hevc", "opus", "fr-FR"
	w, h, fps := 1080, 1920, 29.97
	old.VideoCodec, old.AudioCodec, old.AudioLanguage = &vc, &ac, &lang
	old.Width, old.Height, old.FPS = &w, &h, &fps
	saved, err := repo.Save(ctx, old)
	if err != nil || saved.ID != 100 {
		t.Fatalf("%+v %v", saved, err)
	}
	got, err := repo.Get(ctx, saved.ID)
	if err != nil || got.VideoCodec == nil || *got.VideoCodec != vc || got.FPS == nil || *got.FPS != fps ||
		got.AudioLanguage == nil || *got.AudioLanguage != lang {
		t.Fatalf("%+v %v", got, err)
	}
	for _, assignment := range []string{"width = 0", "height = -1", "fps = 0", "video_codec = ''", "audio_codec = ' '", "audio_language = ''"} {
		if _, err := db.Exec("UPDATE media_files SET " + assignment + " WHERE id = 100"); err == nil {
			t.Fatal(assignment)
		}
	}
}
