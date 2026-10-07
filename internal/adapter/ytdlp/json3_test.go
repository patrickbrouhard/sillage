package ytdlp

import (
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"os"
	"reflect"
	"testing"
)

func TestParseJSON3Fixture(t *testing.T) {
	data, err := os.ReadFile("testdata/captions.json3")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseJSON3(data)
	want := transcript.TranscriptContent{
		{StartMS: 2960, Text: "This"},
		{StartMS: 3080, Text: " is"},
		{StartMS: 3460, Text: " useful."},
		{StartMS: 5100, Text: "\nÉté — bonjour !"},
		{StartMS: 7000, Text: "\n"},
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("%#v: %v", got, err)
	}
	if got.PlainText() != "This is useful. Été — bonjour !" {
		t.Fatal(got.PlainText())
	}
}

func TestParseJSON3PreservesAppendAndEqualTimes(t *testing.T) {
	got, err := ParseJSON3([]byte(`{"events":[
  {"tStartMs":0,"segs":[{"utf8":"Bon"},{"utf8":"jour"}]},
  {"tStartMs":0,"aAppend":1,"segs":[{"utf8":", le monde !"}]}
 ]}`))
	if err != nil || got.PlainText() != "Bonjour, le monde !" || len(got) != 3 {
		t.Fatalf("%#v %v", got, err)
	}
}

func TestParseJSON3RejectsUnusableDocuments(t *testing.T) {
	for _, data := range []string{
		"", "null", "{}", "[]", "{", "{} {}", `{"events":[]}`,
		`{"events":[{"tStartMs":0,"segs":[{"utf8":" \n "}]}]}`,
		`{"events":[{"segs":[{"utf8":"text"}]}]}`,
		`{"events":[{"tStartMs":-1,"segs":[{"utf8":"text"}]}]}`,
		`{"events":[{"tStartMs":0,"segs":[{"utf8":"text","tOffsetMs":-1}]}]}`,
		`{"events":[{"tStartMs":9223372036854775807,"segs":[{"utf8":"text","tOffsetMs":1}]}]}`,
		`{"events":[{"tStartMs":0.5,"segs":[{"utf8":"text"}]}]}`,
		`{"events":[{"tStartMs":0,"segs":[{"utf8":42}]}]}`,
		`{"events":[{"tStartMs":0,"segs":[{"utf8":"ok"}]},{"segs":[{"utf8":"bad"}]}]}`,
	} {
		t.Run(data, func(t *testing.T) {
			got, err := ParseJSON3([]byte(data))
			if err == nil || got != nil {
				t.Fatalf("accepted %q: %#v %v", data, got, err)
			}
		})
	}
}
