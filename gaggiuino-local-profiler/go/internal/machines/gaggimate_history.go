package machines

// GaggiMate binary shot-history parser.
// HTTP endpoints:
//   GET /api/history/index.bin  → fixed-header + entry records
//   GET /api/history/NNNNNN.slog (6-digit zero-padded) → sample stream

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

const (
	gaggiMateIndexMagic    = uint32(0x58444953) // 'SIDX' little-endian
	gaggiMateSlogMagic     = uint32(0x544F4853) // 'SHOT' little-endian
	gaggiMateIndexHdrBytes = 32
	gaggiMateIndexEntBytes = 128
	gaggiMateSlogHdrV4     = 128
	gaggiMateSlogHdrV5     = 512
	gaggiMateReqTimeout    = 10 * time.Second

	// gaggiMateIndexMaxEntries generously bounds how many shots a real
	// device's onboard flash storage would ever legitimately hold --
	// 20,000 espresso shots is already far beyond any home machine's
	// realistic lifetime history. Used only to cap the index.bin fetch
	// (#991); gaggiMateIndexMax's own entryCount/maxByLen math still
	// governs how many entries actually get parsed out of whatever bytes
	// come back.
	gaggiMateIndexMaxEntries = 20_000
	// gaggiMateIndexMaxBytes caps the index.bin response well below the
	// general 8MB .slog cap: header + entries, at the fixed 128-byte
	// entry size (~2.44MB) -- an index that size dwarfs anything
	// gaggiMateIndexMaxEntries above would ever legitimately produce.
	gaggiMateIndexMaxBytes = gaggiMateIndexHdrBytes + gaggiMateIndexMaxEntries*gaggiMateIndexEntBytes
)

// v5+ slog header phase-transition slots, per upstream shot_log_format.h
// v1.9.0. Each 29-byte entry is a uint16 sample index, uint8 phase number,
// uint8 exit reason (why the previous phase ended), then a 25-byte
// NUL-padded phase name.
const (
	gaggiMateSlogPhaseOff      = 110
	gaggiMateSlogPhaseSize     = 29
	gaggiMateSlogPhaseMax      = 12
	gaggiMateSlogPhaseCountOff = 458
	gaggiMateSlogExitReasonOff = 459
)

// Field slots in the slog fieldsMask — bit order matches the device's FIELD_BITS.
// scale=0 marks special handling (tick multiplied, not divided; systemInfo bitfield).
type gaggiMateFieldDef struct {
	bit   uint
	key   string
	scale float64
}

var gaggiMateFieldDefs = []gaggiMateFieldDef{
	{0, "t", 0},
	{1, "tt", 10},
	{2, "ct", 10},
	{3, "tp", 10},
	{4, "cp", 10},
	{5, "fl", 100},
	{6, "tf", 100},
	{7, "pf", 100},
	{8, "vf", 100},
	{9, "v", 10},
	{10, "ev", 10},
	{11, "pr", 100},
	{12, "systemInfo", 0},
	{13, "wp", 10},
}

type gaggiMateSlogResult struct {
	version          uint8
	sampleIntervalMs uint16
	durationMs       uint32
	timestamp        uint32
	profileID        string
	profileName      string
	finalWeight      float64
	samples          []gaggiMateSample
	phaseTransitions []gaggiMatePhaseTransition
	finalExitReason  int
	hasPhaseData     bool
}

// gaggiMatePhaseTransition is one v5+ header phase transition. sampleIndex
// indexes the sample stream; reason explains why the phase named here ended.
type gaggiMatePhaseTransition struct {
	sampleIndex int
	phaseNumber int
	reason      int
	name        string
}

type gaggiMateSample struct {
	tickMs            float64
	tt, ct            float64
	tp, cp            float64
	fl, tf            float64
	pf, vf            float64
	v, ev             float64
	pr, wp            float64
	bleScaleConnected bool
	hasTickMs         bool
	hasTT, hasCT      bool
	hasTP, hasCP      bool
	hasFL, hasTF      bool
	hasPF, hasVF      bool
	hasV, hasEV       bool
	hasPR, hasWP      bool
	hasSystemInfo     bool
}

