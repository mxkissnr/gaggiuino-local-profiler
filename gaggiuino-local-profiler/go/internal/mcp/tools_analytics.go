package mcp

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// get_analytics_summary is a compact, Go-computed aggregate over the shot
// history — deliberately not a port of the frontend analytics view. The
// aggregation itself is the pure aggregateAnalytics function below (unit-
// tested against a fixed sample set); getAnalyticsSummary only walks the
// page cursor, maps rows to samples and applies the window.
const (
	defaultAnalyticsDays = 30
	maxTopBeans          = 10
)

type analyticsSummaryInput struct {
	Since     string `json:"since,omitempty" jsonschema:"start of the window, RFC 3339; defaults to 30 days before until"`
	Until     string `json:"until,omitempty" jsonschema:"end of the window (exclusive), RFC 3339; defaults to now"`
	MachineID int64  `json:"machine_id,omitempty" jsonschema:"only shots pulled on this machine id; omit or 0 for all machines"`
	Bean      string `json:"bean,omitempty" jsonschema:"case-insensitive substring of the shot's bean (coffee) name annotation"`
}

type analyticsBeanStat struct {
	Bean         string   `json:"bean" jsonschema:"bean (coffee) name annotation"`
	Shots        int      `json:"shots" jsonschema:"shots with this bean in the window"`
	AverageScore *float64 `json:"average_score,omitempty" jsonschema:"mean score of this bean's scored shots"`
}

type analyticsWeekStat struct {
	WeekStart    string   `json:"week_start" jsonschema:"Monday that starts the week, YYYY-MM-DD UTC"`
	Shots        int      `json:"shots" jsonschema:"shots that week"`
	AverageScore *float64 `json:"average_score,omitempty" jsonschema:"mean score of that week's scored shots"`
}

type analyticsSummaryOutput struct {
	Since            string              `json:"since" jsonschema:"window start, RFC 3339"`
	Until            string              `json:"until" jsonschema:"window end (exclusive), RFC 3339"`
	ShotCount        int                 `json:"shot_count" jsonschema:"number of shots in the window"`
	AverageScore     *float64            `json:"average_score,omitempty" jsonschema:"mean GLP score over the scored shots"`
	MedianScore      *float64            `json:"median_score,omitempty" jsonschema:"median GLP score over the scored shots"`
	AverageRating    *float64            `json:"average_rating,omitempty" jsonschema:"mean 1-5 star rating over the rated shots"`
	AverageRatio     *float64            `json:"average_ratio,omitempty" jsonschema:"mean yield-to-dose ratio (as 1:X) over scored shots"`
	AverageDurationS *float64            `json:"average_duration_s,omitempty" jsonschema:"mean pump time, seconds, over timed shots"`
	TopBeans         []analyticsBeanStat `json:"top_beans" jsonschema:"most-pulled beans, shot count descending"`
	Weekly           []analyticsWeekStat `json:"weekly" jsonschema:"one entry per week that has shots, oldest first"`
}

// analyticsSample is the subset of a shot the aggregation needs. Keeping it
// separate from shots.Shot makes the aggregation a pure function over a
// fixed sample set, independent of the database.
type analyticsSample struct {
	Timestamp int64
	Score     *int
	Rating    *int
	Ratio     *float64
	DurationS *float64
	Bean      string
}

func registerAnalyticsTools(srv *mcpsdk.Server, svc *shots.Service) {
	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:        "get_analytics_summary",
		Title:       "Get analytics summary",
		Description: "Summarise the user's espresso shots over a time window (default the last 30 days): shot count, average and median score, average rating, average ratio and duration, the most-pulled beans with their average score, and a per-week series of shot count and average score. Optionally restrict to one machine and/or a bean-name substring. Use this for trends instead of paging through list_shots.",
		Annotations: readOnlyAnnotations("Get analytics summary"),
		InputSchema: mustSchema[analyticsSummaryInput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in analyticsSummaryInput) (*mcpsdk.CallToolResult, analyticsSummaryOutput, error) {
		out, err := getAnalyticsSummary(svc, in)
		return nil, out, err
	})
}

