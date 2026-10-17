package shots

import (
	stdjson "encoding/json"
	"fmt"
	"testing"

	json "github.com/goccy/go-json"
)

// decodeFloatArrayPtrPath is decodeFloatArray as it was before the #1616
// fast path: always the []*float64 decode, then the lenient []any one.
func decodeFloatArrayPtrPath(r stdjson.RawMessage) []float64 {
	if len(r) == 0 {
		return nil
	}
	var ptrs []*float64
	if err := json.Unmarshal(r, &ptrs); err == nil {
		out := make([]float64, 0, len(ptrs))
		for _, p := range ptrs {
			if p != nil {
				out = append(out, *p)
			}
		}
		return out
	}
	var anyArr []any
	if err := json.Unmarshal(r, &anyArr); err != nil {
		return nil
	}
	return floatSlice(anyArr)
}

// TestDecodeFloatArray_FastPathMatchesPtrPath (#1616) pins that the
// allocation-free fast path returns exactly what the pointer path did for
// every input shape a stored curve series can take.
func TestDecodeFloatArray_FastPathMatchesPtrPath(t *testing.T) {
	for _, in := range []string{
		``, `[]`, ` [ ] `, `null`, ` null `, `[1,2,3]`, `[0, -1.5, 1e3, 2.25e-2]`,
		`[1,null,3]`, `[null]`, `[1,"2",3]`, `["null"]`, `[true,1]`, `[[1],2]`,
		`{"a":1}`, `5`, `"x"`, `[1,2`, `[1e400]`, `[-0]`, `[930,931,0,932]`,
	} {
		got := decodeFloatArray(stdjson.RawMessage(in))
		want := decodeFloatArrayPtrPath(stdjson.RawMessage(in))
		if fmt.Sprintf("%#v", got) != fmt.Sprintf("%#v", want) {
			t.Errorf("decodeFloatArray(%q) = %#v, ptr path %#v", in, got, want)
		}
	}
}

// TestChartStats_MatchesSeparateFunctions (#1616) pins that the one-split
// chartStats returns exactly hasChartSeries and tempStabilityDev.
func TestChartStats_MatchesSeparateFunctions(t *testing.T) {
	inputs := []any{
		nil, 5, map[string]any{}, map[string]any{"pressure": []any{1.0}, "temperature": []any{930.0}, "targetTemperature": []any{935.0}},
	}
	for _, raw := range []string{
		``, `null`, `{}`, `[]`, `{"pressure":[]}`, `{"pressure":[1]}`, `{"timeInShot":[0,1]}`, `{"pressure":null}`,
		`{"temperature":[930,0,931],"targetTemperature":[935,935,0]}`, `{"temperature":[930],"targetTemperature":[0]}`,
		`{"temperature":[930,null,940],"targetTemperature":[935,935,935],"timeInShot":[1]}`, `{"pressure": [ ] }`, `{bad`,
	} {
		inputs = append(inputs, stdjson.RawMessage(raw), []byte(raw))
	}
	for _, in := range inputs {
		has, dev := chartStats(in)
		wantDev := tempStabilityDev(in)
		if has != hasChartSeries(in) || fmt.Sprint(deref(dev)) != fmt.Sprint(deref(wantDev)) || (dev == nil) != (wantDev == nil) {
			t.Errorf("chartStats(%T %v) = %v, %v; want %v, %v", in, in, has, deref(dev), hasChartSeries(in), deref(wantDev))
		}
	}
}

func deref(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