// gaggiMateCString reads a null-terminated UTF-8 string from data[offset:offset+maxLen].
func gaggiMateCString(data []byte, offset, maxLen int) string {
	end := offset
	limit := offset + maxLen
	if limit > len(data) {
		limit = len(data)
	}
	for end < limit && data[end] != 0 {
		end++
	}
	return string(data[offset:end])
}

// gaggiMateIndexMax parses index.bin and returns the highest shot ID present.
// Returns 0 when the index is empty. Matches getLatestShotId()'s behavior of
// NOT filtering deleted entries (they may 404 later and get blocklisted).
func gaggiMateIndexMax(data []byte) (int64, error) {
	if len(data) < gaggiMateIndexHdrBytes {
		return 0, fmt.Errorf("gaggimate: index.bin too short (%d bytes)", len(data))
	}
	if magic := binary.LittleEndian.Uint32(data[0:4]); magic != gaggiMateIndexMagic {
		return 0, fmt.Errorf("gaggimate: index.bin bad magic %08x (want %08x)", magic, gaggiMateIndexMagic)
	}
	entrySize := int(binary.LittleEndian.Uint16(data[6:8]))
	if entrySize == 0 {
		entrySize = gaggiMateIndexEntBytes
	}
	entryCount := int(binary.LittleEndian.Uint32(data[8:12]))
	maxByLen := (len(data) - gaggiMateIndexHdrBytes) / entrySize
	count := entryCount
	if entryCount == 0 || maxByLen < count {
		count = maxByLen
	}
	var maxID int64
	for i := 0; i < count; i++ {
		off := gaggiMateIndexHdrBytes + i*entrySize
		if off+4 > len(data) {
			break
		}
		id := int64(binary.LittleEndian.Uint32(data[off : off+4]))
		if id > maxID {
			maxID = id
		}
	}
	return maxID, nil
}

