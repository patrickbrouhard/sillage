package http_test

import (
	"bytes"
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/search"
)

func TestSearchLogPrivacyOnSuccessAndIndexFailure(t *testing.T) {
	base, db := knowledgeAPI(t)
	secret := "privateSearchNeedle"
	content := "privateNoteBody " + secret
	if _, err := sqlite.NewNoteRepository(db).Save(context.Background(), 1, content, 0, time.Now()); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	logger, err := logging.New(&out, "DEBUG", "json")
	if err != nil {
		t.Fatal(err)
	}
	handler := api.WithLogging(logger, api.WithSearch(base, search.NewService(sqlite.NewSearchRepository(db))))
	for _, status := range []int{200, 500} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", "/api/v1/search?q="+secret, nil))
		if recorder.Code != status {
			t.Fatalf("%d", recorder.Code)
		}
		if status == 200 {
			if !strings.Contains(recorder.Body.String(), secret) {
				t.Fatal("missing fixture match")
			}
			if _, err := db.Exec("DROP TABLE video_search"); err != nil {
				t.Fatal(err)
			}
		}
	}
	logs := out.String()
	if strings.Contains(logs, secret) || strings.Contains(logs, "privateNoteBody") || strings.Contains(logs, "SQL logic error") {
		t.Fatal("search data leaked")
	}
	if !strings.Contains(logs, "/api/v1/search") {
		t.Fatal("route missing")
	}
}
