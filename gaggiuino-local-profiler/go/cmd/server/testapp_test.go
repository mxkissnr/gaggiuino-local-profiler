package main

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newTestApp builds the full handler chain (buildApp) against a fresh throwaway
// data directory and returns the handler, the app's *sql.DB and that directory.
// cfg's dbPath/tokenPath are filled in here; every other field is used as given.
//
// buildApp starts background goroutines (poller.Start's scheduled sync, HA check,
// preheat watch, profile sync sweep and live-poll watcher, plus the trash purge)
// that it never waits on — cancelling the context does not join them. A returning
// test can therefore still have one of them writing into the data directory,
// typically a SQLite -wal/-shm file through a connection closing around the same
// time, exactly while the directory is removed (#1477: t.TempDir's RemoveAll
// would then fail with "directory not empty"). The directory is created with
// os.MkdirTemp so no built-in cleanup can race it, and the single cleanup
// registered here cancels the context, closes the DB and then removes the
// directory with a short retry before failing the test.
func newTestApp(t *testing.T, cfg appConfig) (http.Handler, *sql.DB, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "glp-testapp-")
	if err != nil {
		t.Fatalf("creating test data dir: %v", err)
	}
	cfg.dbPath = filepath.Join(dir, "glp.db")
	cfg.tokenPath = filepath.Join(dir, "api_token.txt")

	ctx, cancel := context.WithCancel(context.Background())
	handler, sqlDB, err := buildApp(ctx, cfg)
	if err != nil {
		cancel()
		os.RemoveAll(dir)
		t.Fatalf("buildApp: %v", err)
	}
	t.Cleanup(func() {
		cancel()
		sqlDB.Close()
		removeAllRetry(t, dir)
	})
	return handler, sqlDB, dir
}

// removeAllRetry removes dir, retrying briefly so the still-exiting background
// goroutines can release or finish the files they hold or exchange (#1477).
func removeAllRetry(t *testing.T, dir string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		err := os.RemoveAll(dir)
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Errorf("removing test data dir %s: %v", dir, err)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}