func getAnalyticsSummary(svc *shots.Service, in analyticsSummaryInput) (analyticsSummaryOutput, error) {
	if svc == nil {
		return analyticsSummaryOutput{}, fmt.Errorf("shot history is not available")
	}
	until := time.Now().UTC()
	if strings.TrimSpace(in.Until) != "" {
		t, err := time.Parse(time.RFC3339, in.Until)
		if err != nil {
			return analyticsSummaryOutput{}, fmt.Errorf("invalid until %q: expected an RFC 3339 date-time such as 2026-01-31T00:00:00Z", in.Until)
		}
		until = t
	}
	since := until.AddDate(0, 0, -defaultAnalyticsDays)
	if strings.TrimSpace(in.Since) != "" {
		t, err := time.Parse(time.RFC3339, in.Since)
		if err != nil {
			return analyticsSummaryOutput{}, fmt.Errorf("invalid since %q: expected an RFC 3339 date-time such as 2026-01-31T00:00:00Z", in.Since)
		}
		since = t
	}
	if !since.Before(until) {
		return analyticsSummaryOutput{}, fmt.Errorf("since must be before until")
	}
	sinceSec, untilSec := since.Unix(), until.Unix()
	bean := strings.ToLower(strings.TrimSpace(in.Bean))

	var samples []analyticsSample
	var cursor shots.Cursor
	for {
		page, err := svc.GetPage(cursor, shots.MaxPageLimit, in.MachineID)
		if err != nil {
			log.Printf("mcp: get_analytics_summary: reading shots: %v", err)
			return analyticsSummaryOutput{}, fmt.Errorf("could not read shot history; try again")
		}
		if len(page.Rows) == 0 {
			break
		}
		oldest := int64(0)
		for _, row := range page.Rows {
			ts, _ := row.Shot["timestamp"].(int64)
			oldest = ts
			if ts < sinceSec || ts >= untilSec {
				continue
			}
			if bean != "" && !strings.Contains(strings.ToLower(annotationString(row.Shot, "coffee")), bean) {
				continue
			}
			samples = append(samples, analyticsSampleOf(row))
		}
		// Pages are newest-first: once the oldest row predates the window (or
		// the history is exhausted) nothing older can match.
		if !page.HasMore || oldest < sinceSec {
			break
		}
		cursor = page.NextCursor
	}

	out := aggregateAnalytics(samples, sinceSec, untilSec)
	out.Since = since.UTC().Format(time.RFC3339)
	out.Until = until.UTC().Format(time.RFC3339)
	return out, nil
}

func analyticsSampleOf(row shots.PageRow) analyticsSample {
	ts, _ := row.Shot["timestamp"].(int64)
	s := analyticsSample{
		Timestamp: ts,
		Score:     row.Score,
		Bean:      annotationString(row.Shot, "coffee"),
	}
	if r, ok := ratingOf(row.Shot); ok {
		s.Rating = &r
	}
	m := shots.ComputeShotMetrics(row.Shot)
	s.Ratio = optionalFloat(m.HasRatio, m.Ratio)
	s.DurationS = optionalFloat(m.DurationSecs > 0, m.DurationSecs)
	return s
}

