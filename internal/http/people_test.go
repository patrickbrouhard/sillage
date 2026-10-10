package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type publisherProviderFunc func(context.Context, string) (video.Publisher, error)

func (f publisherProviderFunc) ResolvePublisher(ctx context.Context, url string) (video.Publisher, error) {
	return f(ctx, url)
}

// peopleAPI relie les vrais services et SQLite à des métadonnées déterministes.
func peopleAPI(t *testing.T) http.Handler {
	t.Helper()
	db, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "people.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	resolver := publisherProviderFunc(func(ctx context.Context, url string) (video.Publisher, error) {
		switch url {
		case "https://youtube.com/@missing":
			return video.Publisher{}, video.ErrMetadataFetchFailed
		case "https://youtube.com/@timeout":
			<-ctx.Done()
			return video.Publisher{}, ctx.Err()
		case "https://youtube.com/@unnamed":
			return video.Publisher{Provider: "youtube", ExternalID: "UC0000000000000000000000"}, nil
		default:
			return video.Publisher{Provider: "youtube", ExternalID: "UC1234567890123456789012", Name: "Clips"}, nil
		}
	})
	provider := providerFunc(func(ctx context.Context, url string) (video.VideoSource, error) {
		var publisher *video.Publisher
		if strings.Contains(url, "published") {
			publisher = &video.Publisher{Provider: "youtube", ExternalID: "UC1234567890123456789012", Name: "Changed"}
		}
		return video.VideoSource{Provider: "youtube", ExternalID: url, CanonicalURL: url, Title: "Title", Publisher: publisher}, nil
	})
	return api.NewRouter(video.NewPublisherService(sqlite.NewPublisherRepository(db), resolver), video.NewPersonService(sqlite.NewPersonRepository(db)), nil, video.NewTagService(sqlite.NewTagRepository(db)), nil, video.NewService(sqlite.NewVideoRepository(db), provider), 50*time.Millisecond)
}

