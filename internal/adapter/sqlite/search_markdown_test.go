package sqlite

import (
	"strings"
	"testing"
)

func TestSearchMarkdownTechnicalLiterals(t *testing.T) {
	source := "C\\+\\+ &amp; **visible**\n\n`C++ &amp; /tmp/chemin`\n\n~~~sh\nC# &amp;\n~~~\n"
	got := markdownSearchText(source)
	for _, literal := range []string{"C++ & visible", "C++ &amp; /tmp/chemin", "C# &amp;"} {
		if !strings.Contains(got, literal) {
			t.Errorf("missing %q in %q", literal, got)
		}
	}
}

func TestSearchMarkdownBlockSeparations(t *testing.T) {
	for _, source := range []string{
		"premier\n\nsecond",
		"- premier\n- second",
		"| premier | second |\n|---|---|\n| valeur | autre |",
		"> premier\n\nsecond",
		"premier\n\n~~~text\nsecond\n~~~",
	} {
		got := markdownSearchText(source)
		if strings.Contains(got, "premiersecond") {
			t.Fatalf("merged blocks: %q", got)
		}
		if !strings.Contains(got, "premier") || !strings.Contains(got, "second") {
			t.Fatalf("lost text: %q", got)
		}
	}
}
