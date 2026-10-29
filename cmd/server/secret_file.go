package main

import (
	"errors"
	"io"
	"os"
)

// readPasswordFile lit les octets exacts du secret sans exposer son chemin dans les erreurs.
// Les liens symboliques sont admis pour les montages de secrets ; leur cible doit être un fichier régulier.
func readPasswordFile(path string) (string, error) {
	// Refuser les fichiers spéciaux avant ouverture évite notamment d'attendre sur un FIFO.
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("password secret must be a readable regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("cannot read password secret file")
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("password secret must be a regular file")
	}
	// La borne inclut un octet témoin pour refuser une entrée trop longue sans la charger.
	data, err := io.ReadAll(io.LimitReader(file, 1025))
	defer clear(data)
	if err != nil || len(data) == 0 || len(data) > 1024 {
		return "", errors.New("password secret file must contain 1 to 1024 bytes")
	}
	return string(data), nil
}
