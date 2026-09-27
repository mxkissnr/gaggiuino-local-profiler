// Package logbuf is a small, fixed-capacity ring buffer of the most recent
// log lines. cmd/server tees its standard-logger output into one so the
// get_diagnostics developer tool (#1196) can return the app's own recent
// output without shelling out to the system log.
package logbuf

import (
	"bytes"
	"sync"
)

// maxLineBytes caps one stored line, so a single pathological write (a base64
// blob, a stack dump) cannot crowd out the rest of the buffer.
const maxLineBytes = 1000

// Buffer is a concurrency-safe io.Writer holding the most recent lines
// written to it. It splits input on '\n' and keeps an unterminated trailing
// fragment until a later write completes it; any line longer than
// maxLineBytes is truncated.
type Buffer struct {
	mu       sync.Mutex
	capacity int
	lines    []string
	next     int
	full     bool
	partial  []byte
}

// New returns a Buffer retaining at most capacity lines (at least one).
func New(capacity int) *Buffer {
	if capacity < 1 {
		capacity = 1
	}
	return &Buffer{capacity: capacity, lines: make([]string, capacity)}
}

// Write implements io.Writer. It never returns an error and always reports
// len(p), so it can sit in an io.MultiWriter alongside os.Stderr without
// breaking the other writers.
func (b *Buffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := p
	for {
		i := bytes.IndexByte(remaining, '\n')
		if i < 0 {
			b.partial = append(b.partial, remaining...)
			if len(b.partial) > maxLineBytes {
				b.partial = b.partial[:maxLineBytes]
			}
			break
		}
		line := append(b.partial, remaining[:i]...)
		b.partial = b.partial[:0]
		b.store(string(line))
		remaining = remaining[i+1:]
	}
	return len(p), nil
}

// store appends one completed line, truncating it and overwriting the oldest
// line once the buffer is full.
func (b *Buffer) store(line string) {
	if len(line) > maxLineBytes {
		line = line[:maxLineBytes]
	}
	b.lines[b.next] = line
	b.next = (b.next + 1) % b.capacity
	if b.next == 0 {
		b.full = true
	}
}

// Lines returns up to n of the most recent lines, oldest first. It returns
// nil when the buffer holds nothing or n is not positive.
func (b *Buffer) Lines(n int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n <= 0 {
		return nil
	}
	size := b.next
	if b.full {
		size = b.capacity
	}
	if n > size {
		n = size
	}
	if n == 0 {
		return nil
	}
	start := 0
	if b.full {
		start = b.next
	}
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, b.lines[(start+i)%b.capacity])
	}
	return out
}