// gaggiMateParseSlog decodes a .slog binary blob into its sample stream.
func gaggiMateParseSlog(data []byte) (*gaggiMateSlogResult, error) {
	if len(data) < 8 {
		return nil, fmt.Errorf("gaggimate: .slog too short (%d bytes)", len(data))
	}
	if magic := binary.LittleEndian.Uint32(data[0:4]); magic != gaggiMateSlogMagic {
		return nil, fmt.Errorf("gaggimate: .slog bad magic %08x (want %08x)", magic, gaggiMateSlogMagic)
	}
	s := &gaggiMateSlogResult{}
	s.version = data[4]
	deviceSampleSize := int(data[5])

	hdrSize := int(binary.LittleEndian.Uint16(data[6:8]))
	if hdrSize == 0 {
		if s.version >= 5 {
			hdrSize = gaggiMateSlogHdrV5
		} else {
			hdrSize = gaggiMateSlogHdrV4
		}
	}
	if len(data) < 28 {
		return nil, fmt.Errorf("gaggimate: .slog header truncated at %d bytes", len(data))
	}

	s.sampleIntervalMs = binary.LittleEndian.Uint16(data[8:10])
	if s.sampleIntervalMs == 0 {
		s.sampleIntervalMs = 100
	}
	fieldsMask := binary.LittleEndian.Uint32(data[12:16])
	sampleCountHdr := int(binary.LittleEndian.Uint32(data[16:20]))
	s.durationMs = binary.LittleEndian.Uint32(data[20:24])
	s.timestamp = binary.LittleEndian.Uint32(data[24:28])
	if len(data) >= 60 {
		s.profileID = gaggiMateCString(data, 28, 32)
	}
	if len(data) >= 108 {
		s.profileName = gaggiMateCString(data, 60, 48)
	}
	if len(data) >= 110 {
		s.finalWeight = float64(binary.LittleEndian.Uint16(data[108:110])) / 10
	}
	// v5+ headers reserve the phase-transition table and a final exit reason.
	// A reason of 0 means unknown/legacy: pre-1.9.0 firmware wrote 0 into the
	// then-reserved bytes. brewDelayMs @460 is deliberately not read.
	if s.version >= 5 && hdrSize >= gaggiMateSlogHdrV5 && len(data) > gaggiMateSlogExitReasonOff {
		s.hasPhaseData = true
		count := int(data[gaggiMateSlogPhaseCountOff])
		if count > gaggiMateSlogPhaseMax {
			count = gaggiMateSlogPhaseMax
		}
		for i := 0; i < count; i++ {
			off := gaggiMateSlogPhaseOff + i*gaggiMateSlogPhaseSize
			s.phaseTransitions = append(s.phaseTransitions, gaggiMatePhaseTransition{
				sampleIndex: int(binary.LittleEndian.Uint16(data[off : off+2])),
				phaseNumber: int(data[off+2]),
				reason:      int(data[off+3]),
				name:        gaggiMateCString(data, off+4, 25),
			})
		}
		s.finalExitReason = int(data[gaggiMateSlogExitReasonOff])
	}
	// Build list of active fields from mask, in bit order. Each set bit
	// occupies a fixed width in the sample record: v6 widened the elapsed-ms
	// field (bit 0) to uint32, and an unknown bit (a field this parser does
	// not know yet) still consumes its 2 bytes so it cannot shift the fields
	// that follow (#1397).
	type activeField struct {
		key   string
		scale float64
		width int
	}
	var active []activeField
	computedSampleSize := 0
	for bit := uint(0); bit < 32; bit++ {
		if fieldsMask&(1<<bit) == 0 {
			continue
		}
		width := 2
		if bit == 0 && s.version >= 6 {
			width = 4
		}
		computedSampleSize += width
		af := activeField{width: width}
		for _, f := range gaggiMateFieldDefs {
			if f.bit == bit {
				af.key = f.key
				af.scale = f.scale
				break
			}
		}
		active = append(active, af)
	}
	// deviceSampleSize is a single attacker-controlled byte (data[5]).
	// Trusting a value smaller than what the active fieldsMask actually
	// needs turns available/maxSamples below into a huge, disproportionate
	// preallocation (#992: data[5]=1 on an 8MB body preallocates ~1GB).
	// There's no legitimate reason for the device to report less than
	// computedSampleSize -- that many bytes are the minimum needed to hold
	// one sample of every active field -- so floor at computedSampleSize
	// rather than trusting anything under it; 0 (unset) and any larger,
	// legitimately-padded value both pass through unchanged, exactly as
	// before.
	sampleSize := deviceSampleSize
	if sampleSize < computedSampleSize {
		sampleSize = computedSampleSize
	}

	if sampleSize > 0 && hdrSize < len(data) {
		dataStart := hdrSize
		available := (len(data) - dataStart) / sampleSize
		maxSamples := sampleCountHdr
		if sampleCountHdr == 0 || available < maxSamples {
			maxSamples = available
		}
		s.samples = make([]gaggiMateSample, 0, maxSamples)
		for i := 0; i < maxSamples; i++ {
			base := dataStart + i*sampleSize
			if base+sampleSize > len(data) {
				break
			}
			var sm gaggiMateSample
			off := base
			for _, af := range active {
				if off+af.width > base+sampleSize {
					break
				}
				// Fields whose upstream type is uint16 (tt, ct, tp, cp, v,
				// ev, pr, wp) are read unsigned; fl, tf, pf, vf stay int16.
				switch af.key {
				case "t":
					if af.width == 4 {
						sm.tickMs = float64(binary.LittleEndian.Uint32(data[off : off+4]))
					} else {
						sm.tickMs = float64(int16(binary.LittleEndian.Uint16(data[off:off+2]))) * float64(s.sampleIntervalMs)
					}
					sm.hasTickMs = true
				case "tt":
					sm.tt = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasTT = true
				case "ct":
					sm.ct = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasCT = true
				case "tp":
					sm.tp = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasTP = true
				case "cp":
					sm.cp = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasCP = true
				case "fl":
					sm.fl = float64(int16(binary.LittleEndian.Uint16(data[off:off+2]))) / af.scale
					sm.hasFL = true
				case "tf":
					sm.tf = float64(int16(binary.LittleEndian.Uint16(data[off:off+2]))) / af.scale
					sm.hasTF = true
				case "pf":
					sm.pf = float64(int16(binary.LittleEndian.Uint16(data[off:off+2]))) / af.scale
					sm.hasPF = true
				case "vf":
					sm.vf = float64(int16(binary.LittleEndian.Uint16(data[off:off+2]))) / af.scale
					sm.hasVF = true
				case "v":
					sm.v = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasV = true
				case "ev":
					sm.ev = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasEV = true
				case "pr":
					sm.pr = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasPR = true
				case "wp":
					sm.wp = float64(binary.LittleEndian.Uint16(data[off:off+2])) / af.scale
					sm.hasWP = true
				case "systemInfo":
					sm.bleScaleConnected = int16(binary.LittleEndian.Uint16(data[off:off+2]))&0x04 != 0
					sm.hasSystemInfo = true
				}
				off += af.width
			}
			s.samples = append(s.samples, sm)
		}
	}
	return s, nil
}

