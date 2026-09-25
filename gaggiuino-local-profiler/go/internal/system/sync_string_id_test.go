package system

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestJsNumberToInt64 covers every shape jsNumberToInt64 must tolerate: the
// float64 encoding/json produces for a bare JSON number, an int64 built
// in-process, json.Number, and — the #1142 regression — a numeric JSON
// string some firmware builds send instead.
func TestJsNumberToInt64(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want int64
		ok   bool
	}{
		{"string", "78", 78, true},
		{"zero-padded string", " 78 ", 78, true},
		{"non-numeric string", "abc", 0, false},
		{"empty string", "", 0, false},
		{"float64", 78.0, 78, true},
		{"int64", int64(5), 5, true},
		{"nil", nil, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := jsNumberToInt64(tc.in)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("jsNumberToInt64(%#v) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
			}
		})
	}
}

// newSyncFakeMachine serves the two Gaggiuino endpoints the pull loop reads:
// GET /api/shots/latest (the latest-body string verbatim) and
// GET /api/shots/{id} (from the shots map, 404 on a miss). Bodies are
// passed as raw JSON so a test can choose string vs number ids.
func newSyncFakeMachine(t *testing.T, latest string, shotsByID map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/shots/latest":
			fmt.Fprint(w, latest)
		case strings.HasPrefix(r.URL.Path, "/api/shots/"):
			body, ok := shotsByID[strings.TrimPrefix(r.URL.Path, "/api/shots/")]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			fmt.Fprint(w, body)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// withSyncTestServer points the pull loop at an httptest fake machine for the
// duration of one test. syncClient is swapped for a plain client because
// machines.NewGuardedHTTPClient's dialer rejects loopback addresses;
// syncBaseURLFor is the seam that skips BaseURLFor's matching host check.
func withSyncTestServer(t *testing.T, baseURL string) {
	t.Helper()
	origClient, origBase := syncClient, syncBaseURLFor
	syncClient = &http.Client{Timeout: 5 * time.Second}
	syncBaseURLFor = func(context.Context, *machines.Machine) (string, error) { return baseURL, nil }
	t.Cleanup(func() { syncClient, syncBaseURLFor = origClient, origBase })
}

// shotJSON builds a minimal valid shot body — an id in the requested JSON
// shape plus the datapoints the sync loop requires.
func shotJSON(idJSON, timestamp string) string {
	return fmt.Sprintf(`{"id":%s,"timestamp":%s,"datapoints":[[0,1,2]],"profileName":"Espresso"}`, idJSON, timestamp)
}

// assertSyncStoresShots123 asserts that one sync against a fake machine
// reporting `latest` and shots 1..3 in the given id shape lands three
// distinct rows with ids 1, 2 and 3 — the store-side proof of the #1142 fix
// (a string id parsed to 0 used to make every shot overwrite the previous
// one).
func assertSyncStoresShots123(t *testing.T, latest string, shotsByID map[string]string) {
	t.Helper()
	srv := newSyncFakeMachine(t, latest, shotsByID)
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	withSyncTestServer(t, srv.URL)

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 3 {
		t.Fatalf("shot count = %d, want 3 (string ids likely collapsed onto id 0)", n)
	}
	for i := int64(1); i <= 3; i++ {
		s, err := repo.FindByID(i)
		if err != nil {
			t.Fatalf("FindByID(%d): %v", i, err)
		}
		if s == nil {
			t.Fatalf("shot %d missing after sync", i)
		}
		if got, ok := jsNumberToInt64(s["id"]); !ok || got != i {
			t.Fatalf("shot %d stored with id %v (ok=%v)", i, s["id"], ok)
		}
	}
	if max, err := repo.MaxNativeShotID(1); err != nil {
		t.Fatalf("MaxNativeShotID: %v", err)
	} else if max != 3 {
		t.Fatalf("MaxNativeShotID = %d, want 3", max)
	}
}

func TestSyncDefaultMachineShots_StringShotIDs(t *testing.T) {
	assertSyncStoresShots123(t,
		`[{"lastShotId":"3"}]`,
		map[string]string{
			"1": shotJSON(`"1"`, "1000"),
			"2": shotJSON(`"2"`, "2000"),
			"3": shotJSON(`"3"`, "3000"),
		})
}

func TestSyncDefaultMachineShots_NumericShotIDs(t *testing.T) {
	assertSyncStoresShots123(t,
		`[{"lastShotId":3}]`,
		map[string]string{
			"1": shotJSON(`1`, "1000"),
			"2": shotJSON(`2`, "2000"),
			"3": shotJSON(`3`, "3000"),
		})
}
