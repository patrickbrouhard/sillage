package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// PublisherRepository conserve les comptes partagés et leurs liens explicites.
type PublisherRepository struct{ db *sql.DB }

// NewPublisherRepository utilise une base déjà migrée.
func NewPublisherRepository(db *sql.DB) *PublisherRepository { return &PublisherRepository{db: db} }

var _ video.PublisherRepository = (*PublisherRepository)(nil)

// findOrCreatePublisher partage la transaction de l'import vidéo ou de la résolution manuelle.
// ON CONFLICT ne met à jour aucune métadonnée ni relation utilisateur.
func findOrCreatePublisher(ctx context.Context, tx *sql.Tx, p video.Publisher) (video.PublisherResult, error) {
	if strings.TrimSpace(p.Provider) == "" || strings.TrimSpace(p.ExternalID) == "" {
		return video.PublisherResult{}, video.ErrInvalidInput
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO publishers (provider, external_id, name)
		VALUES (?, ?, ?)
		ON CONFLICT (provider, external_id) DO NOTHING
	`, p.Provider, p.ExternalID, nullableText(p.Name))
	if err != nil {
		return video.PublisherResult{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return video.PublisherResult{}, err
	}
	var name sql.NullString
	var person sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT
			id,
			provider,
			external_id,
			name,
			person_id
		FROM publishers
		WHERE provider = ? AND external_id = ?
	`, p.Provider, p.ExternalID).Scan(&p.ID, &p.Provider, &p.ExternalID, &name, &person)
	if err != nil {
		return video.PublisherResult{}, err
	}
	p.Name = name.String
	p.PersonID = nil
	p.Tags = []video.Tag{}
	if person.Valid {
		id := video.PersonID(person.Int64)
		p.PersonID = &id
	}
	return video.PublisherResult{Publisher: p, Created: count == 1}, nil
}

// CreateOrFind réutilise le compte externe, sans rafraîchissement implicite.
func (r *PublisherRepository) CreateOrFind(ctx context.Context, p video.Publisher) (video.PublisherResult, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return video.PublisherResult{}, err
	}
	defer tx.Rollback()
	result, err := findOrCreatePublisher(ctx, tx, p)
	if err != nil {
		return video.PublisherResult{}, err
	}
	result.Publisher.Tags, err = readPublisherTags(ctx, tx, result.Publisher.ID)
	if err != nil {
		return video.PublisherResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return video.PublisherResult{}, err
	}
	return result, nil
}

// Get retourne le compte et ses tags propres.
func (r *PublisherRepository) Get(ctx context.Context, id video.PublisherID) (video.Publisher, error) {
	items, err := r.query(ctx, "p.id = ?", id)
	if err != nil {
		return video.Publisher{}, err
	}
	if len(items) == 0 {
		return video.Publisher{}, video.ErrPublisherNotFound
	}
	return items[0], nil
}

// List restitue les comptes dans l'ordre de leur identité interne.
func (r *PublisherRepository) List(ctx context.Context) ([]video.Publisher, error) {
	return r.query(ctx, "1 = 1")
}

// query regroupe les tags ordonnés sans requête supplémentaire par publisher.
// predicate ne provient que des méthodes internes de cet adapter.
func (r *PublisherRepository) query(ctx context.Context, predicate string, args ...any) ([]video.Publisher, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			p.id,
			p.provider,
			p.external_id,
			p.name,
			p.person_id,
			t.id,
			t.name
		FROM publishers p
		LEFT JOIN publisher_tags pt
			ON pt.publisher_id = p.id
		LEFT JOIN tags t
			ON t.id = pt.tag_id
		WHERE `+predicate+`
		ORDER BY
			p.id ASC,
			t.id ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []video.Publisher{}
	for rows.Next() {
		var p video.Publisher
		var name, tagName sql.NullString
		var person, tag sql.NullInt64
		if err := rows.Scan(&p.ID, &p.Provider, &p.ExternalID, &name, &person, &tag, &tagName); err != nil {
			return nil, err
		}
		if len(result) == 0 || result[len(result)-1].ID != p.ID {
			p.Name = name.String
			p.Tags = []video.Tag{}
			if person.Valid {
				id := video.PersonID(person.Int64)
				p.PersonID = &id
			}
			result = append(result, p)
		}
		if tag.Valid {
			p := &result[len(result)-1]
			p.Tags = append(p.Tags, video.Tag{ID: video.TagID(tag.Int64), Name: tagName.String})
		}
	}
	return result, rows.Err()
}

