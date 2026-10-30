package video

import (
	"errors"
	"sync"
	"testing"
)

func TestActivityExcludesDeletionWithoutBlockingOtherVideos(t *testing.T) {
	activity := &Activity{}
	first, _ := activity.Use(1)
	second, _ := activity.Use(1)
	first()
	if _, err := activity.Delete(1); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
	second()
	exclusive, err := activity.Delete(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := activity.Use(1); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
	other, err := activity.Use(2)
	if err != nil {
		t.Fatal(err)
	}
	other()
	exclusive()
	exclusive()
	var workers sync.WaitGroup
	for range 20 {
		workers.Go(func() {
			for range 100 {
				release, err := activity.Use(1)
				if err == nil {
					release()
				}
				release, err = activity.Delete(1)
				if err == nil {
					release()
				}
			}
		})
	}
	workers.Wait()
	release, err := activity.Delete(1)
	if err != nil {
		t.Fatal(err)
	}
	release()
	if len(activity.users) != 0 {
		t.Fatal(activity.users)
	}
}
