package system

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestSyncDefaultMachineShots_TrashedLatestNotRefetched is the end-to-end
// #1150 proof: the newest local shot is in the trash, and the machine still
// reports it as its latest. The sync must consider itself up to date (no
// /api/shots/3 fetch) and the shot's annotation must survive.
func TestSyncDefaultMachineShots_TrashedLatestNotRefetched(t *testing.T) {
	var mu sync.Mutex
	hits := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/shots/latest":
			fmt.Fprint(w, `[{"lastShotId":3}]`)
		case r.URL.Path == "/api/shots/3":
			fmt.Fprint(w, shotJSON(`3`, "3000"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)

	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	withSyncTestServer(t, srv.URL)

	for i := int64(1); i <= 3; i++ {
		if err := repo.Upsert(shots.Shot{"id": i, "timestamp": i * 1000, "datapoints": []any{}}); err != nil {
			t.Fatalf("seeding shot %d: %v", i, err)
		}
	}
	if err := repo.SaveAnnotation(3, map[string]any{"rating": float64(9)}); err != nil {
		t.Fatalf("SaveAnnotation(3): %v", err)
	}
	if err := repo.MoveToTrash(3); err != nil {
		t.Fatalf("MoveToTrash(3): %v", err)
	}

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	mu.Lock()
	fetched := hits["/api/shots/3"]
	mu.Unlock()
	if fetched != 0 {
		t.Fatalf("shot 3 fetched %d time(s), want 0 (trashed latest must not re-sync)", fetched)
	}
	ann, err := repo.GetAnnotation(3)
	if err != nil {
		t.Fatalf("GetAnnotation(3): %v", err)
	}
	if ann["rating"] != float64(9) {
		t.Fatalf("annotation after sync = %#v, want rating 9", ann)
	}
}

// TestSyncDefaultMachineShots_MalformedShotSkipped is the end-to-end #1151
// proof: shot 2's body is truncated JSON, but shots 1 and 3 must still
// import, the sync must report success, and shot 2 must not be blocklisted.
func TestSyncDefaultMachineShots_MalformedShotSkipped(t *testing.T) {
	srv := newSyncFakeMachine(t, `[{"lastShotId":3}]`, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": `{"id":2,"datapoints":[`,
		"3": shotJSON(`3`, "3000"),
	})
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	withSyncTestServer(t, srv.URL)

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots returned %v, want nil (malformed shot should be skipped)", err)
	}

	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 2 {
		t.Fatalf("shot count = %d, want 2 (shots 1 and 3)", n)
	}
	for _, id := range []int64{1, 3} {
		if s, err := repo.FindByID(id); err != nil {
			t.Fatalf("FindByID(%d): %v", id, err)
		} else if s == nil {
			t.Fatalf("shot %d missing after sync", id)
		}
	}
	if s, err := repo.FindByID(2); err != nil {
		t.Fatalf("FindByID(2): %v", err)
	} else if s != nil {
		t.Fatalf("shot 2 should not have been stored (malformed body)")
	}
	if st := p.SyncState(); st.LastSyncError != nil {
		t.Fatalf("LastSyncError = %q, want nil after a skip", *st.LastSyncError)
	}
	if block, err := repo.GetBlocklist(); err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	} else {
		for _, v := range block {
			if v == "2" {
				t.Fatalf("shot 2 must not be blocklisted, got %v", block)
			}
		}
	}
}

// TestSyncDefaultMachineShots_TruncatedBodyAbortsSync is the regression for
// the reviewer's finding on #1151: a connection dropped mid-body (here a
// Content-Length larger than the bytes sent, then a hijacked close) surfaces
// as io.ErrUnexpectedEOF, not a net.Error. It must abort the sync and be
// retried next run, NOT be tagged malformed and skipped — otherwise shot 2 is
// never imported once shot 3 lands above it.
func TestSyncDefaultMachineShots_TruncatedBodyAbortsSync(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/shots/latest":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `[{"lastShotId":3}]`)
		case "/api/shots/1":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, shotJSON(`1`, "1000"))
		case "/api/shots/2":
			// Announce a longer body than we send, then drop the connection so
			// the client's body read fails with an unexpected EOF.
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Errorf("response writer does not support hijacking")
				return
			}
			conn, buf, err := hj.Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			defer conn.Close()
			body := shotJSON(`2`, "2000")
			fmt.Fprintf(buf, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", len(body)+16)
			buf.WriteString(body[:len(body)/2])
			buf.Flush()
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)

	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	withSyncTestServer(t, srv.URL)

	if err := p.syncDefaultMachineShots(context.Background()); err == nil {
		t.Fatalf("syncDefaultMachineShots succeeded, want an error (a truncated body must abort the sync)")
	}
	if s, err := repo.FindByID(3); err != nil {
		t.Fatalf("FindByID(3): %v", err)
	} else if s != nil {
		t.Fatalf("shot 3 imported despite the aborted sync")
	}
	if max, err := repo.MaxNativeShotID(1); err != nil {
		t.Fatalf("MaxNativeShotID(1): %v", err)
	} else if max != 1 {
		t.Fatalf("MaxNativeShotID(1) = %d, want 1 (sync must stop at the broken shot)", max)
	}
}
