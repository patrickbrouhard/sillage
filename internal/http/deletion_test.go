package http_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type deleteStub struct {
	pending bool
	err     error
	calls   int
}

func (s *deleteStub) Delete(context.Context, video.VideoID) (bool, error) {
	s.calls++
	return s.pending, s.err
}

func TestDeleteVideoHTTPContract(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		pending    bool
		err        error
		status     int
	}{
		{"complete", "1", false, nil, 204},
		{"pending", "1", true, nil, 202},
		{"busy", "1", false, video.ErrBusy, 409},
		{"uncertain", "1", false, errors.New("database unavailable"), 500},
		{"zero", "0", false, nil, 400},
		{"negative", "-1", false, nil, 400},
		{"invalid", "abc", false, nil, 400},
		{"overflow", "99999999999999999999", false, nil, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := &deleteStub{pending: tc.pending, err: tc.err}
			handler := api.WithDeletion(http.NotFoundHandler(), service)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest("DELETE", "/api/v1/videos/"+tc.path, nil))
			if response.Code != tc.status {
				t.Fatal(response.Code, response.Body.String())
			}
			if tc.status == 400 && service.calls != 0 {
				t.Fatal("invalid ID reached service")
			}
			if tc.status == 204 && response.Body.Len() != 0 {
				t.Fatal("204 body")
			}
		})
	}
}