// peopleRequest vérifie le statut avant de décoder le résultat JSON attendu.
func peopleRequest(t *testing.T, h http.Handler, method, path, body string, status int) map[string]any {
	t.Helper()
	contentType := ""
	if body != "" {
		contentType = "application/json"
	}
	response := request(h, method, path, body, contentType)
	if response.Code != status {
		t.Fatalf("%s %s: %d %s", method, path, response.Code, response.Body.String())
	}
	if status == 204 {
		if response.Body.Len() != 0 {
			t.Fatal(response.Body.String())
		}
		return nil
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestPeopleRESTEndToEnd(t *testing.T) {
	h := peopleAPI(t)
	for _, kind := range []string{"publishers", "persons"} {
		got := peopleRequest(t, h, "GET", "/api/v1/"+kind, "", 200)
		if len(got[kind].([]any)) != 0 {
			t.Fatal(got)
		}
	}
	p := peopleRequest(t, h, "POST", "/api/v1/publishers", `{"url":"https://youtube.com/@clips"}`, 201)
	if p["name"] != "Clips" || p["person_id"] != nil {
		t.Fatal(p)
	}
	person := peopleRequest(t, h, "POST", "/api/v1/persons", `{"name":" Lex "}`, 201)
	if person["name"] != "Lex" {
		t.Fatal(person)
	}
	duplicate := peopleRequest(t, h, "POST", "/api/v1/persons", `{"name":"Lex"}`, 201)
	if duplicate["id"] == person["id"] {
		t.Fatal("homonym merged")
	}
	peopleRequest(t, h, "PUT", "/api/v1/publishers/1/person", `{"person_id":1}`, 204)
	reused := peopleRequest(t, h, "POST", "/api/v1/publishers", `{"url":"https://youtube.com/@clips"}`, 200)
	if reused["person_id"] != float64(1) {
		t.Fatal(reused)
	}
	v := peopleRequest(t, h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/published"}`, 201)
	source := v["sources"].([]any)[0].(map[string]any)
	publisher := source["publisher"].(map[string]any)
	if len(publisher) != 2 || publisher["name"] != "Clips" || len(v["person_ids"].([]any)) != 0 {
		t.Fatal(v)
	}
	if _, present := source["creator"]; present {
		t.Fatal("legacy creator")
	}
	if _, present := source["publisher_id"]; present {
		t.Fatal("unexpected publisher_id")
	}
	other := peopleRequest(t, h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/other"}`, 201)
	if other["sources"].([]any)[0].(map[string]any)["publisher"] != nil {
		t.Fatal(other)
	}
	for range 2 {
		peopleRequest(t, h, "PUT", "/api/v1/videos/2/persons/1", "", 204)
	}
	peopleRequest(t, h, "PUT", "/api/v1/videos/1/persons/1", "", 204)
	for mode, want := range map[string]int{"direct": 2, "publisher": 1, "all": 2} {
		got := peopleRequest(t, h, "GET", "/api/v1/persons/1/videos?relation="+mode, "", 200)
		if len(got["videos"].([]any)) != want {
			t.Fatal(mode, got)
		}
	}
	got := peopleRequest(t, h, "GET", "/api/v1/persons/1/publishers", "", 200)
	if len(got["publishers"].([]any)) != 1 {
		t.Fatal(got)
	}
	got = peopleRequest(t, h, "GET", "/api/v1/publishers/1/videos", "", 200)
	if len(got["videos"].([]any)) != 1 {
		t.Fatal(got)
	}
	var tag float64
	for _, path := range []string{"publishers/1", "persons/1", "videos/2"} {
		got := peopleRequest(t, h, "POST", "/api/v1/"+path+"/tags", `{"names":["Café","CAFE\u0301"]}`, 200)
		tags := got["tags"].([]any)
		if len(tags) != 1 {
			t.Fatal(got)
		}
		id := tags[0].(map[string]any)["id"].(float64)
		if tag != 0 && tag != id {
			t.Fatal("different catalogs")
		}
		tag = id
	}
	got = peopleRequest(t, h, "GET", fmt.Sprintf("/api/v1/videos?tag_id=%.0f", tag), "", 200)
	if len(got["videos"].([]any)) != 1 {
		t.Fatal("inherited tags", got)
	}
	for _, path := range []string{"publishers/1", "persons/1"} {
		for range 2 {
			peopleRequest(t, h, "DELETE", fmt.Sprintf("/api/v1/%s/tags/%.0f", path, tag), "", 204)
		}
	}
	got = peopleRequest(t, h, "PATCH", "/api/v1/persons/1", `{"name":"Lex Fridman"}`, 200)
	if got["name"] != "Lex Fridman" {
		t.Fatal(got)
	}
	unnamed := peopleRequest(t, h, "POST", "/api/v1/publishers", `{"url":"https://youtube.com/@unnamed"}`, 201)
	if unnamed["name"] != nil {
		t.Fatal(unnamed)
	}
	peopleRequest(t, h, "PUT", "/api/v1/videos/2/sources/2/publisher", fmt.Sprintf(`{"publisher_id":%.0f}`, unnamed["id"]), 204)
	got = peopleRequest(t, h, "GET", "/api/v1/videos/2", "", 200)
	if got["sources"].([]any)[0].(map[string]any)["publisher"].(map[string]any)["name"] != nil {
		t.Fatal(got)
	}
	peopleRequest(t, h, "PUT", "/api/v1/videos/2/sources/2/publisher", `{"publisher_id":null}`, 204)
	peopleRequest(t, h, "PUT", "/api/v1/publishers/1/person", `{"person_id":null}`, 204)
	for range 2 {
		peopleRequest(t, h, "DELETE", "/api/v1/videos/1/persons/1", "", 204)
	}
	got = peopleRequest(t, h, "GET", "/api/v1/persons/1/videos", "", 200)
	if len(got["videos"].([]any)) != 1 {
		t.Fatal(got)
	}
}

func TestPeopleRESTValidationAndErrors(t *testing.T) {
	h := peopleAPI(t)
	peopleRequest(t, h, "POST", "/api/v1/publishers", `{"url":"https://youtube.com/@clips"}`, 201)
	peopleRequest(t, h, "POST", "/api/v1/persons", `{"name":"Person"}`, 201)
	peopleRequest(t, h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/one"}`, 201)
	for _, tc := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"GET", "/publishers/999", "", 404, "publisher_not_found"},
		{"GET", "/persons/999/videos", "", 404, "person_not_found"},
		{"GET", "/publishers/999/videos", "", 404, "publisher_not_found"},
		{"GET", "/persons/1/videos?relation=unknown", "", 400, "bad_request"},
		{"GET", "/persons/1/videos?relation=direct&relation=all", "", 400, "bad_request"},
		{"GET", "/persons/1/videos?relation=", "", 400, "bad_request"},
		{"POST", "/persons", `{"name":" "}`, 400, "bad_request"},
		{"POST", "/persons", `{"name":null}`, 400, "bad_request"},
		{"POST", "/persons", `{"name":"x","role":"author"}`, 400, "bad_request"},
		{"PUT", "/publishers/1/person", `{}`, 400, "bad_request"},
		{"PUT", "/publishers/1/person", `null`, 400, "bad_request"},
		{"PUT", "/publishers/1/person", `{"person_id":0}`, 400, "bad_request"},
		{"PUT", "/publishers/1/person", `{"person_id":999}`, 404, "person_not_found"},
		{"PUT", "/videos/1/sources/999/publisher", `{"publisher_id":1}`, 404, "video_source_not_found"},
		{"PUT", "/videos/1/sources/1/publisher", `{"publisher_id":999}`, 404, "publisher_not_found"},
		{"PUT", "/videos/1/persons/999", "", 404, "person_not_found"},
		{"PUT", "/videos/999/persons/1", "", 404, "video_not_found"},
		{"PUT", "/videos/1/persons/1", `{}`, 400, "bad_request"},
		{"POST", "/persons/1/tags", `{"names":["valid",null]}`, 400, "bad_request"},
		{"POST", "/publishers/1/tags", `{"names":[]}`, 400, "bad_request"},
		{"POST", "/publishers", `{"url":"https://youtube.com/@missing"}`, 502, "metadata_fetch_failed"},
		{"POST", "/publishers", `{"url":"https://youtube.com/@timeout"}`, 504, "metadata_fetch_timeout"},
	} {
		t.Run(tc.method+tc.path+tc.body, func(t *testing.T) {
			response := request(h, tc.method, "/api/v1"+tc.path, tc.body, "application/json")
			assertError(t, response, tc.status, tc.code)
		})
	}
}
