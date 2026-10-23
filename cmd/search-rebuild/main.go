// Command search-rebuild régénère l'index depuis les données originales.
package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"os"
)

func main() {
	path := flag.String("db", "data/sillage.db", "SQLite database")
	flag.Parse()
	db, err := sqlite.Open(context.Background(), *path)
	if err == nil {
		defer db.Close()
		err = sqlite.RebuildSearch(context.Background(), db)
	}
	if err != nil {
		// Le détail SQLite peut contenir du contenu utilisateur : seul un bilan constant sort.
		fmt.Fprintln(os.Stderr, "Search reconstruction failed")
		os.Exit(1)
	}
	fmt.Println("Search projection reconstructed")
}
