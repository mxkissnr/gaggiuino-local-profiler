package shots_test

import (
	"bytes"
	"encoding/json"
	"strconv"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
)

// TestShotsJSON_LimitReturnsTailOfFullList (#1616) pins that
// /shots.json?limit=N is exactly the last N entries of the unlimited list —
// same shots, same order, same bytes — and that an absent or invalid limit
// keeps the full list.
func TestShotsJSON_LimitReturnsTailOfFullList(t *testing.T) {
	env := newPerfEnv(t, perfseed.Equivalence)
	var full []json.RawMessage
	if err := json.Unmarshal(env.get(t, "/shots.json").Body.Bytes(), &full); err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{1, 10, 117, len(full), len(full) + 50} {
		var got []json.RawMessage
		if err := json.Unmarshal(env.get(t, "/shots.json?limit="+strconv.Itoa(n)).Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		want := full[max(len(full)-n, 0):]
		if len(got) != len(want) {
			t.Fatalf("limit=%d: %d shots, want %d", n, len(got), len(want))
		}
		for i := range got {
			if !bytes.Equal(got[i], want[i]) {
				t.Fatalf("limit=%d: entry %d differs from the full list's\n got %.200s\nwant %.200s", n, i, got[i], want[i])
			}
		}
	}
	fullBody := env.get(t, "/shots.json").Body.String()
	for _, q := range []string{"limit=", "limit=0", "limit=-3", "limit=abc", "limit=1.5"} {
		if got := env.get(t, "/shots.json?"+q).Body.String(); got != fullBody {
			t.Errorf("?%s: expected the full list", q)
		}
	}
	trash := env.get(t, "/shots.json?trash=1").Body.String()
	if got := env.get(t, "/shots.json?trash=1&limit=2").Body.String(); got != trash {
		t.Error("?trash=1&limit=2: expected the full trash list (limit applies to active shots only)")
	}
}

// TestShotsJSON_ShotsTodayHeader (#1616) pins the X-Shots-Today count:
// non-trashed shots stamped on the server's local calendar day, on every
// variant of the request.
func TestShotsJSON_ShotsTodayHeader(t *testing.T) {
	env := newPerfEnv(t, perfseed.Equivalence)
	if env.info.TodayShots == 0 {
		t.Fatal("the seed should stamp shots today")
	}
	want := strconv.Itoa(env.info.TodayShots)
	for _, path := range []string{"/shots.json", "/shots.json?limit=10", "/shots.json?trash=1"} {
		if got := env.get(t, path).Header().Get("X-Shots-Today"); got != want {
			t.Errorf("GET %s: X-Shots-Today = %q, want %q", path, got, want)
		}
	}
}