// aggregateAnalytics is the pure aggregation: a summary over every sample
// whose timestamp falls in [sinceSec, untilSec). Deterministic output:
// top beans by count descending then name ascending, weekly buckets oldest
// first.
func aggregateAnalytics(samples []analyticsSample, sinceSec, untilSec int64) analyticsSummaryOutput {
	out := analyticsSummaryOutput{
		TopBeans: []analyticsBeanStat{},
		Weekly:   []analyticsWeekStat{},
	}
	var (
		scores                           []int
		ratingSum, ratioSum, durSum      float64
		ratingN, ratioN, durN            int
		beanShots                        = map[string]int{}
		beanScoreSum, beanScoreN         = map[string]int{}, map[string]int{}
		weekShots                        = map[int64]int{}
		weekScoreSum, weekScoreN         = map[int64]int{}, map[int64]int{}
	)
	for _, s := range samples {
		if s.Timestamp < sinceSec || s.Timestamp >= untilSec {
			continue
		}
		out.ShotCount++
		if s.Score != nil {
			scores = append(scores, *s.Score)
		}
		if s.Rating != nil {
			ratingSum += float64(*s.Rating)
			ratingN++
		}
		if s.Ratio != nil {
			ratioSum += *s.Ratio
			ratioN++
		}
		if s.DurationS != nil {
			durSum += *s.DurationS
			durN++
		}
		if s.Bean != "" {
			beanShots[s.Bean]++
			if s.Score != nil {
				beanScoreSum[s.Bean] += *s.Score
				beanScoreN[s.Bean]++
			}
		}
		week := weekStartSeconds(s.Timestamp)
		weekShots[week]++
		if s.Score != nil {
			weekScoreSum[week] += *s.Score
			weekScoreN[week]++
		}
	}
	if len(scores) > 0 {
		out.AverageScore = ptrFloat(meanInts(scores))
		out.MedianScore = ptrFloat(medianInts(scores))
	}
	if ratingN > 0 {
		out.AverageRating = ptrFloat(ratingSum / float64(ratingN))
	}
	if ratioN > 0 {
		out.AverageRatio = ptrFloat(ratioSum / float64(ratioN))
	}
	if durN > 0 {
		out.AverageDurationS = ptrFloat(durSum / float64(durN))
	}

	// Top beans: count descending, then name ascending for determinism.
	type beanCount struct {
		name  string
		count int
	}
	beans := make([]beanCount, 0, len(beanShots))
	for name, count := range beanShots {
		beans = append(beans, beanCount{name: name, count: count})
	}
	sort.Slice(beans, func(i, j int) bool {
		if beans[i].count != beans[j].count {
			return beans[i].count > beans[j].count
		}
		return beans[i].name < beans[j].name
	})
	for i, b := range beans {
		if i >= maxTopBeans {
			break
		}
		stat := analyticsBeanStat{Bean: b.name, Shots: b.count}
		if beanScoreN[b.name] > 0 {
			stat.AverageScore = ptrFloat(float64(beanScoreSum[b.name]) / float64(beanScoreN[b.name]))
		}
		out.TopBeans = append(out.TopBeans, stat)
	}

	// Weekly series, oldest first.
	weeks := make([]int64, 0, len(weekShots))
	for week := range weekShots {
		weeks = append(weeks, week)
	}
	sort.Slice(weeks, func(i, j int) bool { return weeks[i] < weeks[j] })
	for _, week := range weeks {
		stat := analyticsWeekStat{
			WeekStart: time.Unix(week, 0).UTC().Format("2006-01-02"),
			Shots:     weekShots[week],
		}
		if weekScoreN[week] > 0 {
			stat.AverageScore = ptrFloat(float64(weekScoreSum[week]) / float64(weekScoreN[week]))
		}
		out.Weekly = append(out.Weekly, stat)
	}
	return out
}

// weekStartSeconds returns the Unix time of Monday 00:00 UTC of the week
// containing ts.
func weekStartSeconds(ts int64) int64 {
	t := time.Unix(ts, 0).UTC()
	offsetDays := (int(t.Weekday()) + 6) % 7 // Monday == 0
	start := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -offsetDays)
	return start.Unix()
}

func meanInts(values []int) float64 {
	var sum int
	for _, v := range values {
		sum += v
	}
	return float64(sum) / float64(len(values))
}

func medianInts(values []int) float64 {
	sorted := make([]int, len(values))
	copy(sorted, values)
	sort.Ints(sorted)
	n := len(sorted)
	if n%2 == 1 {
		return float64(sorted[n/2])
	}
	return (float64(sorted[n/2-1]) + float64(sorted[n/2])) / 2
}

func ptrFloat(v float64) *float64 {
	return &v
}
