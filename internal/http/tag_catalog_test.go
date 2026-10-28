package http_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestTagCatalogREST(t *testing.T) {
	h, _ := knowledgeAPI(t)
	post := request(h, "POST", "/api/v1/videos/1/tags", `{"names":["Café","Other"]}`, "application/json")
	var tags struct {
		Tags []struct {
			ID   int64
			Name string
		}
	}
	if err := json.Unmarshal(post.Body.Bytes(), &tags); err != nil || post.Code != 200 {
		t.Fatal(post.Body.String(), err)
	}
	path := fmt.Sprintf("/api/v1/tags/%d", tags.Tags[0].ID)
	for _, tc := range []struct {
		path, body string
		status     int
		code       string
	}{
		{path, `{"name":"OTHER"}`, 409, "tag_conflict"},
		{"/api/v1/tags/999", `{"name":"Other"}`, 404, "tag_not_found"},
		{"/api/v1/tags/0", `{"name":"valid"}`, 400, "bad_request"},
		{path, `{}`, 400, "bad_request"},
		{path, `{"name":null}`, 400, "bad_request"},
		{path, `{"name":" "}`, 400, "bad_request"},
		{path, `{"name":"\ud800"}`, 400, "bad_request"},
		{path, `{"name":"valid","extra":true}`, 400, "bad_request"},
	} {
		assertError(t, request(h, "PATCH", tc.path, tc.body, "application/json"), tc.status, tc.code)
	}
	got := request(h, "PATCH", path, `{"name":" CAFE\u0301 "}`, "application/json")
	if got.Code != 200 || !strings.Contains(got.Body.String(), `"name":"CAFÉ"`) || strings.Contains(got.Body.String(), "count") {
		t.Fatal(got.Code, got.Body.String())
	}
	catalog := request(h, "GET", "/api/v1/tags", "", "")
	var body struct{ Tags []map[string]any }
	if err := json.Unmarshal(catalog.Body.Bytes(), &body); err != nil || catalog.Code != 200 || len(body.Tags) != 2 {
		t.Fatal(catalog.Body.String(), err)
	}
	if len(body.Tags[0]) != 5 || body.Tags[0]["video_count"] != float64(1) || body.Tags[0]["publisher_count"] != float64(0) || body.Tags[0]["person_count"] != float64(0) {
		t.Fatal(body)
	}
	assertError(t, request(h, "DELETE", path, `{}`, "application/json"), 400, "bad_request")
	for range 2 {
		got := request(h, "DELETE", path, "", "")
		if got.Code != 204 || got.Body.Len() != 0 {
			t.Fatal(got.Code, got.Body.String())
		}
	}
	assertError(t, request(h, "PATCH", path, `{"name":"Again"}`, "application/json"), 404, "tag_not_found")
	detail := request(h, "GET", "/api/v1/videos/1", "", "")
	if detail.Code != 200 || strings.Contains(detail.Body.String(), "CAFE") || !strings.Contains(detail.Body.String(), "Other") {
		t.Fatal(detail.Body.String())
	}
}
