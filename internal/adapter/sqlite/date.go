package sqlite

import (
	"fmt"
	"time"
)

// dateLayout garde une largeur fixe pour que l'ordre lexical soit chronologique.
const dateLayout = "2006-01-02T15:04:05.000Z"

func formatDate(value time.Time) string {
	return value.UTC().Format(dateLayout)
}

// parseDate refuse aussi les représentations non canoniques acceptées par time.Parse.
func parseDate(value string) (time.Time, error) {
	date, err := time.Parse(dateLayout, value)
	if err != nil {
		return time.Time{}, err
	}
	if formatDate(date) != value {
		return time.Time{}, fmt.Errorf("non-canonical date %q", value)
	}
	return date, nil
}
