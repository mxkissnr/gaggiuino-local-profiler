package machines

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
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

// gaggiMateTestSample carries the raw on-wire value of every .slog sample
// field. Fields that are not present in fieldsMask are ignored.
type gaggiMateTestSample struct {
	t              uint32 // elapsed-ms (v6+) or tick count (v<=5)
	tt, ct, tp, cp uint16
	fl, tf, pf, vf int16
	v, ev, pr      uint16
	si, wp         uint16
}

// buildGaggiMateSlog assembles a valid .slog buffer for the given version,
// fieldsMask and samples, encoding every field at its real offset and width.
// Unlike buildSlogFixture it supports the v6+ uint32 elapsed-ms field and the
// v7 wp field.
func buildGaggiMateSlog(t *testing.T, version byte, fieldsMask uint32, sampleIntervalMs uint16, samples []gaggiMateTestSample) []byte {
	t.Helper()
	const hdrSize = gaggiMateSlogHdrV5
	sampleSize := 0
	for bit := uint(0); bit < 32; bit++ {
		if fieldsMask&(1<<bit) == 0 {
			continue
		}
		if bit == 0 && version >= 6 {
			sampleSize += 4
		} else {
			sampleSize += 2
		}
	}
	var durationMs uint32
	if n := len(samples); n > 0 {
		durationMs = samples[n-1].t
	}
	data := make([]byte, hdrSize+len(samples)*sampleSize)
	binary.LittleEndian.PutUint32(data[0:4], gaggiMateSlogMagic)
	data[4] = version
	data[5] = byte(sampleSize)
	binary.LittleEndian.PutUint16(data[6:8], hdrSize)
	binary.LittleEndian.PutUint16(data[8:10], sampleIntervalMs)
	binary.LittleEndian.PutUint32(data[12:16], fieldsMask)
	binary.LittleEndian.PutUint32(data[16:20], uint32(len(samples)))
	binary.LittleEndian.PutUint32(data[20:24], durationMs)
	binary.LittleEndian.PutUint32(data[24:28], 1234)

	for i, s := range samples {
		off := hdrSize + i*sampleSize
		for bit := uint(0); bit < 32; bit++ {
			if fieldsMask&(1<<bit) == 0 {
				continue
			}
			if bit == 0 && version >= 6 {
				binary.LittleEndian.PutUint32(data[off:off+4], s.t)
				off += 4
				continue
			}
			var raw uint16
			switch bit {
			case 0:
				raw = uint16(s.t)
			case 1:
				raw = s.tt
			case 2:
				raw = s.ct
			case 3:
				raw = s.tp
			case 4:
				raw = s.cp
			case 5:
				raw = uint16(s.fl)
			case 6:
				raw = uint16(s.tf)
			case 7:
				raw = uint16(s.pf)
			case 8:
				raw = uint16(s.vf)
			case 9:
				raw = s.v
			case 10:
				raw = s.ev
			case 11:
				raw = s.pr
			case 12:
				raw = s.si
			case 13:
				raw = s.wp
			default:
				raw = 0 // unknown field: 2 bytes of padding
			}
			binary.LittleEndian.PutUint16(data[off:off+2], raw)
			off += 2
		}
	}
	return data
}

func assertGaggiMateFloat(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %v, want %v", name, got, want)
	}
}

// gaggiMateV7Sample is the shared payload used by the tests below: tt 93.0,
// ct 92.5, tp 9.0, cp 8.7, fl 2.1, v 18.4, wp 25.3 and systemInfo bit 0x04
// (BLE scale connected). tick is the raw elapsed-ms value.
func gaggiMateV7Sample(tick uint32) gaggiMateTestSample {
	return gaggiMateTestSample{
		t: tick, tt: 930, ct: 925, tp: 90, cp: 87,
		fl: 210, v: 184, si: 0x04, wp: 253,
	}
}

// TestGaggiMateParseSlog_V7Uint32Timestamps covers #1397: a v7 record is 30
// bytes and the elapsed-ms field is a uint32 used directly (not scaled by the
// sample interval), which a 517 ms sample (not a multiple of 250) proves.
func TestGaggiMateParseSlog_V7Uint32Timestamps(t *testing.T) {
	const mask = 0x3FFF // all 14 v7 fields
	data := buildGaggiMateSlog(t, 7, mask, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(250), gaggiMateV7Sample(517),
	})
	if got := int(data[5]); got != 30 {
		t.Fatalf("v7 sample size byte = %d, want 30", got)
	}
	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if len(result.samples) != 3 {
		t.Fatalf("len(samples) = %d, want 3", len(result.samples))
	}
	if got := result.samples[2].tickMs; got != 517 {
		t.Fatalf("tickMs = %v, want 517 (raw uint32 ms, not multiplied by the 250 ms interval)", got)
	}
	s := result.samples[0]
	assertGaggiMateFloat(t, "tt", s.tt, 93.0)
	assertGaggiMateFloat(t, "ct", s.ct, 92.5)
	assertGaggiMateFloat(t, "tp", s.tp, 9.0)
	assertGaggiMateFloat(t, "cp", s.cp, 8.7)
	assertGaggiMateFloat(t, "fl", s.fl, 2.1)
	assertGaggiMateFloat(t, "v", s.v, 18.4)
	assertGaggiMateFloat(t, "wp", s.wp, 25.3)
	if !s.bleScaleConnected {
		t.Fatalf("bleScaleConnected = false, want true (systemInfo bit 0x04)")
	}
}

