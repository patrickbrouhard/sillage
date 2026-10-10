package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// PublisherService expose les comptes et leurs relations sans dépendance aux adapters.
type PublisherService interface {
	// Resolve distingue création et réutilisation sans rafraîchissement.
	Resolve(context.Context, string) (video.PublisherResult, error)
	// Get restitue le compte avec ses tags propres.
	Get(context.Context, video.PublisherID) (video.Publisher, error)
	// List inclut les comptes sans source, par ID croissant.
	List(context.Context) ([]video.Publisher, error)
	// SetPerson remplace ou retire la personne de référence.
	SetPerson(context.Context, video.PublisherID, *video.PersonID) error
	// SetSource vérifie l'appartenance et la cohérence des providers.
	SetSource(context.Context, video.VideoID, video.VideoSourceID, *video.PublisherID) error
	// Videos restitue des vidéos complètes sans doublons.
	Videos(context.Context, video.PublisherID) ([]video.Video, error)
	// AddTags ajoute atomiquement un lot au catalogue et au compte.
	AddTags(context.Context, video.PublisherID, []string) ([]video.Tag, error)
	// RemoveTag conserve le tag partagé après retrait du lien.
	RemoveTag(context.Context, video.PublisherID, video.TagID) error
}

// PersonService expose les personnes et les deux chemins de navigation vidéo.
type PersonService interface {
	// Create conserve des identités distinctes pour les homonymes.
	Create(context.Context, string) (video.Person, error)
	// Rename préserve l'identité et les associations.
	Rename(context.Context, video.PersonID, string) (video.Person, error)
	// Get restitue une personne et ses tags directs.
	Get(context.Context, video.PersonID) (video.Person, error)
	// List inclut les personnes sans liens, par ID croissant.
	List(context.Context) ([]video.Person, error)
	// SetVideo modifie uniquement le lien explicite au contenu.
	SetVideo(context.Context, video.VideoID, video.PersonID, bool) error
	// Publishers retrouve les comptes de référence de la personne.
	Publishers(context.Context, video.PersonID) ([]video.Publisher, error)
	// Videos distingue les relations directes, indirectes et leur union.
	Videos(context.Context, video.PersonID, string) ([]video.Video, error)
	// AddTags garantit l'atomicité du lot sans propagation.
	AddTags(context.Context, video.PersonID, []string) ([]video.Tag, error)
	// RemoveTag retire uniquement le lien à la personne.
	RemoveTag(context.Context, video.PersonID, video.TagID) error
}

// PeopleHandler traduit les opérations sur personnes et comptes de publication.
type PeopleHandler struct {
	publishers  PublisherService
	persons     PersonService
	postTimeout time.Duration
}

// NewPeopleHandler assemble les services métier et borne la résolution distante.
func NewPeopleHandler(publishers PublisherService, persons PersonService, timeout time.Duration) *PeopleHandler {
	return &PeopleHandler{publishers: publishers, persons: persons, postTimeout: timeout}
}

type publisherResponse struct {
	ID         video.PublisherID `json:"id"`
	Provider   string            `json:"provider"`
	ExternalID string            `json:"external_id"`
	Name       *string           `json:"name"`
	PersonID   *video.PersonID   `json:"person_id"`
	Tags       []tagResponse     `json:"tags"`
}

type personResponse struct {
	ID   video.PersonID `json:"id"`
	Name string         `json:"name"`
	Tags []tagResponse  `json:"tags"`
}

func toPublisherResponse(p video.Publisher) publisherResponse {
	return publisherResponse{ID: p.ID, Provider: p.Provider, ExternalID: p.ExternalID, Name: optionalText(p.Name), PersonID: p.PersonID, Tags: toTagResponses(p.Tags)}
}

func toPersonResponse(p video.Person) personResponse {
	return personResponse{ID: p.ID, Name: p.Name, Tags: toTagResponses(p.Tags)}
}

// ResolvePublisher crée ou retrouve un compte à partir d'une URL de chaîne.
func (h *PeopleHandler) ResolvePublisher(w http.ResponseWriter, r *http.Request) {
	var input struct {
		URL string `json:"url"`
	}
	if !readKnowledgeJSON(w, r, 16<<10, &input) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.postTimeout)
	defer cancel()
	result, err := h.publishers.Resolve(ctx, input.URL)
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
		w.Header().Set("Location", "/api/v1/publishers/"+strconv.FormatInt(int64(result.Publisher.ID), 10))
	}
	writeJSON(w, status, toPublisherResponse(result.Publisher))
}

