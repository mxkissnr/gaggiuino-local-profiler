package system

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// systemBackfillLogs is the shared log wording the direct backfillShots tests
// pass, matching sync_backfill_test.go.
var systemBackfillLogs = backfillLogs{prefix: "system: sync", notFoundSuffix: " on machine", invalidReason: "has invalid data"}

// TestBackfillShots_NewestShotNotFoundIsRetried is the #1197 regression: a
// machine that reports its newest id a moment before that shot is readable
// must not have it blocklisted forever. The first run skips it without a
// blocklist entry; a later run that can read it imports it.
func TestBackfillShots_NewestShotNotFoundIsRetried(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	notFound := func(_ context.Context, native int64) (map[string]any, int, error) {
		return nil, http.StatusNotFound, errors.New("machine returned HTTP 404")
	}
	keep := func(shot map[string]any, _ int64) (bool, error) {
		shot["machineId"] = int64(1)
		return true, nil
	}

	if _, err := p.backfillShots(context.Background(), 1, 5, notFound, keep, systemBackfillLogs); err != nil {
		t.Fatalf("first backfillShots: %v", err)
	}
	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if blocklistHas(block, "5") {
		t.Fatalf("blocklist = %v, want it NOT to contain 5 (the newest, only transiently unreadable shot)", block)
	}

	found := func(_ context.Context, native int64) (map[string]any, int, error) {
		return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
	}
	if _, err := p.backfillShots(context.Background(), 1, 5, found, keep, systemBackfillLogs); err != nil {
		t.Fatalf("second backfillShots: %v", err)
	}
	if s, err := repo.FindByID(5); err != nil {
		t.Fatalf("FindByID(5): %v", err)
	} else if s == nil {
		t.Fatalf("shot 5 was not imported on the retry cycle")
	}
}

// TestBackfillShots_NonNewestNotFoundStillBlocklisted makes sure the fix is
// narrow: a 404 below latestNative is still a permanently missing shot.
func TestBackfillShots_NonNewestNotFoundStillBlocklisted(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	fetch := func(_ context.Context, native int64) (map[string]any, int, error) {
		if native == 4 {
			return nil, http.StatusNotFound, errors.New("machine returned HTTP 404")
		}
		return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
	}
	keep := func(shot map[string]any, _ int64) (bool, error) {
		shot["machineId"] = int64(1)
		return true, nil
	}

	if _, err := p.backfillShots(context.Background(), 1, 5, fetch, keep, systemBackfillLogs); err != nil {
		t.Fatalf("backfillShots: %v", err)
	}
	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if !blocklistHas(block, "4") {
		t.Fatalf("blocklist = %v, want it to contain 4 (permanently missing below the newest)", block)
	}
	if blocklistHas(block, "5") {
		t.Fatalf("blocklist = %v, want it NOT to contain 5", block)
	}
	if s, err := repo.FindByID(5); err != nil {
		t.Fatalf("FindByID(5): %v", err)
	} else if s == nil {
		t.Fatalf("shot 5 missing after backfill")
	}
}

// TestBackfillShots_OldNewestBlocklistedOnceSuperseded proves the retry
// state is self-clearing: once a newer shot exists, the previously-newest id
// is no longer latestNative, so a genuinely missing one is blocklisted then.
func TestBackfillShots_OldNewestBlocklistedOnceSuperseded(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	fetch := func(_ context.Context, native int64) (map[string]any, int, error) {
		if native == 5 {
			return nil, http.StatusNotFound, errors.New("machine returned HTTP 404")
		}
		return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
	}
	keep := func(shot map[string]any, _ int64) (bool, error) {
		shot["machineId"] = int64(1)
		return true, nil
	}

	if _, err := p.backfillShots(context.Background(), 1, 6, fetch, keep, systemBackfillLogs); err != nil {
		t.Fatalf("backfillShots: %v", err)
	}
	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if !blocklistHas(block, "5") {
		t.Fatalf("blocklist = %v, want it to contain 5 (no longer the newest)", block)
	}
	if blocklistHas(block, "6") {
		t.Fatalf("blocklist = %v, want it NOT to contain 6", block)
	}
	if s, err := repo.FindByID(6); err != nil {
		t.Fatalf("FindByID(6): %v", err)
	} else if s == nil {
		t.Fatalf("shot 6 missing after backfill")
	}
}
