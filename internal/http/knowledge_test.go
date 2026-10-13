package http_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// knowledgeAPI utilise la persistance réelle et un provider local pour le réajout.
func knowledgeAPI(t *testing.T) (http.Handler, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "knowledge.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	repo := sqlite.NewVideoRepository(db)
	source := video.VideoSource{Provider: "youtube", ExternalID: "one", CanonicalURL: "https://youtu.be/one", Title: "Original"}
	_, err = repo.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{source, {Provider: "local", Title: "Local"}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = repo.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "local", Title: "Other"}}})
	if err != nil {
		t.Fatal(err)
	}
	provider := providerFunc(func(context.Context, string) (video.VideoSource, error) { return source, nil })
	h := api.NewRouter(nil, nil,
		note.NewService(sqlite.NewNoteRepository(db)),
		video.NewTagService(sqlite.NewTagRepository(db)),
		nil,
		video.NewService(repo, provider),
		time.Second,
	)
	return h, db
}

func TestNoteCanonicalLineEndingsAndLegacyRevision(t *testing.T) {
	h, db := knowledgeAPI(t)
	legacy := "\t# Café\r\n\n  texte  \rfin\r\n"
	canonical := "\t# Café\n\n  texte  \nfin\n"
	at := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	// Le port de stockage simule une note historique sans passer par la nouvelle politique d'écriture.
	if _, err := sqlite.NewNoteRepository(db).Save(context.Background(), 1, legacy, 0, at); err != nil {
		t.Fatal(err)
	}
	get := request(h, "GET", "/api/v1/videos/1/note", "", "")
	var got struct {
		Content  string `json:"content_md"`
		Revision int64  `json:"revision"`
	}
	if err := json.Unmarshal(get.Body.Bytes(), &got); err != nil || got.Content != legacy || got.Revision != 1 {
		t.Fatalf("legacy read changed: %s, %v", get.Body.String(), err)
	}
	var stored string
	if err := db.QueryRow("SELECT content_md FROM notes WHERE video_id = 1").Scan(&stored); err != nil || stored != legacy {
		t.Fatalf("legacy storage changed: %q, %v", stored, err)
	}
	var previous string
	for _, content := range []string{legacy, canonical, strings.ReplaceAll(canonical, "\n", "\r\n"), strings.ReplaceAll(canonical, "\n", "\r")} {
		body, _ := json.Marshal(map[string]any{"content_md": content, "expected_revision": got.Revision})
		put := request(h, "PUT", "/api/v1/videos/1/note", string(body), "application/json")
		if err := json.Unmarshal(put.Body.Bytes(), &got); err != nil || put.Code != 200 || got.Content != canonical || got.Revision != 2 {
			t.Fatalf("canonical save failed: %s, %v", put.Body.String(), err)
		}
		// Les variantes de séparateurs sont des no-op après la première normalisation.
		if previous != "" && put.Body.String() != previous {
			t.Fatal("identical canonical content changed revision or dates")
		}
		previous = put.Body.String()
	}
	body, _ := json.Marshal(map[string]any{"content_md": legacy, "expected_revision": 1})
	assertError(t, request(h, "PUT", "/api/v1/videos/1/note", string(body), "application/json"), 409, "note_conflict")
	if err := db.QueryRow("SELECT content_md FROM notes WHERE video_id = 1").Scan(&stored); err != nil || stored != canonical {
		t.Fatalf("canonical storage differs: %q, %v", stored, err)
	}
}