// requirePublisher vérifie l'existence sous le verrou de la transaction d'écriture.
func requirePublisher(ctx context.Context, tx *sql.Tx, id video.PublisherID) error {
	var found int64
	err := tx.QueryRowContext(ctx, "SELECT id FROM publishers WHERE id = ?", id).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return video.ErrPublisherNotFound
	}
	return err
}

// SetPerson remplace la référence sans modifier les personnes associées aux vidéos.
func (r *PublisherRepository) SetPerson(ctx context.Context, id video.PublisherID, person *video.PersonID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requirePublisher(ctx, tx, id); err != nil {
		return err
	}
	if person != nil {
		if err := requirePerson(ctx, tx, *person); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE publishers SET person_id = ? WHERE id = ?", person, id); err != nil {
		return err
	}
	return tx.Commit()
}

// SetSource contrôle l'appartenance à la vidéo et la cohérence des providers.
func (r *PublisherRepository) SetSource(ctx context.Context, id video.VideoID, source video.VideoSourceID, publisher *video.PublisherID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requireVideo(ctx, tx, id); err != nil {
		return err
	}
	var provider string
	err = tx.QueryRowContext(ctx, "SELECT provider FROM video_sources WHERE id = ? AND video_id = ?", source, id).Scan(&provider)
	if errors.Is(err, sql.ErrNoRows) {
		return video.ErrVideoSourceNotFound
	}
	if err != nil {
		return err
	}
	if publisher != nil {
		var accountProvider string
		err = tx.QueryRowContext(ctx, "SELECT provider FROM publishers WHERE id = ?", *publisher).Scan(&accountProvider)
		if errors.Is(err, sql.ErrNoRows) {
			return video.ErrPublisherNotFound
		}
		if err != nil {
			return err
		}
		if provider != accountProvider {
			return video.ErrInvalidInput
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE video_sources SET publisher_id = ? WHERE id = ?", publisher, source); err != nil {
		return err
	}
	return tx.Commit()
}

// Videos sélectionne par existence, sans multiplier les vidéos ayant plusieurs sources.
func (r *PublisherRepository) Videos(ctx context.Context, id video.PublisherID) ([]video.Video, error) {
	if _, err := r.Get(ctx, id); err != nil {
		return nil, err
	}
	return NewVideoRepository(r.db).query(ctx, `EXISTS (
		SELECT
			1
		FROM video_sources ps
		WHERE ps.video_id = v.id AND ps.publisher_id = ?
	)`, id)
}

// readPublisherTags restitue le lot complet avant de valider l'écriture atomique.
func readPublisherTags(ctx context.Context, tx *sql.Tx, id video.PublisherID) ([]video.Tag, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT
			t.id,
			t.name
		FROM tags t
		JOIN publisher_tags pt
			ON pt.tag_id = t.id
		WHERE pt.publisher_id = ?
		ORDER BY
			t.id ASC
	`, id)
	if err != nil {
		return nil, err
	}
	return readTags(rows)
}

// AddTags crée et associe le lot dans une seule transaction.
func (r *PublisherRepository) AddTags(ctx context.Context, id video.PublisherID, names []video.TagName) ([]video.Tag, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := requirePublisher(ctx, tx, id); err != nil {
		return nil, err
	}
	for _, name := range names {
		if err := insertTag(ctx, tx, name); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO publisher_tags (publisher_id, tag_id)
			SELECT
				?,
				id
			FROM tags
			WHERE identity_key = ?
			ON CONFLICT (publisher_id, tag_id) DO NOTHING
		`, id, name.Key); err != nil {
			return nil, err
		}
	}
	tags, err := readPublisherTags(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return tags, nil
}

// RemoveTag retire uniquement le lien, même si celui-ci est déjà absent.
func (r *PublisherRepository) RemoveTag(ctx context.Context, id video.PublisherID, tag video.TagID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requirePublisher(ctx, tx, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM publisher_tags WHERE publisher_id = ? AND tag_id = ?", id, tag); err != nil {
		return err
	}
	return tx.Commit()
}

// insertTag conserve la première graphie et partage la contrainte d'identité Unicode.
func insertTag(ctx context.Context, tx *sql.Tx, name video.TagName) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO tags (name, identity_key)
		VALUES (?, ?)
		ON CONFLICT (identity_key) DO NOTHING
	`, name.Name, name.Key)
	return err
}
