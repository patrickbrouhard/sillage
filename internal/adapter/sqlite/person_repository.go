package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// PersonRepository conserve les personnes indépendamment des comptes externes.
type PersonRepository struct{ db *sql.DB }

// NewPersonRepository utilise la base migrée fournie.
func NewPersonRepository(db *sql.DB) *PersonRepository { return &PersonRepository{db: db} }

var _ video.PersonRepository = (*PersonRepository)(nil)

// Create crée systématiquement une identité distincte, même pour un homonyme.
func (r *PersonRepository) Create(ctx context.Context, name string) (video.Person, error) {
	result, err := r.db.ExecContext(ctx, "INSERT INTO persons (name) VALUES (?)", name)
	if err != nil {
		return video.Person{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return video.Person{}, err
	}
	return video.Person{ID: video.PersonID(id), Name: name, Tags: []video.Tag{}}, nil
}

// Rename préserve l'identité et les associations lors d'une correction de nom.
func (r *PersonRepository) Rename(ctx context.Context, id video.PersonID, name string) (video.Person, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return video.Person{}, err
	}
	defer tx.Rollback()
	if err := requirePerson(ctx, tx, id); err != nil {
		return video.Person{}, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE persons SET name = ? WHERE id = ?", name, id); err != nil {
		return video.Person{}, err
	}
	tags, err := readPersonTags(ctx, tx, id)
	if err != nil {
		return video.Person{}, err
	}
	if err := tx.Commit(); err != nil {
		return video.Person{}, err
	}
	return video.Person{ID: id, Name: name, Tags: tags}, nil
}

// Get restitue une personne et ses tags directs.
func (r *PersonRepository) Get(ctx context.Context, id video.PersonID) (video.Person, error) {
	items, err := r.query(ctx, "p.id = ?", id)
	if err != nil {
		return video.Person{}, err
	}
	if len(items) == 0 {
		return video.Person{}, video.ErrPersonNotFound
	}
	return items[0], nil
}

// List inclut les personnes sans aucune association.
func (r *PersonRepository) List(ctx context.Context) ([]video.Person, error) {
	return r.query(ctx, "1 = 1")
}

// query regroupe les tags contigus dans l'ordre des identifiants internes.
func (r *PersonRepository) query(ctx context.Context, predicate string, args ...any) ([]video.Person, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			p.id,
			p.name,
			t.id,
			t.name
		FROM persons p
		LEFT JOIN person_tags pt
			ON pt.person_id = p.id
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
	result := []video.Person{}
	for rows.Next() {
		var p video.Person
		var tag sql.NullInt64
		var name sql.NullString
		if err := rows.Scan(&p.ID, &p.Name, &tag, &name); err != nil {
			return nil, err
		}
		if len(result) == 0 || result[len(result)-1].ID != p.ID {
			p.Tags = []video.Tag{}
			result = append(result, p)
		}
		if tag.Valid {
			p := &result[len(result)-1]
			p.Tags = append(p.Tags, video.Tag{ID: video.TagID(tag.Int64), Name: name.String})
		}
	}
	return result, rows.Err()
}

// requirePerson vérifie l'existence dans la transaction qui modifiera les liens.
func requirePerson(ctx context.Context, tx *sql.Tx, id video.PersonID) error {
	var found int64
	err := tx.QueryRowContext(ctx, "SELECT id FROM persons WHERE id = ?", id).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return video.ErrPersonNotFound
	}
	return err
}

// SetVideo modifie uniquement l'association explicite, sans rôle ni héritage.
func (r *PersonRepository) SetVideo(ctx context.Context, id video.VideoID, person video.PersonID, present bool) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requireVideo(ctx, tx, id); err != nil {
		return err
	}
	if err := requirePerson(ctx, tx, person); err != nil {
		return err
	}
	if present {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO video_persons (video_id, person_id)
			VALUES (?, ?)
			ON CONFLICT (video_id, person_id) DO NOTHING
		`, id, person)
	} else {
		_, err = tx.ExecContext(ctx, "DELETE FROM video_persons WHERE video_id = ? AND person_id = ?", id, person)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Publishers retrouve les comptes de référence sans inférer de propriété.
func (r *PersonRepository) Publishers(ctx context.Context, id video.PersonID) ([]video.Publisher, error) {
	if _, err := r.Get(ctx, id); err != nil {
		return nil, err
	}
	return NewPublisherRepository(r.db).query(ctx, "p.person_id = ?", id)
}

// Videos utilise EXISTS pour dédupliquer l'union des chemins direct et indirect.
func (r *PersonRepository) Videos(ctx context.Context, id video.PersonID, relation string) ([]video.Video, error) {
	if _, err := r.Get(ctx, id); err != nil {
		return nil, err
	}
	direct := `EXISTS (
		SELECT
			1
		FROM video_persons vp
		WHERE vp.video_id = v.id AND vp.person_id = ?
	)`
	indirect := `EXISTS (
		SELECT
			1
		FROM video_sources ps
		JOIN publishers p
			ON p.id = ps.publisher_id
		WHERE ps.video_id = v.id AND p.person_id = ?
	)`
	switch relation {
	case "direct":
		return NewVideoRepository(r.db).query(ctx, direct, id)
	case "publisher":
		return NewVideoRepository(r.db).query(ctx, indirect, id)
	case "all":
		return NewVideoRepository(r.db).query(ctx, "("+direct+" OR "+indirect+")", id, id)
	default:
		return nil, video.ErrInvalidInput
	}
}

// readPersonTags fournit le résultat complet dans la transaction d'ajout.
func readPersonTags(ctx context.Context, tx *sql.Tx, id video.PersonID) ([]video.Tag, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT
			t.id,
			t.name
		FROM tags t
		JOIN person_tags pt
			ON pt.tag_id = t.id
		WHERE pt.person_id = ?
		ORDER BY
			t.id ASC
	`, id)
	if err != nil {
		return nil, err
	}
	return readTags(rows)
}

// AddTags garantit le rollback des créations et des associations du lot entier.
func (r *PersonRepository) AddTags(ctx context.Context, id video.PersonID, names []video.TagName) ([]video.Tag, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := requirePerson(ctx, tx, id); err != nil {
		return nil, err
	}
	for _, name := range names {
		if err := insertTag(ctx, tx, name); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO person_tags (person_id, tag_id)
			SELECT
				?,
				id
			FROM tags
			WHERE identity_key = ?
			ON CONFLICT (person_id, tag_id) DO NOTHING
		`, id, name.Key); err != nil {
			return nil, err
		}
	}
	tags, err := readPersonTags(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return tags, nil
}

// RemoveTag ne supprime jamais le tag partagé.
func (r *PersonRepository) RemoveTag(ctx context.Context, id video.PersonID, tag video.TagID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requirePerson(ctx, tx, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM person_tags WHERE person_id = ? AND tag_id = ?", id, tag); err != nil {
		return err
	}
	return tx.Commit()
}
