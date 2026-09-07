package machines

import (
	"bytes"
	"context"
	"encoding/binary"
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

// buildSlogFixture assembles a minimal-but-valid .slog buffer: header +
// hdrSize padding + sampleCount samples of stride bytesPerSample, each
// sample just the raw uint16 values for the active fields in fieldsMask
// order. deviceSampleSize is written verbatim into byte 5 -- callers pass a
// crafted (possibly malicious) value there.
func buildSlogFixture(t *testing.T, deviceSampleSize byte, fieldsMask uint32, sampleCount int, bytesPerSample int) []byte {
	t.Helper()
	const hdrSize = gaggiMateSlogHdrV4
	data := make([]byte, hdrSize+sampleCount*bytesPerSample)
	binary.LittleEndian.PutUint32(data[0:4], gaggiMateSlogMagic)
	data[4] = 4 // version
	data[5] = deviceSampleSize
	binary.LittleEndian.PutUint16(data[6:8], 0) // hdrSize: 0 -> default (v4 -> 128)
	binary.LittleEndian.PutUint16(data[8:10], 100)
	binary.LittleEndian.PutUint32(data[12:16], fieldsMask)
	binary.LittleEndian.PutUint32(data[16:20], 0) // sampleCountHdr: 0 -> derive from length
	binary.LittleEndian.PutUint32(data[20:24], uint32(sampleCount*100))
	binary.LittleEndian.PutUint32(data[24:28], 1234)

	for i := 0; i < sampleCount; i++ {
		base := hdrSize + i*bytesPerSample
		binary.LittleEndian.PutUint16(data[base:base+2], uint16(i))
		if bytesPerSample >= 4 {
			binary.LittleEndian.PutUint16(data[base+2:base+4], uint16(200+i))
		}
	}
	return data
}

// TestGaggiMateParseSlog_RejectsUndersizedDeviceSampleSize is #992's
// regression test: fieldsMask selects 2 active fields (computedSampleSize
// == 4 bytes/sample), but the attacker-controlled deviceSampleSize byte
// claims a stride of 1. Before the fix, sampleSize trusted the device
// value whenever nonzero, so available/maxSamples divided the body length
// by 1 instead of 4 -- a ~4x preallocation here, and up to ~100x on a real
// 8MB body with a crafted sampleSize of 1. The fix floors sampleSize at
// computedSampleSize, so the resulting slice must stay bounded by the
// legitimate 4-byte stride, not the malicious 1-byte one.
func TestGaggiMateParseSlog_RejectsUndersizedDeviceSampleSize(t *testing.T) {
	const fieldsMask = 0b101         // bits 0 ("t") and 2 ("ct") -> 2 active fields
	const computedSampleSize = 2 * 2 // 4 bytes/sample
	const sampleCount = 50

	data := buildSlogFixture(t, 1 /* malicious deviceSampleSize */, fieldsMask, sampleCount, computedSampleSize)

	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}

	available := (len(data) - gaggiMateSlogHdrV4) / computedSampleSize
	if cap(result.samples) != available {
		t.Fatalf("cap(samples) = %d, want %d (bounded by the real %d-byte stride) -- a malicious sampleSize=1 must not inflate this toward %d",
			cap(result.samples), available, computedSampleSize, (len(data)-gaggiMateSlogHdrV4)/1)
	}
	if len(result.samples) != sampleCount {
		t.Fatalf("len(samples) = %d, want %d", len(result.samples), sampleCount)
	}
}

// TestGaggiMateParseSlog_AllowsLargerDevicePadding checks the floor doesn't
// also break the legitimate case: a deviceSampleSize larger than
// computedSampleSize (e.g. device-side padding) must still be honored as
// the per-sample stride, not clobbered back down to computedSampleSize.
func TestGaggiMateParseSlog_AllowsLargerDevicePadding(t *testing.T) {
	const fieldsMask = 0b101   // 2 active fields, computedSampleSize == 4
	const paddedSampleSize = 6 // device reports 2 extra padding bytes/sample
	const sampleCount = 10

	data := buildSlogFixture(t, paddedSampleSize, fieldsMask, sampleCount, paddedSampleSize)

	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	want := (len(data) - gaggiMateSlogHdrV4) / paddedSampleSize
	if len(result.samples) != want {
		t.Fatalf("len(samples) = %d, want %d (device-reported %d-byte stride honored)", len(result.samples), want, paddedSampleSize)
	}
}
