package system

import (
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestDemoService_IsEmpty_RejectsRealShots ports isEmpty()'s "refuses to
// seed on top of real data" guard for the shots half of the check.
func TestDemoService_IsEmpty_RejectsRealShots(t *testing.T) {
	sqlDB := newTestDB(t)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	demo := NewDemoService(sqlDB, shotsRepo, libRepo)

	empty, err := demo.IsEmpty()
	if err != nil {
		t.Fatalf("IsEmpty: %v", err)
	}
	if !empty {
		t.Fatal("expected a fresh DB to be empty")
	}

	if err := shotsRepo.Upsert(shots.Shot{"id": int64(1), "timestamp": int64(1000), "duration": int64(280)}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	empty, err = demo.IsEmpty()
	if err != nil {
		t.Fatalf("IsEmpty: %v", err)
	}
	if empty {
		t.Fatal("expected IsEmpty=false once a real shot exists")
	}
}

// TestDemoService_IsEmpty_RejectsRealBeans mirrors the above for the
// library half of the check.
func TestDemoService_IsEmpty_RejectsRealBeans(t *testing.T) {
	sqlDB := newTestDB(t)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	demo := NewDemoService(sqlDB, shotsRepo, libRepo)

	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Beans = append(lib.Beans, library.Entity{"id": int64(1), "name": "Real Bean"})
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	empty, err := demo.IsEmpty()
	if err != nil {
		t.Fatalf("IsEmpty: %v", err)
	}
	if empty {
		t.Fatal("expected IsEmpty=false once a real bean exists")
	}
}

// TestBuildDemoDataset_Shape sanity-checks buildDemoDataset's output
// against the fixed SHOT_DEFS/beans/recipes counts and id-namespacing
// invariant (#456's high id range, never colliding with a real machine's
// own sequential ids).
func TestBuildDemoDataset_Shape(t *testing.T) {
	now := time.Now().UnixMilli()
	shotsDS, beans, recipes := buildDemoDataset(now)

	if len(shotsDS) != len(demoShotDefs) {
		t.Fatalf("got %d shots, want %d", len(shotsDS), len(demoShotDefs))
	}
	if len(beans) != 3 {
		t.Fatalf("got %d beans, want 3", len(beans))
	}
	if len(recipes) != 1 {
		t.Fatalf("got %d recipes, want 1", len(recipes))
	}

	for _, s := range shotsDS {
		id, ok := s["id"].(int64)
		if !ok || id < demoIDBase {
			t.Errorf("shot id %v not in the demo id range (>= %d)", s["id"], demoIDBase)
		}
		ann, ok := s["annotation"].(map[string]any)
		if !ok {
			t.Fatalf("shot %v missing annotation map", s["id"])
		}
		if ann["coffee"] == "" || ann["coffee"] == nil {
			t.Errorf("shot %v annotation missing coffee", s["id"])
		}
	}

	for _, b := range beans {
		id, ok := b["id"].(int64)
		if !ok || id < demoIDBase {
			t.Errorf("bean id %v not in the demo id range", b["id"])
		}
	}
}
