package achievements

import (
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newTestEnvWithRevs is newTestEnv with Deps.RevsFn wired to revs, so a test
// can move the data-change revision digest without touching the DB.
func newTestEnvWithRevs(t *testing.T, revs func() string) *testEnv {
	t.Helper()
	env := newTestEnv(t)
	libRepo := library.NewRepository(env.db)
	env.svc = NewService(NewRepository(env.db), Deps{
		Shots:       shots.NewRepository(env.db),
		Library:     libRepo,
		Orders:      orders.NewRepository(env.db),
		Maintenance: maintenance.NewRepository(env.db, libRepo),
		Registry:    machines.NewRegistry(env.db),
		VersionFn:   func() VersionCache { return env.version },
		RevsFn:      revs,
	})
	env.handler = NewHandlers(env.svc)
	return env
}

// TestGetState_RerunsWhenRevsChange pins the RevsFn half of the fingerprint
// gate (#1625): ChangeFingerprint's COUNT/MAX/LENGTH aggregates miss a
// mutation that keeps byte counts equal — a rating edit or a photo upload — so
// maybeEvaluate must also fold in the sse.DataChanges revision digest, or the
// badge unlocks late. The probe matches
// TestGetState_SkipsFullEvaluateWhenNothingChanged: unlock a badge via a read,
// delete its row behind the service's back, then read again. An unchanged
// digest means the gate skips evaluateAll (the row stays gone); a moved digest
// re-evaluates and re-unlocks.
func TestGetState_RerunsWhenRevsChange(t *testing.T) {
	revs := "epoch;a=1"
	env := newTestEnvWithRevs(t, func() string { return revs })

	env.insertShot(t, 5, time.Now().Unix(), map[string]any{"datapoints": map[string]any{}}, nil)
	if badgeByID(env.get(t, "en"))["first_shot"]["unlocked"] != true {
		t.Fatalf("first_shot should unlock after the first read")
	}

	if _, err := env.db.Exec(`DELETE FROM achievements WHERE id = 'first_shot'`); err != nil {
		t.Fatalf("deleting achievement row: %v", err)
	}

	// Same DB + same digest -> the gate skips evaluateAll, so the row stays gone.
	if got := badgeByID(env.get(t, "en"))["first_shot"]["unlocked"]; got != false {
		t.Fatalf("first_shot re-unlocked with no digest change — RevsFn not part of the fingerprint gate (got unlocked=%v)", got)
	}

	// Move only the digest (the DB is untouched) -> evaluateAll runs again.
	revs = "epoch;a=2"
	if got := badgeByID(env.get(t, "en"))["first_shot"]["unlocked"]; got != true {
		t.Fatalf("first_shot should re-unlock after the revision digest moves (got unlocked=%v)", got)
	}
}