// TestGaggiMateParseSlog_V6Uint32Timestamps checks the same 28-byte v6 layout
// without the v7 wp field.
func TestGaggiMateParseSlog_V6Uint32Timestamps(t *testing.T) {
	const mask = 0x1FFF // v6 fields, no wp
	data := buildGaggiMateSlog(t, 6, mask, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(250), gaggiMateV7Sample(517),
	})
	if got := int(data[5]); got != 28 {
		t.Fatalf("v6 sample size byte = %d, want 28", got)
	}
	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if got := result.samples[2].tickMs; got != 517 {
		t.Fatalf("tickMs = %v, want 517", got)
	}
	s := result.samples[0]
	assertGaggiMateFloat(t, "tt", s.tt, 93.0)
	assertGaggiMateFloat(t, "cp", s.cp, 8.7)
	assertGaggiMateFloat(t, "v", s.v, 18.4)
	if s.hasWP {
		t.Fatalf("hasWP = true for a v6 slog with no wp field")
	}
}

// TestGaggiMateParseSlog_V5TicksUnchanged checks v5 keeps its old 26-byte,
// 16-bit-tick-times-interval behaviour.
func TestGaggiMateParseSlog_V5TicksUnchanged(t *testing.T) {
	const mask = 0x1FFF // mask valid for v5 too
	data := buildGaggiMateSlog(t, 5, mask, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(1), gaggiMateV7Sample(2),
	})
	if got := int(data[5]); got != 26 {
		t.Fatalf("v5 sample size byte = %d, want 26", got)
	}
	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if got := result.samples[2].tickMs; got != 500 {
		t.Fatalf("tickMs = %v, want 500 (raw tick 2 * 250 ms) -- v5 must stay on 16-bit ticks", got)
	}
	assertGaggiMateFloat(t, "tt", result.samples[0].tt, 93.0)
	assertGaggiMateFloat(t, "cp", result.samples[0].cp, 8.7)
}

// TestGaggiMateParseSlog_SkipsUnknownMaskBits checks an unknown (future) mask
// bit still occupies its 2 bytes and is skipped, leaving the known fields
// where they belong.
func TestGaggiMateParseSlog_SkipsUnknownMaskBits(t *testing.T) {
	const mask = 0x1FFF | (1 << 14) // known fields plus an unknown future field
	data := buildGaggiMateSlog(t, 7, mask, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(517),
	})
	if got := int(data[5]); got != 30 {
		t.Fatalf("sample size byte = %d, want 30 (13 known*2 + unknown 2 + t extra 2)", got)
	}
	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	s := result.samples[1]
	if s.tickMs != 517 {
		t.Fatalf("tickMs = %v, want 517 -- an unknown mask bit must not shift the t field", s.tickMs)
	}
	assertGaggiMateFloat(t, "tt", s.tt, 93.0)
	assertGaggiMateFloat(t, "cp", s.cp, 8.7)
	if !s.bleScaleConnected {
		t.Fatalf("bleScaleConnected = false, want true")
	}
}

// TestGaggiMateSlogToShot_V7Arrays checks the canonical shot arrays and the
// new nullable waterPumped array for a v7 slog.
func TestGaggiMateSlogToShot_V7Arrays(t *testing.T) {
	const mask = 0x3FFF
	data := buildGaggiMateSlog(t, 7, mask, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(250), gaggiMateV7Sample(517),
	})
	slog, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	shot := gaggiMateSlogToShot(slog, 42)
	dp, ok := shot["datapoints"].(map[string]any)
	if !ok {
		t.Fatalf("datapoints missing or wrong type: %T", shot["datapoints"])
	}
	if got, want := dp["timeInShot"].([]int64), []int64{0, 3, 5}; !reflect.DeepEqual(got, want) {
		t.Fatalf("timeInShot = %v, want %v", got, want)
	}
	if got, want := dp["pressure"].([]int64), []int64{87, 87, 87}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pressure = %v, want %v", got, want)
	}
	extra, ok := shot["gaggimateExtra"].(map[string]any)
	if !ok {
		t.Fatalf("gaggimateExtra missing or wrong type: %T", shot["gaggimateExtra"])
	}
	waterPumped, ok := extra["waterPumped"].([]any)
	if !ok {
		t.Fatalf("waterPumped missing or wrong type: %T", extra["waterPumped"])
	}
	if len(waterPumped) != 3 {
		t.Fatalf("len(waterPumped) = %d, want 3", len(waterPumped))
	}
	for i, v := range waterPumped {
		f, ok := v.(float64)
		if !ok {
			t.Fatalf("waterPumped[%d] = %v (%T), want a float64", i, v, v)
		}
		assertGaggiMateFloat(t, "waterPumped", f, 25.3)
	}
}