// ListPublishers restitue le catalogue local, y compris les comptes sans vidéos.
func (h *PeopleHandler) ListPublishers(w http.ResponseWriter, r *http.Request) {
	items, err := h.publishers.List(r.Context())
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writePublishers(w, items)
}

func writePublishers(w http.ResponseWriter, items []video.Publisher) {
	result := make([]publisherResponse, 0, len(items))
	for _, p := range items {
		result = append(result, toPublisherResponse(p))
	}
	writeJSON(w, 200, struct {
		Publishers []publisherResponse `json:"publishers"`
	}{result})
}

// GetPublisher relit un compte sans contacter la plateforme.
func (h *PeopleHandler) GetPublisher(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	p, err := h.publishers.Get(r.Context(), video.PublisherID(id))
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writeJSON(w, 200, toPublisherResponse(p))
}

// CreatePerson conserve des identités distinctes pour les homonymes.
func (h *PeopleHandler) CreatePerson(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if !readKnowledgeJSON(w, r, 16<<10, &input) {
		return
	}
	p, err := h.persons.Create(r.Context(), input.Name)
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/v1/persons/"+strconv.FormatInt(int64(p.ID), 10))
	writeJSON(w, 201, toPersonResponse(p))
}

// RenamePerson adapte une correction de nom sans modifier les liens.
func (h *PeopleHandler) RenamePerson(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if !readKnowledgeJSON(w, r, 16<<10, &input) {
		return
	}
	p, err := h.persons.Rename(r.Context(), video.PersonID(id), input.Name)
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writeJSON(w, 200, toPersonResponse(p))
}

// ListPersons inclut les personnes sans compte ni vidéo.
func (h *PeopleHandler) ListPersons(w http.ResponseWriter, r *http.Request) {
	items, err := h.persons.List(r.Context())
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	result := make([]personResponse, 0, len(items))
	for _, p := range items {
		result = append(result, toPersonResponse(p))
	}
	writeJSON(w, 200, struct {
		Persons []personResponse `json:"persons"`
	}{result})
}

// GetPerson retourne une personne et ses tags directs.
func (h *PeopleHandler) GetPerson(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	p, err := h.persons.Get(r.Context(), video.PersonID(id))
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writeJSON(w, 200, toPersonResponse(p))
}

// nullableID distingue un champ absent d'un retrait explicite par null.
func nullableID(w http.ResponseWriter, raw json.RawMessage) (*int64, bool) {
	if len(raw) == 0 {
		writeError(w, 400, "bad_request", "association field is required")
		return nil, false
	}
	var id *int64
	if err := json.Unmarshal(raw, &id); err != nil || (id != nil && *id <= 0) {
		writeError(w, 400, "bad_request", "invalid association id")
		return nil, false
	}
	return id, true
}

// emptyBody refuse un contenu ignoré sur les opérations entièrement décrites par l'URL.
func emptyBody(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1))
	if err != nil || len(body) != 0 {
		writeError(w, 400, "bad_request", "request body must be empty")
		return false
	}
	return true
}

