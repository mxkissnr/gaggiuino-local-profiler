package mcp

import (
	"context"
	"fmt"
	"log"
	"sort"

	"github.com/google/jsonschema-go/jsonschema"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// The developer tools are a third, opt-in slice (Deps.AllowDeveloperTools):
// read-only analysis exposing full-resolution or bulk data a model should not
// get by default. get_shot_raw returns one shot's every recorded series
// without downsampling.
const maxRawSamples = 3000

type getShotRawInput struct {
	ID int64 `json:"id" jsonschema:"the shot id to fetch in full resolution; use list_shots to find ids"`
}

type rawSeries struct {
	Key    string    `json:"key" jsonschema:"the Gaggiuino datapoints key, verbatim"`
	Unit   string    `json:"unit" jsonschema:"the value's unit: bar, ml/s, g/s, g, C, ml, or empty when unknown"`
	Values []float64 `json:"values" jsonschema:"full-resolution samples, aligned with time_s and in whole units"`
}

type getShotRawOutput struct {
	ShotID      int64       `json:"shot_id" jsonschema:"the shot's stable id"`
	SampleCount int         `json:"sample_count" jsonschema:"number of samples in time_s and each series"`
	TimeS       []float64   `json:"time_s" jsonschema:"full-resolution time axis, seconds"`
	Series      []rawSeries `json:"series" jsonschema:"every recorded datapoint series, sorted by key"`
	Truncated   bool        `json:"truncated" jsonschema:"true when the shot exceeded 3000 samples and the arrays were cut"`
}

// rawUnits maps the known Gaggiuino datapoint keys to their unit. Anything
// else (a firmware key this slice does not know) gets an empty unit rather
// than a guess.
var rawUnits = map[string]string{
	"pressure":          "bar",
	"targetPressure":    "bar",
	"pumpFlow":          "ml/s",
	"targetPumpFlow":    "ml/s",
	"weightFlow":        "g/s",
	"shotWeight":        "g",
	"weight":            "g",
	"temperature":       "C",
	"targetTemperature": "C",
	"waterPumped":       "ml",
}

func registerDeveloperTools(srv *mcpsdk.Server, deps Deps) {
	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "get_shot_raw",
		Title:        "Get raw shot data",
		Description:  "Fetch one shot's full-resolution brew data: every recorded Gaggiuino datapoint series (pressure, flow, weight, temperature, targets, ...) without downsampling, for debugging and scoring analysis. The payload is large — prefer get_shot with include_curve for normal questions.",
		Annotations:  readOnlyAnnotations("Get raw shot data"),
		InputSchema:  getShotRawInputSchema(),
		OutputSchema: mustSchema[getShotRawOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in getShotRawInput) (*mcpsdk.CallToolResult, getShotRawOutput, error) {
		out, err := getShotRaw(deps.Shots, in)
		return nil, out, err
	})
}

func getShotRawInputSchema() *jsonschema.Schema {
	s := mustSchema[getShotRawInput]()
	if p := schemaProp(s, "id"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
	}
	return s
}

func getShotRaw(svc *shots.Service, in getShotRawInput) (getShotRawOutput, error) {
	if svc == nil {
		return getShotRawOutput{}, fmt.Errorf("shot history is not available")
	}
	shot, err := svc.GetByID(in.ID)
	if err != nil {
		log.Printf("mcp: get_shot_raw %d: %v", in.ID, err)
		return getShotRawOutput{}, fmt.Errorf("could not read shot %d; try again", in.ID)
	}
	if shot == nil {
		return getShotRawOutput{}, fmt.Errorf("shot %d not found; use list_shots to find ids", in.ID)
	}
	d := shots.DatapointsMap(shot)
	timeS := scaleTenths(toFloats(d["timeInShot"]))
	if len(timeS) == 0 {
		return getShotRawOutput{}, fmt.Errorf("shot %d has no recorded brew data", in.ID)
	}

	// Every other key with a non-empty numeric array is a series; timeInShot
	// above is the shared time axis.
	keys := make([]string, 0, len(d))
	for k, v := range d {
		if k == "timeInShot" || len(toFloats(v)) == 0 {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	series := make([]rawSeries, 0, len(keys))
	for _, k := range keys {
		series = append(series, rawSeries{Key: k, Unit: rawUnits[k], Values: scaleTenths(toFloats(d[k]))})
	}

	truncated := len(timeS) > maxRawSamples
	if truncated {
		timeS = timeS[:maxRawSamples]
	}
	for i := range series {
		if len(series[i].Values) > maxRawSamples {
			series[i].Values = series[i].Values[:maxRawSamples]
		}
	}
	return getShotRawOutput{
		ShotID:      intField(shot, "id"),
		SampleCount: len(timeS),
		TimeS:       timeS,
		Series:      series,
		Truncated:   truncated,
	}, nil
}
