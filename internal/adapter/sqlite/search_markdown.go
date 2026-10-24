package sqlite

import (
	"html"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

var searchMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

// markdownSearchText extrait CommonMark/GFM sans destinations ni HTML brut.
// Comme le rendu skipHtml, les balises sont ignorées et leur texte inline reste lisible.
func markdownSearchText(markdown string) string {
	source := []byte(markdown)
	root := searchMarkdown.Parser().Parse(text.NewReader(source))
	// Les en-têtes Sillage sont des métadonnées littérales, pas des liens Markdown.
	// On les remplace avant la seconde analyse, uniquement dans un blockquote et hors code.
	// Un soulignement setext peut donner un Heading au premier bloc avant ce retrait.
	headers := map[int]string{}
	var ranges [][2]int
	ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering || n.Kind() != ast.KindBlockquote {
			return ast.WalkContinue, nil
		}
		first := n.FirstChild()
		if first == nil || first.Kind() == ast.KindCodeBlock || first.Kind() == ast.KindFencedCodeBlock || first.Kind() == ast.KindHTMLBlock || first.Lines().Len() == 0 {
			return ast.WalkContinue, nil
		}
		line := first.Lines().At(0)
		literal := strings.TrimRight(string(line.Value(source)), "\r\n")
		rest, ok := strings.CutPrefix(literal, "[!quote]")
		if !ok {
			rest, ok = strings.CutPrefix(literal, "[!quote:tr](")
			if ok {
				_, tail, closed := strings.Cut(rest, ")")
				if !closed {
					return ast.WalkContinue, nil
				}
				rest = tail
			}
		}
		if ok {
			headers[line.Start] = strings.TrimSpace(rest)
			ranges = append(ranges, [2]int{line.Start, line.Stop})
		}
		return ast.WalkContinue, nil
	})
	for _, r := range ranges {
		for i := r[0]; i < r[1]; i++ {
			if source[i] != '\n' && source[i] != '\r' {
				source[i] = ' '
			}
		}
		// Un caractère neutre conserve le paragraphe et ses continuations ; sa position
		// permettra de restituer l’en-tête littéral sans le réinterpréter comme Markdown.
		source[r[0]] = 'x'
	}
	if len(ranges) > 0 {
		root = searchMarkdown.Parser().Parse(text.NewReader(source))
	}
	var out strings.Builder
	ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			if n.Type() == ast.TypeBlock {
				out.WriteString("\n\n")
			}
			return ast.WalkContinue, nil
		}
		switch node := n.(type) {
		case *ast.Text:
			if header, ok := headers[node.Segment.Start]; ok {
				out.WriteString(header)
				out.WriteString("\n\n")
				return ast.WalkContinue, nil
			}
			value := node.Segment.Value(source)
			if node.IsRaw() || (node.Parent() != nil && node.Parent().Kind() == ast.KindCodeSpan) {
				out.Write(value)
			} else {
				out.WriteString(html.UnescapeString(string(util.UnescapePunctuations(value))))
			}
			if node.SoftLineBreak() || node.HardLineBreak() {
				out.WriteByte('\n')
			}
		case *ast.String:
			out.WriteString(html.UnescapeString(string(node.Value)))
		case *ast.FencedCodeBlock:
			for i := 0; i < node.Lines().Len(); i++ {
				line := node.Lines().At(i)
				out.Write(line.Value(source))
			}
		case *ast.CodeBlock:
			for i := 0; i < node.Lines().Len(); i++ {
				line := node.Lines().At(i)
				out.Write(line.Value(source))
			}
		case *ast.RawHTML, *ast.HTMLBlock:
			return ast.WalkSkipChildren, nil
		case *ast.AutoLink:
			// Une URL auto-liée est une destination ; seul le libellé explicite est indexé.
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	return strings.TrimSpace(out.String())
}
