package machines

// GaggiMate binary shot-history parser — Go port of
// lib/machines/gaggimate/history.js (format documented there).
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
)

// Field slots in the slog fieldsMask — bit order matches history.js FIELD_BITS.
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
}

type gaggiMateSample struct {
	tickMs            float64
	tt, ct            float64
	tp, cp            float64
	fl, tf            float64
	pf, vf            float64
	v, ev             float64
	pr                float64
	bleScaleConnected bool
	hasTickMs         bool
	hasTT, hasCT      bool
	hasTP, hasCP      bool
	hasFL, hasTF      bool
	hasPF, hasVF      bool
	hasV, hasEV       bool
	hasPR             bool
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
	// Build list of active fields from mask.
	type activeField struct {
		key   string
		scale float64
	}
	var active []activeField
	for _, f := range gaggiMateFieldDefs {
		if fieldsMask&(1<<f.bit) != 0 {
			active = append(active, activeField{f.key, f.scale})
		}
	}
	computedSampleSize := len(active) * 2
	sampleSize := deviceSampleSize
	if sampleSize == 0 {
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
				if off+2 > base+sampleSize {
					break
				}
				raw := int16(binary.LittleEndian.Uint16(data[off : off+2]))
				off += 2
				switch af.key {
				case "t":
					sm.tickMs = float64(raw) * float64(s.sampleIntervalMs)
					sm.hasTickMs = true
				case "tt":
					sm.tt = float64(raw) / af.scale
					sm.hasTT = true
				case "ct":
					sm.ct = float64(raw) / af.scale
					sm.hasCT = true
				case "tp":
					sm.tp = float64(raw) / af.scale
					sm.hasTP = true
				case "cp":
					sm.cp = float64(raw) / af.scale
					sm.hasCP = true
				case "fl":
					sm.fl = float64(raw) / af.scale
					sm.hasFL = true
				case "tf":
					sm.tf = float64(raw) / af.scale
					sm.hasTF = true
				case "pf":
					sm.pf = float64(raw) / af.scale
					sm.hasPF = true
				case "vf":
					sm.vf = float64(raw) / af.scale
					sm.hasVF = true
				case "v":
					sm.v = float64(raw) / af.scale
					sm.hasV = true
				case "ev":
					sm.ev = float64(raw) / af.scale
					sm.hasEV = true
				case "pr":
					sm.pr = float64(raw) / af.scale
					sm.hasPR = true
				case "systemInfo":
					sm.bleScaleConnected = raw&0x04 != 0
					sm.hasSystemInfo = true
				}
			}
			s.samples = append(s.samples, sm)
		}
	}
	return s, nil
}

// gaggiMateSlogToShot converts a parsed slog into a GLP canonical shot map,
// matching toGlpShot() in lib/machines/gaggimate/history.js exactly.
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
	}

	profileName := slog.profileName
	if profileName == "" {
		profileName = slog.profileID
	}
	if profileName == "" {
		profileName = "Unknown"
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
		"datapoints": map[string]any{
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
		},
		"gaggimateExtra": map[string]any{
			"puckFlow":       puckFlow,
			"volumetricFlow": volumetricFlow,
			"puckResistance": puckResistance,
		},
	}
}

// FetchGaggiMateIndex fetches /api/history/index.bin and returns the highest shot ID.
func FetchGaggiMateIndex(ctx context.Context, baseURL string) (int64, error) {
	data, err := httpGetBytes(ctx, baseURL+"/api/history/index.bin", gaggiMateReqTimeout)
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
	// Live-verified per adapter.js (#343): filename must be 6-digit zero-padded.
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
