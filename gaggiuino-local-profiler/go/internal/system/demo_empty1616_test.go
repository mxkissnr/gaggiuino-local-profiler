package system

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestDemoService_IsEmpty_CountsTrashedShots pins that a history holding
// only trashed shots is still real data: IsEmpty has always counted every
// shot row, trash included, so demo seeding never lands on top of it.
func TestDemoService_IsEmpty_CountsTrashedShots(t *testing.T) {
	sqlDB := newTestDB(t)
	shotsRepo := shots.NewRepository(sqlDB)
	demo := NewDemoService(sqlDB, shotsRepo, library.NewRepository(sqlDB))

	if err := shotsRepo.Upsert(shots.Shot{"id": int64(7), "timestamp": int64(1000)}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := shotsRepo.MoveToTrash(7); err != nil {
		t.Fatalf("MoveToTrash: %v", err)
	}
	empty, err := demo.IsEmpty()
	if err != nil {
		t.Fatalf("IsEmpty: %v", err)
	}
	if empty {
		t.Fatal("expected IsEmpty=false while a trashed shot exists")
	}
}
