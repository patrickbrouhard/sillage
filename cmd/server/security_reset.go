package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
	"golang.org/x/term"
	"os"
	"strings"
)

// runSecurityReset révoque les accès sans contourner ni modifier l'autorité OIDC.
// Comme les commandes owner, ce secours exige un arrêt préalable du serveur.
func runSecurityReset() error {
	if len(os.Args) != 2 || !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("security-reset requires an interactive terminal; server must be stopped")
	}
	fmt.Fprintln(os.Stdout, "Serveur arrêté : tapez RESET pour révoquer toutes les sessions et clés API, sans modifier la configuration.")
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "RESET" {
		return errors.New("security reset canceled")
	}
	if _, err := os.Stat(databasePath); err != nil {
		return errors.New("owner database unavailable")
	}
	db, err := sqlite.Open(context.Background(), databasePath)
	if err != nil {
		return errors.New("cannot open owner database")
	}
	defer db.Close()
	if err := auth.NewAPIKeys(sqlite.NewAuthRepository(db)).ResetAccess(context.Background()); err != nil {
		return errors.New("security reset failed")
	}
	fmt.Fprintln(os.Stdout, "Sessions et clés révoquées. Corrigez les identifiants compromis avant de redémarrer.")
	return nil
}
