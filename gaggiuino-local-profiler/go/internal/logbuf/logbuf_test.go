package logbuf

import (
	"strings"
	"testing"
)

func writeLines(t *testing.T, b *Buffer, lines ...string) {
	t.Helper()
	for _, l := range lines {
		if _, err := b.Write([]byte(l + "\n")); err != nil {
			t.Fatalf("Write(%q): %v", l, err)
		}
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestWrapAroundKeepsNewestInOrder(t *testing.T) {
	b := New(3)
	writeLines(t, b, "a", "b", "c", "d", "e")
	if got, want := b.Lines(10), []string{"c", "d", "e"}; !equal(got, want) {
		t.Fatalf("Lines = %v, want %v", got, want)
	}
}

func TestLinesBounds(t *testing.T) {
	b := New(5)
	writeLines(t, b, "a", "b", "c")
	if got, want := b.Lines(2), []string{"b", "c"}; !equal(got, want) {
		t.Fatalf("Lines(2) = %v, want %v", got, want)
	}
	if got, want := b.Lines(10), []string{"a", "b", "c"}; !equal(got, want) {
		t.Fatalf("Lines(10) = %v, want %v", got, want)
	}
	if got := b.Lines(0); got != nil {
		t.Fatalf("Lines(0) = %v, want nil", got)
	}
	if got := b.Lines(-1); got != nil {
		t.Fatalf("Lines(-1) = %v, want nil", got)
	}
	if got := New(3).Lines(5); got != nil {
		t.Fatalf("empty buffer Lines(5) = %v, want nil", got)
	}
}

func TestWriteNeverNarrowsTheInput(t *testing.T) {
	b := New(2)
	p := []byte("hello\n")
	n, err := b.Write(p)
	if err != nil || n != len(p) {
		t.Fatalf("Write = (%d, %v), want (%d, nil)", n, err, len(p))
	}
}

func TestPartialWritesJoinIntoOneLine(t *testing.T) {
	b := New(5)
	if _, err := b.Write([]byte("hel")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got := b.Lines(5); got != nil {
		t.Fatalf("an unterminated partial line should not be returned yet: %v", got)
	}
	if _, err := b.Write([]byte("lo wor")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := b.Write([]byte("ld\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got, want := b.Lines(5), []string{"hello world"}; !equal(got, want) {
		t.Fatalf("Lines = %v, want %v", got, want)
	}
}

func TestMultipleLinesInOneWrite(t *testing.T) {
	b := New(5)
	if _, err := b.Write([]byte("a\nb\nc\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got, want := b.Lines(5), []string{"a", "b", "c"}; !equal(got, want) {
		t.Fatalf("Lines = %v, want %v", got, want)
	}
}

func TestLongLinesAreTruncated(t *testing.T) {
	b := New(2)
	if _, err := b.Write([]byte(strings.Repeat("x", maxLineBytes+500) + "\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got := b.Lines(1)
	if len(got) != 1 {
		t.Fatalf("Lines = %v, want exactly one line", got)
	}
	if len(got[0]) != maxLineBytes {
		t.Fatalf("line length = %d, want %d", len(got[0]), maxLineBytes)
	}
}

func TestPartialLongLineIsTruncated(t *testing.T) {
	b := New(2)
	if _, err := b.Write([]byte(strings.Repeat("y", maxLineBytes+500))); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := b.Write([]byte("end\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got := b.Lines(1)
	if len(got) != 1 || len(got[0]) != maxLineBytes {
		t.Fatalf("Lines = %v, want one line of %d bytes", got, maxLineBytes)
	}
}
