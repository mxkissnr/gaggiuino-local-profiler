package machines

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestHttpGetBytesCapped_TruncatesOversizedResponse is #991's regression
// test: a machine (or anything spoofing one) that returns more than
// maxBytes must never have its full body read into memory -- the read is
// capped via io.LimitReader, so the returned slice is truncated at
// maxBytes rather than growing to the response's real size.
func TestHttpGetBytesCapped_TruncatesOversizedResponse(t *testing.T) {
	allowLoopbackMachineHost(t)
	const maxBytes = 1 << 20                                // 1MB cap for this test
	oversized := bytes.Repeat([]byte{0xAA}, maxBytes+5<<20) // 5MB over the cap

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write(oversized)
	}))
	defer srv.Close()

	data, err := httpGetBytesCapped(context.Background(), srv.URL, 5*time.Second, maxBytes)
	if err != nil {
		t.Fatalf("httpGetBytesCapped: %v", err)
	}
	if len(data) != maxBytes {
		t.Fatalf("len(data) = %d, want exactly the %d-byte cap (response body was %d bytes)", len(data), maxBytes, len(oversized))
	}
}