// SetPublisherPerson remplace ou retire explicitement la personne de référence.
func (h *PeopleHandler) SetPublisherPerson(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		PersonID json.RawMessage `json:"person_id"`
	}
	if !readKnowledgeJSON(w, r, 16<<10, &input) {
		return
	}
	value, ok := nullableID(w, input.PersonID)
	if !ok {
		return
	}
	var person *video.PersonID
	if value != nil {
		id := video.PersonID(*value)
		person = &id
	}
	if err := h.publishers.SetPerson(r.Context(), video.PublisherID(id), person); err != nil {
		respondPeopleError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

// SetSourcePublisher ne modifie que la source désignée de la vidéo.
func (h *PeopleHandler) SetSourcePublisher(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "video_id")
	if !ok {
		return
	}
	source, ok := knowledgeID(w, r, "source_id")
	if !ok {
		return
	}
	var input struct {
		PublisherID json.RawMessage `json:"publisher_id"`
	}
	if !readKnowledgeJSON(w, r, 16<<10, &input) {
		return
	}
	value, ok := nullableID(w, input.PublisherID)
	if !ok {
		return
	}
	var publisher *video.PublisherID
	if value != nil {
		id := video.PublisherID(*value)
		publisher = &id
	}
	if err := h.publishers.SetSource(r.Context(), video.VideoID(id), video.VideoSourceID(source), publisher); err != nil {
		respondPeopleError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

// SetVideoPerson traduit PUT et DELETE en ajout ou retrait idempotent du lien.
func (h *PeopleHandler) SetVideoPerson(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "video_id")
	if !ok {
		return
	}
	person, ok := knowledgeID(w, r, "person_id")
	if !ok {
		return
	}
	if !emptyBody(w, r) {
		return
	}
	if err := h.persons.SetVideo(r.Context(), video.VideoID(id), video.PersonID(person), r.Method == http.MethodPut); err != nil {
		respondPeopleError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

// PublisherVideos conserve la représentation complète de chaque vidéo sélectionnée.
func (h *PeopleHandler) PublisherVideos(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	items, err := h.publishers.Videos(r.Context(), video.PublisherID(id))
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writeVideos(w, items)
}

// PersonPublishers expose les comptes dont la personne est la référence.
func (h *PeopleHandler) PersonPublishers(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	items, err := h.persons.Publishers(r.Context(), video.PersonID(id))
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writePublishers(w, items)
}

// PersonVideos valide un seul mode de navigation, sans fusionner les associations.
func (h *PeopleHandler) PersonVideos(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, 400, "bad_request", "invalid query")
		return
	}
	relation := "all"
	if values, present := query["relation"]; present {
		if len(values) != 1 {
			writeError(w, 400, "bad_request", "invalid relation")
			return
		}
		relation = values[0]
	}
	items, err := h.persons.Videos(r.Context(), video.PersonID(id), relation)
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writeVideos(w, items)
}

func writeVideos(w http.ResponseWriter, items []video.Video) {
	result := videoListResponse{Videos: make([]videoResponse, 0, len(items))}
	for _, v := range items {
		result.Videos = append(result.Videos, toVideoResponse(v))
	}
	writeJSON(w, 200, result)
}

// AddPublisherTags conserve les conventions de l'ajout additif sur les vidéos.
func (h *PeopleHandler) AddPublisherTags(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Names []string `json:"names"`
	}
	if !readKnowledgeJSON(w, r, 64<<10, &input) {
		return
	}
	tags, err := h.publishers.AddTags(r.Context(), video.PublisherID(id), input.Names)
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writeJSON(w, 200, tagsResponse{Tags: toTagResponses(tags)})
}

// AddPersonTags ne propage aucun tag aux comptes ou vidéos associés.
func (h *PeopleHandler) AddPersonTags(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Names []string `json:"names"`
	}
	if !readKnowledgeJSON(w, r, 64<<10, &input) {
		return
	}
	tags, err := h.persons.AddTags(r.Context(), video.PersonID(id), input.Names)
	if err != nil {
		respondPeopleError(w, r, err)
		return
	}
	writeJSON(w, 200, tagsResponse{Tags: toTagResponses(tags)})
}

// RemovePublisherTag retire une association, jamais une entrée du catalogue.
func (h *PeopleHandler) RemovePublisherTag(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	tag, ok := knowledgeID(w, r, "tag_id")
	if !ok {
		return
	}
	if err := h.publishers.RemoveTag(r.Context(), video.PublisherID(id), video.TagID(tag)); err != nil {
		respondPeopleError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

// RemovePersonTag conserve les tags devenus inutilisés.
func (h *PeopleHandler) RemovePersonTag(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	tag, ok := knowledgeID(w, r, "tag_id")
	if !ok {
		return
	}
	if err := h.persons.RemoveTag(r.Context(), video.PersonID(id), video.TagID(tag)); err != nil {
		respondPeopleError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

// respondPeopleError traduit les erreurs stables et délègue les échecs d'acquisition.
func respondPeopleError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(r.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case errors.Is(err, video.ErrPublisherNotFound):
		writeError(w, 404, "publisher_not_found", "publisher not found")
	case errors.Is(err, video.ErrPersonNotFound):
		writeError(w, 404, "person_not_found", "person not found")
	case errors.Is(err, video.ErrVideoSourceNotFound):
		writeError(w, 404, "video_source_not_found", "video source not found")
	case errors.Is(err, video.ErrInvalidInput):
		writeError(w, 400, "bad_request", "invalid request")
	default:
		respondError(w, r, err)
	}
}
