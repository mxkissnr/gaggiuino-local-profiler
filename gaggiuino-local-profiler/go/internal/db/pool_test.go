package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// expectedPoolSize mirrors Open()'s max(4, NumCPU) after the migration phase.
func expectedPoolSize() int {
	if n := runtime.NumCPU(); n > 4 {
		return n
	}
	return 4
}

// TestOpen_PoolAppliesPragmasToEveryConnection forces the pool to hand out
// several distinct physical connections at once and checks each one came up
// with the DSN pragmas active (#956: pragmas moved from a one-shot Exec on
// the single connection into the connection URL, so every pooled
// connection is identical).
func TestOpen_PoolAppliesPragmasToEveryConnection(t *testing.T) {
	sqlDB, err := Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer sqlDB.Close()

	if got := sqlDB.Stats().MaxOpenConnections; got != expectedPoolSize() {
		t.Fatalf("MaxOpenConnections = %d, want %d", got, expectedPoolSize())
	}

	const n = 4
	conns := make([]*sql.Conn, 0, n)
	ctx := context.Background()
	for i := 0; i < n; i++ {
		c, err := sqlDB.Conn(ctx)
		if err != nil {
			t.Fatalf("Conn %d: %v", i, err)
		}
		conns = append(conns, c)
		t.Cleanup(func() { c.Close() })
	}
	// All n connections are checked out simultaneously here, so each
	// PRAGMA query below runs on its own physical connection.
	for i, c := range conns {
		var journal string
		if err := c.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&journal); err != nil {
			t.Fatalf("conn %d journal_mode: %v", i, err)
		}
		if journal != "wal" {
			t.Errorf("conn %d journal_mode = %q, want wal", i, journal)
		}

		var fk int
		if err := c.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&fk); err != nil {
			t.Fatalf("conn %d foreign_keys: %v", i, err)
		}
		if fk != 1 {
			t.Errorf("conn %d foreign_keys = %d, want 1", i, fk)
		}

		var busy int
		if err := c.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&busy); err != nil {
			t.Fatalf("conn %d busy_timeout: %v", i, err)
		}
		if busy != 5000 {
			t.Errorf("conn %d busy_timeout = %d, want 5000", i, busy)
		}

		var sync int
		if err := c.QueryRowContext(ctx, `PRAGMA synchronous`).Scan(&sync); err != nil {
			t.Fatalf("conn %d synchronous: %v", i, err)
		}
		if sync != 1 { // 1 == NORMAL
			t.Errorf("conn %d synchronous = %d, want 1 (NORMAL)", i, sync)
		}
	}
}

// TestOpen_ConcurrentReadersDoNotBlock pins one connection on a slow read
// and shows a second reader still completes meanwhile — impossible under
// the old SetMaxOpenConns(1) handle, where the second reader would queue
// behind the first for the single connection.
func TestOpen_ConcurrentReadersDoNotBlock(t *testing.T) {
	sqlDB, err := Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer sqlDB.Close()

	ctx := context.Background()
	held, err := sqlDB.Conn(ctx)
	if err != nil {
		t.Fatalf("Conn (held reader): %v", err)
	}
	defer held.Close()

	// Open a cursor on the held connection and leave it undrained — that
	// connection is now busy for the rest of the test.
	rows, err := held.QueryContext(ctx, `SELECT key, value FROM kv`)
	if err != nil {
		t.Fatalf("held reader query: %v", err)
	}
	defer rows.Close()

	done := make(chan error, 1)
	go func() {
		c2, err := sqlDB.Conn(ctx)
		if err != nil {
			done <- err
			return
		}
		defer c2.Close()
		var one int
		done <- c2.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("second reader while first held a connection: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("second reader blocked behind the first connection (pool not concurrent)")
	}
}

// TestOpen_ReaderAndWriterNoSQLiteBusy runs a writer while a reader holds
// an open snapshot: WAL + per-connection busy_timeout must let the writer
// through without SQLITE_BUSY, and the reader must still see a consistent
// result set.
func TestOpen_ReaderAndWriterNoSQLiteBusy(t *testing.T) {
	sqlDB, err := Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer sqlDB.Close()

	ctx := context.Background()
	if _, err := sqlDB.ExecContext(ctx, `INSERT INTO kv (key, value) VALUES ('seed', '1')`); err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	var before int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM kv`).Scan(&before); err != nil {
		t.Fatalf("pre-count: %v", err)
	}

	reader, err := sqlDB.Conn(ctx)
	if err != nil {
		t.Fatalf("Conn (reader): %v", err)
	}
	defer reader.Close()

	rows, err := reader.QueryContext(ctx, `SELECT key FROM kv`)
	if err != nil {
		t.Fatalf("reader query: %v", err)
	}

	var wg sync.WaitGroup
	writeErr := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := sqlDB.ExecContext(ctx,
				`INSERT INTO kv (key, value) VALUES (?, ?)`,
				time.Now().UnixNano()+int64(i), "x")
			writeErr <- err
		}(i)
	}
	wg.Wait()
	close(writeErr)
	for err := range writeErr {
		if err != nil {
			t.Fatalf("concurrent writer hit an error (expected none with busy_timeout): %v", err)
		}
	}

	// The reader's cursor predates every concurrent insert; draining it
	// must not error.
	seen := 0
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatalf("reader scan: %v", err)
		}
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reader rows.Err: %v", err)
	}
	rows.Close()
	if seen == 0 {
		t.Fatal("reader saw no rows")
	}

	var total int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM kv`).Scan(&total); err != nil {
		t.Fatalf("final count: %v", err)
	}
	if total != before+8 { // 8 concurrent inserts all landed
		t.Fatalf("kv row count = %d, want %d", total, before+8)
	}
}