// TestGaggiMateSlogToShot_MissingWaterPumpedIsNull checks waterPumped is a
// per-sample null array when the slog has no wp field.
func TestGaggiMateSlogToShot_MissingWaterPumpedIsNull(t *testing.T) {
	const mask = 0x1FFF // no wp field
	data := buildGaggiMateSlog(t, 5, mask, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(1), gaggiMateV7Sample(2),
	})
	slog, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	shot := gaggiMateSlogToShot(slog, 7)
	extra := shot["gaggimateExtra"].(map[string]any)
	waterPumped, ok := extra["waterPumped"].([]any)
	if !ok {
		t.Fatalf("waterPumped missing or wrong type: %T", extra["waterPumped"])
	}
	if len(waterPumped) != len(slog.samples) {
		t.Fatalf("len(waterPumped) = %d, want %d", len(waterPumped), len(slog.samples))
	}
	for i, v := range waterPumped {
		if v != nil {
			t.Fatalf("waterPumped[%d] = %v, want nil (field absent from slog)", i, v)
		}
	}
}

// putGaggiMatePhase writes one v5+ header phase transition at the upstream
// slot 110 + i*29: uint16 sample index, uint8 phase, uint8 reason, then up to
// 25 bytes of name. The header starts zeroed, so a shorter name stays
// NUL-terminated.
func putGaggiMatePhase(data []byte, i int, sampleIndex uint16, phase, reason byte, name string) {
	off := gaggiMateSlogPhaseOff + i*gaggiMateSlogPhaseSize
	binary.LittleEndian.PutUint16(data[off:off+2], sampleIndex)
	data[off+2] = phase
	data[off+3] = reason
	copy(data[off+4:off+4+25], name)
}

// TestGaggiMateParseSlog_V7PhaseTransitions covers #1409: the v5+ header's
// phase table and final exit reason parse into the slog struct and land in the
// shot's datapoints.
func TestGaggiMateParseSlog_V7PhaseTransitions(t *testing.T) {
	data := buildGaggiMateSlog(t, 7, 0x3FFF, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(250), gaggiMateV7Sample(500), gaggiMateV7Sample(750),
	})
	putGaggiMatePhase(data, 0, 0, 0, 0, "Preinfusion")
	putGaggiMatePhase(data, 1, 2, 1, 5, "Extraction")
	data[gaggiMateSlogPhaseCountOff] = 2
	data[gaggiMateSlogExitReasonOff] = 1

	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if !result.hasPhaseData {
		t.Fatalf("hasPhaseData = false, want true for a v5+ header")
	}
	wantTransitions := []gaggiMatePhaseTransition{
		{sampleIndex: 0, phaseNumber: 0, reason: 0, name: "Preinfusion"},
		{sampleIndex: 2, phaseNumber: 1, reason: 5, name: "Extraction"},
	}
	if !reflect.DeepEqual(result.phaseTransitions, wantTransitions) {
		t.Fatalf("phaseTransitions = %+v, want %+v", result.phaseTransitions, wantTransitions)
	}
	if result.finalExitReason != 1 {
		t.Fatalf("finalExitReason = %d, want 1", result.finalExitReason)
	}

	shot := gaggiMateSlogToShot(result, 42)
	dp := shot["datapoints"].(map[string]any)
	wantDP := []map[string]any{
		{"t": int64(0), "phase": 0, "name": "Preinfusion", "reason": 0},
		{"t": int64(5), "phase": 1, "name": "Extraction", "reason": 5},
	}
	if got := dp["phaseTransitions"]; !reflect.DeepEqual(got, wantDP) {
		t.Fatalf("phaseTransitions = %#v, want %#v", got, wantDP)
	}
	if got := dp["finalExitReason"]; got != 1 {
		t.Fatalf("finalExitReason = %v, want 1", got)
	}
}

// TestGaggiMateParseSlog_PhaseCountClamped checks a corrupt count byte cannot
// overflow the fixed 12-slot table.
func TestGaggiMateParseSlog_PhaseCountClamped(t *testing.T) {
	data := buildGaggiMateSlog(t, 7, 0x3FFF, 250, []gaggiMateTestSample{gaggiMateV7Sample(0)})
	data[gaggiMateSlogPhaseCountOff] = 200

	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if len(result.phaseTransitions) != gaggiMateSlogPhaseMax {
		t.Fatalf("len(phaseTransitions) = %d, want %d (count clamped)", len(result.phaseTransitions), gaggiMateSlogPhaseMax)
	}
}

