package library

import (
	"fmt"
	"sync"
	"testing"
)

// TestCreateAndUpdate_ConcurrentWritersLoseNothing is the create/update half
// of the #1199 regression coverage, alongside slice 1's Update tests: 20
// concurrent CreateGrinder calls race 20 concurrent UpdateBean calls on the
// same seeded bean. Under the old unguarded GetLibrary/SaveLibrary cycle each
// writer saved the whole blob it had read, so concurrent creates overwrote one
// another and an UpdateBean save could flush a freshly created grinder.
// Routed through Repository.Update every write is serialised, so exactly 20
// grinders survive and the bean's notes update lands.
func TestCreateAndUpdate_ConcurrentWritersLoseNothing(t *testing.T) {
	_, repo, _ := newTestHandlers(t)

	if err := repo.Update(func(lib *Library) error {
		lib.Beans = append(lib.Beans, Entity{"id": int64(1), "name": "Seeded Bean", "notes": "before"})
		return nil
	}); err != nil {
		t.Fatalf("seeding bean: %v", err)
	}

	const creates = 20
	const updates = 20
	var wg sync.WaitGroup
	errs := make(chan error, creates+updates)
	for i := 0; i < creates; i++ {
		name := fmt.Sprintf("Grinder %d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := CreateGrinder(repo, Entity{"name": name}); err != nil {
				errs <- err
			}
		}()
	}
	for i := 0; i < updates; i++ {
		note := fmt.Sprintf("note %d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, found, err := UpdateBean(repo, 1, Entity{"notes": note}); err != nil {
				errs <- err
			} else if !found {
				errs <- fmt.Errorf("bean not found")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent writer: %v", err)
	}

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Grinders) != creates {
		t.Fatalf("grinders = %d, want %d (lost creates)", len(lib.Grinders), creates)
	}
	if len(lib.Beans) != 1 {
		t.Fatalf("beans = %d, want 1", len(lib.Beans))
	}
	if notes, _ := lib.Beans[0]["notes"].(string); notes == "before" {
		t.Fatalf("bean notes = %q — the concurrent UpdateBean calls were lost", notes)
	}
}