// gaggiMateSlogToShot converts a parsed slog into a GLP canonical shot map.
func gaggiMateSlogToShot(slog *gaggiMateSlogResult, nativeID int64) map[string]any {
	n := len(slog.samples)
	timeInShot := make([]int64, n)
	pressure := make([]int64, n)
	temperature := make([]int64, n)
	targetTemperature := make([]int64, n)
	targetPressure := make([]int64, n)
	targetPumpFlow := make([]int64, n)
	shotWeight := make([]int64, n)
	weightFlow := make([]int64, n) // always 0 for GaggiMate (no scale-derived flow)
	pumpFlow := make([]int64, n)
	// gaggimateExtra: nullable per-sample arrays (null when field absent from slog)
	puckFlow := make([]any, n)
	volumetricFlow := make([]any, n)
	puckResistance := make([]any, n)
	waterPumped := make([]any, n)
	var bleScaleConnected bool // true if any sample had BLE scale data

	for i, sm := range slog.samples {
		var tickMs float64
		if sm.hasTickMs {
			tickMs = sm.tickMs
		}
		timeInShot[i] = int64(math.Round(tickMs / 100))

		var cp float64
		if sm.hasCP {
			cp = sm.cp
		}
		pressure[i] = int64(math.Round(cp * 10))

		var ct float64
		if sm.hasCT {
			ct = sm.ct
		}
		temperature[i] = int64(math.Round(ct * 10))

		var tt float64
		if sm.hasTT {
			tt = sm.tt
		}
		targetTemperature[i] = int64(math.Round(tt * 10))

		// shotWeight: use real BLE scale weight (v) when bleScaleConnected;
		// fall back to volumetric estimate (ev) when no scale was connected.
		var wt float64
		if sm.hasSystemInfo && sm.bleScaleConnected && sm.hasV {
			wt = sm.v
			bleScaleConnected = true
		} else if sm.hasEV {
			wt = sm.ev
		} else if sm.hasV {
			wt = sm.v
		}
		shotWeight[i] = int64(math.Round(wt * 10))

		var fl float64
		if sm.hasFL {
			fl = sm.fl
		}
		pumpFlow[i] = int64(math.Round(fl * 10))

		var tp float64
		if sm.hasTP {
			tp = sm.tp
		}
		targetPressure[i] = int64(math.Round(tp * 10))

		var tf float64
		if sm.hasTF {
			tf = sm.tf
		}
		targetPumpFlow[i] = int64(math.Round(tf * 10))

		if sm.hasPF {
			puckFlow[i] = sm.pf
		}
		if sm.hasVF {
			volumetricFlow[i] = sm.vf
		}
		if sm.hasPR {
			puckResistance[i] = sm.pr
		}
		if sm.hasWP {
			waterPumped[i] = sm.wp
		}
	}

	profileName := slog.profileName
	if profileName == "" {
		profileName = slog.profileID
	}
	if profileName == "" {
		profileName = "Unknown"
	}

	datapoints := map[string]any{
		"timeInShot":        timeInShot,
		"pressure":          pressure,
		"temperature":       temperature,
		"targetTemperature": targetTemperature,
		"targetPressure":    targetPressure,
		"targetPumpFlow":    targetPumpFlow,
		"shotWeight":        shotWeight,
		"weightFlow":        weightFlow,
		"pumpFlow":          pumpFlow,
		// bleScaleConnected gates the chart label: true = real BLE scale,
		// false = volumetric estimate (ev). Stored in datapoints so
		// mapShotDatapoints can see it without the top-level shot context.
		"bleScaleConnected": bleScaleConnected,
	}
	if slog.hasPhaseData {
		// reason on entry i is why the previous phase ended; finalExitReason is
		// why the shot ended. t is deciseconds, the same unit as timeInShot.
		transitions := make([]map[string]any, 0, len(slog.phaseTransitions))
		for _, tr := range slog.phaseTransitions {
			var t int64
			if tr.sampleIndex < n {
				t = timeInShot[tr.sampleIndex]
			} else {
				t = int64(math.Round(float64(tr.sampleIndex) * float64(slog.sampleIntervalMs) / 100))
			}
			transitions = append(transitions, map[string]any{
				"t":      t,
				"phase":  tr.phaseNumber,
				"name":   tr.name,
				"reason": tr.reason,
			})
		}
		datapoints["phaseTransitions"] = transitions
		datapoints["finalExitReason"] = slog.finalExitReason
	}

	return map[string]any{
		"id":        nativeID,
		"timestamp": int64(slog.timestamp),
		// durationMs is raw milliseconds; GLP convention is deciseconds (/100 not /10).
		"duration":             int64(math.Round(float64(slog.durationMs) / 100)),
		"profileName":          profileName,
		"machineType":          "gaggimate",
		"gaggimateFinalWeight": slog.finalWeight,
		"gaggimateBleScale":    bleScaleConnected,
		"datapoints":           datapoints,
		"gaggimateExtra": map[string]any{
			"puckFlow":       puckFlow,
			"volumetricFlow": volumetricFlow,
			"puckResistance": puckResistance,
			"waterPumped":    waterPumped,
		},
	}
}

// FetchGaggiMateIndex fetches /api/history/index.bin and returns the highest shot ID.
func FetchGaggiMateIndex(ctx context.Context, baseURL string) (int64, error) {
	data, err := httpGetBytesCapped(ctx, baseURL+"/api/history/index.bin", gaggiMateReqTimeout, gaggiMateIndexMaxBytes)
	if err != nil {
		return 0, err
	}
	return gaggiMateIndexMax(data)
}

// FetchGaggiMateShot fetches /api/history/{nativeID:06d}.slog from baseURL,
// parses it, and returns the GLP shot map. The HTTP status is returned
// separately so callers can distinguish 404 (permanently missing) from
// transport errors, matching the Gaggiuino sync path in sync.go.
func FetchGaggiMateShot(ctx context.Context, baseURL string, nativeID int64) (map[string]any, int, error) {
	// Live-verified (#343): filename must be 6-digit zero-padded.
	url := fmt.Sprintf("%s/api/history/%06d.slog", baseURL, nativeID)
	ctx, cancel := context.WithTimeout(ctx, gaggiMateReqTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("gaggimate: GET %s returned HTTP %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	slog, err := gaggiMateParseSlog(data)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return gaggiMateSlogToShot(slog, nativeID), resp.StatusCode, nil
}
