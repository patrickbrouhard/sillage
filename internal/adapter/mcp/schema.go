package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/patrickbrouhard/sillage/internal/search"
)

// constrainOutput complète les contraintes que l'inférence Go ne décrit pas.
// Les références restent celles du SDK ; seuls les mots-clés métier sont ajoutés.
func constrainOutput(schema *jsonschema.Schema) {
	for name, property := range schema.Properties {
		switch name {
		case "id", "video_id", "source_id", "transcript_id", "person_id":
			property.Minimum = ptr(1.0)
		case "person_ids":
			property.Items.Minimum = ptr(1.0)
		case "start_ms", "duration_ms", "total":
			property.Minimum = ptr(0.0)
		case "revision":
			property.Minimum = ptr(1.0)
		case "page":
			property.Minimum = ptr(1.0)
			property.Maximum = ptr(float64(search.MaxPage))
		case "results":
			property.MaxItems = ptr(search.PageSize)
		case "created_at", "updated_at", "last_fetched_at":
			property.Description = "UTC calendar timestamp in RFC 3339 format, ending with Z."
			property.Format = "date-time"
			property.Pattern = `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$`
		}
		constrainOutput(property)
	}
	for _, definition := range schema.Defs {
		constrainOutput(definition)
	}
	for _, branch := range schema.AnyOf {
		constrainOutput(branch)
	}
	if schema.Items != nil {
		constrainOutput(schema.Items)
	}
	if format := schema.Properties["format"]; format != nil {
		format.Enum = []any{"text", "timed"}
		schema.Properties["complete"].Const = ptr[any](true)
		text := schema.Properties["text"]
		text.Type, text.Types = "string", nil
		fragments := schema.Properties["fragments"]
		fragments.Type, fragments.Types = "array", nil
		schema.OneOf = []*jsonschema.Schema{
			{
				Properties: map[string]*jsonschema.Schema{"format": {Const: ptr[any]("text")}},
				Required:   []string{"text"},
				Not:        &jsonschema.Schema{Required: []string{"fragments"}},
			},
			{
				Properties: map[string]*jsonschema.Schema{"format": {Const: ptr[any]("timed")}},
				Required:   []string{"fragments"},
				Not:        &jsonschema.Schema{Required: []string{"text"}},
			},
		}
	}
}

// validateOutput contrôle le JSON réellement publié en conservant les entiers int64.
// jsonschema-go v0.4.3 reconnaît json.Number comme chaîne pour type : convertir
// explicitement les seuls nombres autorisés par nos DTO évite tout passage float64.
func validateOutput(data []byte, schema *jsonschema.Resolved) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	value, err := exactIntegersAndDates(value)
	if err != nil {
		return err
	}
	return schema.Validate(value)
}

// exactIntegersAndDates ne transforme que la vue de validation, jamais le JSON retourné.
// Format est une annotation pour cette version du validateur : vérifier aussi le calendrier.
func exactIntegersAndDates(value any) (any, error) {
	switch v := value.(type) {
	case json.Number:
		return v.Int64()
	case map[string]any:
		for name, item := range v {
			switch name {
			case "created_at", "updated_at", "last_fetched_at":
				if text, ok := item.(string); ok {
					if _, err := time.Parse(time.RFC3339Nano, text); err != nil || !strings.HasSuffix(text, "Z") {
						return nil, fmt.Errorf("invalid UTC date")
					}
				}
			}
			converted, err := exactIntegersAndDates(item)
			if err != nil {
				return nil, err
			}
			v[name] = converted
		}
	case []any:
		for i, item := range v {
			converted, err := exactIntegersAndDates(item)
			if err != nil {
				return nil, err
			}
			v[i] = converted
		}
	}
	return value, nil
}