func TestNotesAndTagsREST(t *testing.T) {
	h, _ := knowledgeAPI(t)
	assertError(t, request(h, "GET", "/api/v1/videos/1/note", "", ""), 404, "note_not_found")
	put := request(h, "PUT", "/api/v1/videos/1/note", `{"expected_revision":0,"content_md":""}`, "application/json")
	if put.Code != 201 || put.Header().Get("Location") != "/api/v1/videos/1/note" {
		t.Fatal(put.Code, put.Body.String())
	}
	var first map[string]any
	if err := json.Unmarshal(put.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first) != 5 || first["content_md"] != "" || first["created_at"] != first["updated_at"] || first["video_id"] != float64(1) {
		t.Fatal(first)
	}
	content := "\t# Café\r\n\n  [12:42]  \n\x00😀\n"
	body, _ := json.Marshal(map[string]any{"expected_revision": 1, "content_md": content})
	put = request(h, "PUT", "/api/v1/videos/1/note", string(body), "application/json; charset=utf-8")
	if put.Code != 200 || put.Header().Get("Location") != "" {
		t.Fatal(put.Code, put.Body.String())
	}
	var updated map[string]any
	if err := json.Unmarshal(put.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated["content_md"] != strings.ReplaceAll(content, "\r\n", "\n") || updated["created_at"] != first["created_at"] {
		t.Fatal(updated)
	}
	body, _ = json.Marshal(map[string]any{"content_md": content, "expected_revision": 2})
	identical := request(h, "PUT", "/api/v1/videos/1/note", string(body), "application/json")
	get := request(h, "GET", "/api/v1/videos/1/note", "", "")
	if identical.Code != 200 || get.Code != 200 || identical.Body.String() != put.Body.String() || get.Body.String() != put.Body.String() {
		t.Fatal("no-op changed note")
	}

	catalog := request(h, "GET", "/api/v1/tags", "", "")
	if catalog.Code != 200 || strings.TrimSpace(catalog.Body.String()) != `{"tags":[]}` {
		t.Fatal(catalog.Body.String())
	}
	post := request(h, "POST", "/api/v1/videos/1/tags", `{"names":["Café","DevOps","Cafe\u0301","devops"]}`, "application/json")
	var tags struct {
		Tags []struct {
			ID   int64
			Name string
		}
	}
	if err := json.Unmarshal(post.Body.Bytes(), &tags); err != nil || post.Code != 200 || len(tags.Tags) != 2 || tags.Tags[0].Name != "Café" || tags.Tags[1].Name != "DevOps" || tags.Tags[0].ID >= tags.Tags[1].ID {
		t.Fatal(post.Code, post.Body.String(), err)
	}
	shared := request(h, "POST", "/api/v1/videos/2/tags", `{"names":["CAFÉ"]}`, "application/json")
	if shared.Code != 200 {
		t.Fatal(shared.Body.String())
	}
	additive := request(h, "POST", "/api/v1/videos/1/tags", `{"names":["Golang"]}`, "application/json")
	if additive.Code != 200 {
		t.Fatal(additive.Body.String())
	}

	detail := request(h, "GET", "/api/v1/videos/1", "", "")
	duplicate := request(h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/one"}`, "application/json")
	if duplicate.Code != 200 || duplicate.Body.String() != detail.Body.String() {
		t.Fatal("re-add lost tags")
	}
	var v map[string]any
	if err := json.Unmarshal(detail.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	if len(v) != 5 || len(v["tags"].([]any)) != 3 || len(v["sources"].([]any)) != 2 {
		t.Fatal(v)
	}
	filtered := request(h, "GET", fmt.Sprintf("/api/v1/videos?tag_id=%d", tags.Tags[0].ID), "", "")
	var library struct{ Videos []map[string]any }
	if err := json.Unmarshal(filtered.Body.Bytes(), &library); err != nil || filtered.Code != 200 || len(library.Videos) != 2 || !reflect.DeepEqual(library.Videos[1], v) {
		t.Fatal(filtered.Body.String(), err)
	}
	// Une erreur de validation en fin de lot ne doit pas créer le premier tag.
	assertError(t, request(h, "POST", "/api/v1/videos/1/tags", `{"names":["Transient"," "]}`, "application/json"), 400, "bad_request")
	if got := request(h, "GET", "/api/v1/tags", "", ""); got.Body.String() != additive.Body.String() {
		t.Fatal(got.Body.String())
	}
	for range 2 {
		removed := request(h, "DELETE", fmt.Sprintf("/api/v1/videos/1/tags/%d", tags.Tags[1].ID), "", "")
		if removed.Code != 204 || removed.Body.Len() != 0 {
			t.Fatal(removed.Code, removed.Body.String())
		}
	}
	if got := request(h, "GET", "/api/v1/tags", "", ""); got.Body.String() != additive.Body.String() {
		t.Fatal("unused tag disappeared")
	}
	for _, id := range []int64{tags.Tags[1].ID, 999} {
		got := request(h, "GET", fmt.Sprintf("/api/v1/videos?tag_id=%d", id), "", "")
		if got.Code != 200 || strings.TrimSpace(got.Body.String()) != `{"videos":[]}` {
			t.Fatal(got.Code, got.Body.String())
		}
	}
	if got := request(h, "GET", "/api/v1/videos/1/note", "", ""); got.Body.String() != put.Body.String() {
		t.Fatal("tags or re-add changed note")
	}
}

func TestKnowledgeRESTValidation(t *testing.T) {
	h, db := knowledgeAPI(t)
	for _, tc := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"GET", "/api/v1/videos/999/note", "", 404, "video_not_found"},
		{"PUT", "/api/v1/videos/999/note", `{"expected_revision":0,"content_md":"x"}`, 404, "video_not_found"},
		{"POST", "/api/v1/videos/999/tags", `{"names":["Go"]}`, 404, "video_not_found"},
		{"DELETE", "/api/v1/videos/999/tags/1", "", 404, "video_not_found"},
		{"DELETE", "/api/v1/videos/1/tags/0", "", 400, "bad_request"},
		{"PUT", "/api/v1/videos/0/note", `{"expected_revision":0,"content_md":"x"}`, 400, "bad_request"},
		{"GET", "/api/v1/videos/abc/note", "", 400, "bad_request"},
		{"POST", "/api/v1/videos/9223372036854775808/tags", `{"names":["Go"]}`, 400, "bad_request"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			assertError(t, request(h, tc.method, tc.path, tc.body, "application/json"), tc.status, tc.code)
		})
	}
	for _, query := range []string{"", "0", "-1", "no", "9223372036854775808", "1&tag_id=2", "%GG", "1;bad"} {
		assertError(t, request(h, "GET", "/api/v1/videos?tag_id="+query, "", ""), 400, "bad_request")
	}
	for _, body := range []string{`{"content_md":"x"}`, `{"content_md":"x","expected_revision":-1}`, `{"content_md":"x","expected_revision":null}`, "", "null", "[]", "{}", `{"expected_revision":0,"content_md":null}`, `{"expected_revision":0,"content_md":3}`, `{"expected_revision":0,"content_md":"x","extra":1}`, `{"expected_revision":0,"content_md":"x"}{}`, `{"expected_revision":0,"content_md":"\ud800"}`, `{"expected_revision":0,"content_md":"\udc00"}`, "{\"content_md\":\"\xff\"}"} {
		assertError(t, request(h, "PUT", "/api/v1/videos/1/note", body, "application/json"), 400, "bad_request")
	}
	for _, body := range []string{"null", "[]", "{}", `{"names":null}`, `{"names":[]}`, `{"names":"Go"}`, `{"names":[null]}`, `{"names":[1]}`, `{"names":[" "]}`, `{"names":["Go"],"extra":1}`, `{"names":["` + strings.Repeat("é", 201) + `"]}`} {
		assertError(t, request(h, "POST", "/api/v1/videos/1/tags", body, "application/json"), 400, "bad_request")
	}
	for _, tc := range []struct {
		method, path, body string
		limit              int
	}{
		{"PUT", "/api/v1/videos/1/note", `{"expected_revision":0,"content_md":"\ud83d\ude00\\ud800"}`, 1024 * 1024},
		{"POST", "/api/v1/videos/1/tags", `{"names":["` + strings.Repeat("é", 200) + `"]}`, 64 * 1024},
	} {
		for _, ct := range []string{"", "text/plain", "application/json; charset"} {
			assertError(t, request(h, tc.method, tc.path, tc.body, ct), 415, "unsupported_media_type")
		}
		body := tc.body + strings.Repeat(" ", tc.limit-len(tc.body))
		got := request(h, tc.method, tc.path, body, "application/json; charset=utf-8")
		if got.Code != 200 && got.Code != 201 {
			t.Fatal(got.Code, got.Body.String())
		}
		assertError(t, request(h, tc.method, tc.path, body+" ", "application/json"), 413, "payload_too_large")
	}
	got := request(h, "GET", "/api/v1/videos/1/note", "", "")
	var content struct {
		ContentMD string `json:"content_md"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &content); err != nil || content.ContentMD != "😀\\ud800" {
		t.Fatal(content, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	assertError(t, request(h, "GET", "/api/v1/videos/1/note", "", ""), 500, "internal_error")
	assertError(t, request(h, "GET", "/api/v1/tags", "", ""), 500, "internal_error")
}

func TestNotePreconditionsHTTP(t *testing.T) {
	h, _ := knowledgeAPI(t)
	path := "/api/v1/videos/1/note"
	assertError(t, request(h, "PUT", path, `{"content_md":"legacy"}`, "application/json"), 400, "bad_request")
	first := request(h, "PUT", path, `{"content_md":"first","expected_revision":0}`, "application/json")
	if first.Code != 201 {
		t.Fatal(first.Code, first.Body.String())
	}
	for _, body := range []string{
		`{"content_md":"stale","expected_revision":0}`,
		`{"content_md":"first","expected_revision":0}`,
		`{"content_md":"future","expected_revision":99}`,
	} {
		assertError(t, request(h, "PUT", path, body, "application/json"), 409, "note_conflict")
	}
	same := request(h, "PUT", path, `{"content_md":"first","expected_revision":1}`, "application/json")
	if same.Code != 200 || same.Body.String() != first.Body.String() {
		t.Fatal(same.Body.String())
	}
	if got := request(h, "GET", path, "", ""); got.Body.String() != first.Body.String() {
		t.Fatal(got.Body.String())
	}
}
