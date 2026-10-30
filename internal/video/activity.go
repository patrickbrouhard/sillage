package video

import (
	"errors"
	"sync"
)

// ErrBusy indique qu'une opération incompatible réserve déjà la vidéo.
var ErrBusy = errors.New("video busy")

// Activity coordonne les usages et la suppression par vidéo, sans attente ni file.
// Une seule instance est partagée par les services utilisant le même stockage.
type Activity struct {
	mu    sync.Mutex
	users map[VideoID]int
}

// Use réserve un usage jusqu'à sa fin effective, avant toute lecture du parent.
// Une valeur nil conserve la compatibilité des assemblages sans suppression.
func (a *Activity) Use(id VideoID) (func(), error) { return a.reserve(id, false) }

// Delete réserve exclusivement une vidéo ; un usage actif provoque un refus immédiat.
func (a *Activity) Delete(id VideoID) (func(), error) { return a.reserve(id, true) }

func (a *Activity) reserve(id VideoID, exclusive bool) (func(), error) {
	if a == nil {
		return func() {}, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.users[id] < 0 || (exclusive && a.users[id] != 0) {
		return nil, ErrBusy
	}
	if a.users == nil {
		a.users = make(map[VideoID]int)
	}
	if exclusive {
		a.users[id] = -1
	} else {
		a.users[id]++
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			if exclusive || a.users[id] == 1 {
				delete(a.users, id)
			} else {
				a.users[id]--
			}
		})
	}, nil
}
