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

func TestSearchMarkdownCalloutBeforeSetext(t *testing.T) {
	for _, underline := range []string{"---", "==="} {
		got := markdownSearchText("> [!quote:tr](sillage://videos/1/sources/2?start_ms=3) Titre conservé\n> " + underline + "\n> Corps conservé\n")
		if !strings.Contains(got, "Titre conservé") || !strings.Contains(got, "Corps conservé") {
			t.Fatalf("lost callout text: %q", got)
		}
		if strings.Contains(got, "sillage://") || strings.Contains(got, "quote:tr") {
			t.Fatalf("leaked callout metadata: %q", got)
		}
	}
}

func TestSearchMarkdownPreservesCalloutOrder(t *testing.T) {
	for _, content := range []string{
		"Avant\n\n> [!quote] Alice\n> Kubernetes\n\nEntre\n\n> [!quote:tr](sillage://videos/1/sources/2?start_ms=3) Bob\n> PostgreSQL\n\nAprès",
		"Avant\n\n> [!quote] Alice\nKubernetes\n\nEntre\n\n> [!quote] Bob\nPostgreSQL\n\nAprès",
		"Avant\n\n> [!quote] Alice\n> Kubernetes\n>\n> > [!quote] Bob\n> > PostgreSQL\n\nAprès",
	} {
		got := strings.Join(strings.Fields(markdownSearchText(content)), " ")
		want := "Avant Alice Kubernetes Entre Bob PostgreSQL Après"
		if !strings.Contains(content, "Entre") {
			want = "Avant Alice Kubernetes Bob PostgreSQL Après"
		}
		if got != want {
			t.Errorf("extraction = %q, want %q", got, want)
		}
	}
}

func TestSearchMarkdownKeepsCalloutHeadersLiteral(t *testing.T) {
	got := strings.Join(strings.Fields(markdownSearchText("> [!quote] **Alice** &amp; [profil](https://example.org)\n> Corps\n\n> [!quote]\n> Suite")), " ")
	want := "**Alice** &amp; [profil](https://example.org) Corps Suite"
	if got != want {
		t.Fatalf("extraction = %q, want %q", got, want)
	}
}
