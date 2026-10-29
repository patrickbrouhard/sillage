package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
	"golang.org/x/term"
)

// runOwner réserve l'administration à un terminal local ; aucun secret n'est accepté en argument.
func runOwner(args []string) error {
	if len(args) != 1 || (args[0] != "init" && args[0] != "recover" && args[0] != "release" && args[0] != "recover-auth") {
		return errors.New("usage: sillage owner init|recover|release|recover-auth (server must be stopped)")
	}
	desired, err := loadProvisioningEnv()
	if err != nil {
		return err
	}
	if desired != nil && (desired.Mode == "managed" || (args[0] == "recover-auth" && desired.Authentication != nil)) {
		return auth.ErrManaged
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("owner administration requires an interactive terminal")
	}
	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		return errors.New("cannot prepare data directory")
	}
	db, err := sqlite.Open(context.Background(), databasePath)
	if err != nil {
		return errors.New("cannot open owner database")
	}
	defer db.Close()
	service := auth.NewService(sqlite.NewAuthRepository(db), 0, 0)
	return administerOwner(context.Background(), service, args[0], func(prompt string, secret bool) (string, error) {
		fmt.Fprint(os.Stdout, prompt)
		if secret {
			data, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stdout)
			defer clear(data)
			return string(data), err
		}
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		return strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), err
	}, os.Stdout)
}

// administerOwner partage les contrôles entre le terminal réel et les tests déterministes.
func administerOwner(ctx context.Context, service *auth.Service, action string, read func(string, bool) (string, error), output io.Writer) error {
	ready := service.Ready(ctx)
	if action == "init" && ready == nil {
		return auth.ErrExists
	}
	if action == "init" && !errors.Is(ready, auth.ErrUninitialized) {
		return ready
	}
	if (action == "recover" || action == "release" || action == "recover-auth") && ready != nil {
		return ready
	}
	if action == "release" {
		confirmation, err := read("Retirez la déclaration managed, serveur arrêté. Tapez RELEASE pour rendre l'administration locale : ", false)
		if err != nil || confirmation != "RELEASE" {
			return errors.New("authority release canceled")
		}
		if err := service.Release(ctx); err != nil {
			return err
		}
		fmt.Fprintln(output, "Administration locale disponible ; un changement d'autorité révoque les sessions. Utilisez owner recover si nécessaire.")
		return nil
	}
	if action == "recover" || action == "recover-auth" {
		if err := service.LocalAdministration(ctx); err != nil {
			return err
		}
	}
	username := ""
	var err error
	if action == "init" {
		username, err = read("Identifiant du propriétaire : ", false)
		if err != nil {
			return errors.New("input interrupted")
		}
	}
	password, err := read("Nouveau mot de passe (15 caractères minimum) : ", true)
	if err != nil {
		return errors.New("input interrupted")
	}
	confirmation, err := read("Confirmez le mot de passe : ", true)
	if err != nil {
		return errors.New("input interrupted")
	}
	if password != confirmation {
		return errors.New("passwords do not match")
	}
	if action == "recover-auth" {
		err = service.RecoverAuthentication(ctx, password)
	} else if action == "init" {
		err = service.Initialize(ctx, username, password)
	} else {
		err = service.Recover(ctx, password)
	}
	if err != nil {
		return err
	}
	fmt.Fprintln(output, "Propriétaire configuré. Les anciennes sessions sont révoquées après récupération.")
	return nil
}
