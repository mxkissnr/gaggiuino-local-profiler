package web

import (
	"database/sql"
	"database/sql/driver"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file exists to prove a #901 code-review fix actually took effect at
// the SQL level, not just in the Go source: handlers_library.go's
// toggleBeanActiveAction used to call h.repo.GetLibrary() a second time
// right after library.ToggleBeanActive had already read (and saved) the
// same Library, just to re-render one row. countingDriver wraps the real
// modernc.org/sqlite driver and counts how many times a query matching a
// given substring actually reaches the database, so
// TestToggleBeanActiveAction_SingleLibraryRead (handlers_library_test.go)
// can assert "exactly one read" directly instead of only asserting the
// response looks right (which the pre-fix code with its redundant read also
// satisfied).

// queryTracker records every query string countingConn observes.
type queryTracker struct {
	mu      sync.Mutex
	queries []string
}

func (q *queryTracker) record(query string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.queries = append(q.queries, query)
}

// count returns how many recorded queries contain substr.
func (q *queryTracker) count(substr string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := 0
	for _, query := range q.queries {
		if strings.Contains(query, substr) {
			n++
		}
	}
	return n
}

// reset drops every query recorded so far — used to discard setup noise
// (e.g. a SaveLibrary fixture write) before measuring the request under
// test.
func (q *queryTracker) reset() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.queries = nil
}

// countingDriver wraps an already-registered database/sql driver.Driver,
// tracking every Query/Exec that reaches it through countingConn below.
type countingDriver struct {
	underlying driver.Driver
	tracker    *queryTracker
}

func (d *countingDriver) Open(name string) (driver.Conn, error) {
	conn, err := d.underlying.Open(name)
	if err != nil {
		return nil, err
	}
	return &countingConn{Conn: conn, tracker: d.tracker}, nil
}

// countingConn wraps a driver.Conn, embedding it for Prepare/Close/Begin
// (unchanged) while explicitly implementing the legacy driver.Queryer/
// driver.Execer methods so every Query/Exec is counted — modernc.org/sqlite's
// *conn implements these legacy (non-Context) interfaces rather than
// QueryerContext/ExecerContext (verified against the vendored version in
// go.mod: its Query/Exec methods take []driver.Value, not
// context.Context+[]driver.NamedValue), which is what database/sql's
// QueryContext/ExecContext fall back to using when a driver only offers the
// legacy shape.
type countingConn struct {
	driver.Conn
	tracker *queryTracker
}

func (c *countingConn) Query(query string, args []driver.Value) (driver.Rows, error) {
	c.tracker.record(query)
	q, ok := c.Conn.(driver.Queryer)
	if !ok {
		return nil, driver.ErrSkip
	}
	return q.Query(query, args)
}

func (c *countingConn) Exec(query string, args []driver.Value) (driver.Result, error) {
	c.tracker.record(query)
	e, ok := c.Conn.(driver.Execer)
	if !ok {
		return nil, driver.ErrSkip
	}
	return e.Exec(query, args)
}

// countingDriverSeq keeps each registered countingDriver's name unique —
// sql.Register panics on a duplicate name, and multiple tests in this
// package each need their own tracker.
var countingDriverSeq int64

// newCountingTestLibraryServer is newTestLibraryServer's counterpart for
// tests that need to observe the actual SQL traffic a request generates,
// not just its HTTP response.
func newCountingTestLibraryServer(t *testing.T) (*http.ServeMux, *library.Repository, *queryTracker) {
	t.Helper()

	// Grab the already-registered "sqlite" driver.Driver (imported for its
	// side effect by internal/db) without opening a real connection, so
	// countingDriver can wrap the genuine modernc.org/sqlite implementation
	// instead of reimplementing it.
	base, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open (grabbing base driver): %v", err)
	}
	baseDriver := base.Driver()
	if err := base.Close(); err != nil {
		t.Fatalf("closing throwaway driver-probe connection: %v", err)
	}

	tracker := &queryTracker{}
	driverName := fmt.Sprintf("sqlite-counting-%d", atomic.AddInt64(&countingDriverSeq, 1))
	sql.Register(driverName, &countingDriver{underlying: baseDriver, tracker: tracker})

	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := sql.Open(driverName, dbPath)
	if err != nil {
		t.Fatalf("sql.Open(%q): %v", driverName, err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if _, err := sqlDB.Exec(`PRAGMA journal_mode = WAL`); err != nil {
		t.Fatalf("setting WAL mode: %v", err)
	}
	if err := db.InitSchema(sqlDB); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}

	libRepo := library.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	h := NewLibraryHandlers(libRepo, shotsRepo)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, libRepo, tracker
}