// TestGaggiMateParseSlog_PhaseNameBounds checks the 25-byte name slot: a
// 24-char name plus NUL round-trips, and 25 non-NUL bytes stay within the slot.
func TestGaggiMateParseSlog_PhaseNameBounds(t *testing.T) {
	const name24 = "abcdefghijklmnopqrstuvwx" // 24 chars, NUL-terminated by the zeroed header

	data := buildGaggiMateSlog(t, 7, 0x3FFF, 250, []gaggiMateTestSample{gaggiMateV7Sample(0)})
	putGaggiMatePhase(data, 0, 0, 0, 0, name24)
	data[gaggiMateSlogPhaseCountOff] = 1

	result, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if got := result.phaseTransitions[0].name; got != name24 {
		t.Fatalf("name = %q, want %q", got, name24)
	}

	// 25 non-NUL bytes fill the whole slot; the name must be exactly 25 bytes
	// and not bleed into the count/exit-reason bytes after the table.
	data2 := buildGaggiMateSlog(t, 7, 0x3FFF, 250, []gaggiMateTestSample{gaggiMateV7Sample(0)})
	for k := 0; k < 25; k++ {
		data2[gaggiMateSlogPhaseOff+4+k] = 'x'
	}
	data2[gaggiMateSlogPhaseCountOff] = 1

	result2, err := gaggiMateParseSlog(data2)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if got := result2.phaseTransitions[0].name; len(got) != 25 {
		t.Fatalf("name length = %d (%q), want exactly 25", len(got), got)
	}
}

// TestGaggiMateSlogToShot_TransitionBeyondSamples checks a transition past the
// last sample is timed from its index and the sample interval.
func TestGaggiMateSlogToShot_TransitionBeyondSamples(t *testing.T) {
	data := buildGaggiMateSlog(t, 7, 0x3FFF, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(250), gaggiMateV7Sample(500),
	})
	putGaggiMatePhase(data, 0, 10, 2, 3, "Extraction")
	data[gaggiMateSlogPhaseCountOff] = 1

	slog, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	dp := gaggiMateSlogToShot(slog, 1)["datapoints"].(map[string]any)
	transitions := dp["phaseTransitions"].([]map[string]any)
	if got := transitions[0]["t"]; got != int64(25) {
		t.Fatalf("t = %v, want 25 (10 * 250 / 100)", got)
	}
}

// TestGaggiMateSlogToShot_V4HasNoPhaseKeys checks a v4 (128-byte header) slog
// exposes neither phase key.
func TestGaggiMateSlogToShot_V4HasNoPhaseKeys(t *testing.T) {
	data := buildSlogFixture(t, 4, 0b101, 3, 4)
	slog, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	if slog.hasPhaseData {
		t.Fatalf("hasPhaseData = true for a v4 slog")
	}
	dp := gaggiMateSlogToShot(slog, 1)["datapoints"].(map[string]any)
	if _, ok := dp["phaseTransitions"]; ok {
		t.Fatalf("phaseTransitions present for a v4 slog")
	}
	if _, ok := dp["finalExitReason"]; ok {
		t.Fatalf("finalExitReason present for a v4 slog")
	}
}

// TestGaggiMateSlogToShot_LegacyZeroReasons checks a v5 file whose phase bytes
// are still zero (pre-1.9.0 firmware) yields an empty slice, not a nil one.
func TestGaggiMateSlogToShot_LegacyZeroReasons(t *testing.T) {
	data := buildGaggiMateSlog(t, 5, 0x1FFF, 250, []gaggiMateTestSample{
		gaggiMateV7Sample(0), gaggiMateV7Sample(1), gaggiMateV7Sample(2),
	})

	slog, err := gaggiMateParseSlog(data)
	if err != nil {
		t.Fatalf("gaggiMateParseSlog: %v", err)
	}
	dp := gaggiMateSlogToShot(slog, 1)["datapoints"].(map[string]any)
	got, ok := dp["phaseTransitions"].([]map[string]any)
	if !ok {
		t.Fatalf("phaseTransitions missing or wrong type: %T", dp["phaseTransitions"])
	}
	if got == nil {
		t.Fatalf("phaseTransitions = nil, want a non-nil empty slice")
	}
	if len(got) != 0 {
		t.Fatalf("len(phaseTransitions) = %d, want 0", len(got))
	}
	if v := dp["finalExitReason"]; v != 0 {
		t.Fatalf("finalExitReason = %v, want 0", v)
	}
}

