package backup

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file builds the anonymised shot donation file (GET /api/shot-donation,
// #2220). A user posts it themselves on the GLP Discord to help calibrate the
// shot score; GLP sends nothing anywhere.
//
// Privacy contract: the file is built ONLY from the typed structs and the
// allow-lists below, never by copying a map from a shot, profile, annotation
// or library entry. It never holds a name (profile, phase, bean, roaster,
// grinder, machine), a note or any other free text, a photo, a timestamp, a
// shot or machine id, a host, a setting or a token. Shot keys and the
// donation id are HMACs under a random per-install secret (kv
// donation_secret) that is neither exported in a backup nor restored.

const (
	donationFormat          = "glp-shot-donation"
	donationVersion         = 1
	donationSecretKey       = "donation_secret"
	donationRateLimitPerMin = 20
)

// donationSeriesKeys are the datapoint series copied into the file, each
// sanitised to numbers or null with its index alignment kept.
var donationSeriesKeys = []string{
	"timeInShot", "pressure", "pumpFlow", "weightFlow", "shotWeight", "weight",
	"temperature", "targetTemperature", "targetPressure", "targetPumpFlow",
	"waterPumped", "phaseIndex",
}

// donationDrinkTypes are the built-in menu drink ids. A user-made menu item
// (id "m_<ms>") is written as "other", since its name is free text.
var donationDrinkTypes = map[string]bool{
	"espresso": true, "ristretto": true, "lungo": true,
	"cappuccino": true, "latte": true, "flat_white": true,
}

// donationTasteTags is the allow-list of the taste tags a shot can carry (#1957).
var donationTasteTags = map[string]bool{
	"sour": true, "bitter": true, "balanced": true, "thin": true,
}

type donationFile struct {
	Format     string         `json:"format"`
	Version    int            `json:"version"`
	AppVersion string         `json:"appVersion"`
	DonationID string         `json:"donationId"`
	Shots      []donationShot `json:"shots"`
}

type donationShot struct {
	Key         string             `json:"key"`
	MachineType *string            `json:"machineType"`
	ProfileKey  *string            `json:"profileKey"`
	Profile     *donationProfile   `json:"profile"`
	Datapoints  map[string]any     `json:"datapoints"`
	Annotation  donationAnnotation `json:"annotation"`
	Scores      map[string]*int    `json:"scores"`
}

type donationAnnotation struct {
	Rating      int      `json:"rating"`
	Dose        *float64 `json:"dose"`
	Yield       *float64 `json:"yield"`
	TDS         *float64 `json:"tds"`
	DrinkType   *string  `json:"drinkType"`
	TasteTag    *string  `json:"tasteTag"`
	RoastLevel  *string  `json:"roastLevel"`
	BeanAgeDays *int     `json:"beanAgeDays"`
}

// donationProfile is the profile structure without any name or id. Its fields
// are declared in alphabetical JSON-name order, so json.Marshal of it equals
// a sorted-key JSON; the profile key hashes exactly that encoding.
type donationProfile struct {
	GlobalStopConditions *donationGlobalStop `json:"globalStopConditions,omitempty"`
	Phases               []donationPhase     `json:"phases"`
	Recipe               *donationRecipe     `json:"recipe,omitempty"`
	WaterTemperature     float64             `json:"waterTemperature,omitempty"`
}

type donationPhase struct {
	Restriction      float64           `json:"restriction,omitempty"`
	Skip             bool              `json:"skip,omitempty"`
	StopConditions   donationPhaseStop `json:"stopConditions"`
	Target           donationTarget    `json:"target"`
	Type             string            `json:"type,omitempty"`
	WaterTemperature float64           `json:"waterTemperature,omitempty"`
}

type donationTarget struct {
	Curve  string  `json:"curve,omitempty"`
	End    float64 `json:"end,omitempty"`
	Start  float64 `json:"start,omitempty"`
	Time   float64 `json:"time,omitempty"`
	Volume float64 `json:"volume,omitempty"`
}

type donationPhaseStop struct {
	FlowAbove          float64 `json:"flowAbove,omitempty"`
	FlowBelow          float64 `json:"flowBelow,omitempty"`
	PressureAbove      float64 `json:"pressureAbove,omitempty"`
	PressureBelow      float64 `json:"pressureBelow,omitempty"`
	Time               float64 `json:"time,omitempty"`
	WaterPumpedInPhase float64 `json:"waterPumpedInPhase,omitempty"`
	Weight             float64 `json:"weight,omitempty"`
}

type donationGlobalStop struct {
	Time        float64 `json:"time,omitempty"`
	WaterPumped float64 `json:"waterPumped,omitempty"`
	Weight      float64 `json:"weight,omitempty"`
}

type donationRecipe struct {
	CoffeeIn  float64 `json:"coffeeIn,omitempty"`
	CoffeeOut float64 `json:"coffeeOut,omitempty"`
	Ratio     float64 `json:"ratio,omitempty"`
}

// donationNumPtr returns v rounded to 2 decimals when it is a finite
// float64, else nil.
func donationNumPtr(v any) *float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	r := math.Round(f*100) / 100
	return &r
}

// donationSeries keeps a series' length and turns every element that is not
// a finite float64 into null, so series stay index-aligned.
func donationSeries(v any) []any {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]any, len(list))
	for i, e := range list {
		if f, ok := e.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			out[i] = f
		}
	}
	return out
}

// donationDatapoints copies only the allow-listed series and the numeric
// phase-transition fields; a transition's free-text name is never copied.
func donationDatapoints(shot shots.Shot) map[string]any {
	d := shots.DatapointsMap(shot)
	out := map[string]any{}
	for _, key := range donationSeriesKeys {
		if s := donationSeries(d[key]); s != nil {
			out[key] = s
		}
	}
	if list, ok := d["phaseTransitions"].([]any); ok {
		transitions := make([]any, 0, len(list))
		for _, e := range list {
			m, _ := e.(map[string]any)
			transitions = append(transitions, map[string]any{
				"t":      donationNumPtr(m["t"]),
				"phase":  donationNumPtr(m["phase"]),
				"reason": donationNumPtr(m["reason"]),
			})
		}
		out["phaseTransitions"] = transitions
	}
	if p := donationNumPtr(d["finalExitReason"]); p != nil {
		out["finalExitReason"] = *p
	}
	if b, ok := d["bleScaleConnected"].(bool); ok {
		out["bleScaleConnected"] = b
	}
	return out
}

// donationRating returns the annotation's star rating when it is a whole
// number from 1 to 5.
func donationRating(ann map[string]any) (int, bool) {
	f, ok := ann["rating"].(float64)
	if !ok || f != math.Trunc(f) || f < 1 || f > 5 {
		return 0, false
	}
	return int(f), true
}

// donationDrinkType maps a menu drink id to itself for the built-in drinks
// and to "other" for a user-made one.
func donationDrinkType(v any) *string {
	s, _ := v.(string)
	if s == "" {
		return nil
	}
	if !donationDrinkTypes[s] {
		s = "other"
	}
	return &s
}

// donationTasteTag returns the annotation's taste tag when it is one of the
// four known values; anything else, numbers included, is left out as nil.
func donationTasteTag(v any) *string {
	s, _ := v.(string)
	if !donationTasteTags[s] {
		return nil
	}
	return &s
}

// donationSecret returns the per-install secret, creating it on first use.
// INSERT OR IGNORE plus the re-read lets two concurrent first requests agree.
func donationSecret(db *sql.DB) ([]byte, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("backup: generating donation secret: %w", err)
	}
	encoded, err := json.Marshal(hex.EncodeToString(buf))
	if err != nil {
		return nil, fmt.Errorf("backup: encoding donation secret: %w", err)
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)`, donationSecretKey, string(encoded)); err != nil {
		return nil, fmt.Errorf("backup: storing donation secret: %w", err)
	}
	var raw string
	if err := db.QueryRow(`SELECT value FROM kv WHERE key = ?`, donationSecretKey).Scan(&raw); err != nil {
		return nil, fmt.Errorf("backup: reading donation secret: %w", err)
	}
	var s string
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return nil, fmt.Errorf("backup: decoding donation secret: %w", err)
	}
	secret, err := hex.DecodeString(s)
	if err != nil || len(secret) != 32 {
		return nil, fmt.Errorf("backup: stored donation secret is malformed")
	}
	return secret, nil
}

// hmacHex returns the first 16 hex chars of HMAC-SHA256(secret, msg).
func hmacHex(secret []byte, msg string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(msg))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

// buildShotDonation builds the donation file from every rated, non-trashed
// shot made at or after since (Unix seconds; 0 = all). The library, the
// machine list and the scorer are loaded once per call, not per shot.
func (d Dependencies) buildShotDonation(since int64) (donationFile, error) {
	secret, err := donationSecret(d.DB)
	if err != nil {
		return donationFile{}, err
	}
	all, err := d.ShotsRepo.FindAllExcludingTrash()
	if err != nil {
		return donationFile{}, err
	}
	lib, err := d.LibRepo.GetLibrary()
	if err != nil {
		return donationFile{}, err
	}
	machineList, err := d.Registry.ListMachines()
	if err != nil {
		return donationFile{}, err
	}
	machineTypes := make(map[int64]string, len(machineList))
	for _, m := range machineList {
		machineTypes[m.ID] = m.Type
	}
	score := shots.NewService(d.ShotsRepo).AllModelsScorer()
	out := donationFile{
		Format:     donationFormat,
		Version:    donationVersion,
		AppVersion: glpVersion,
		DonationID: hmacHex(secret, "donation-id"),
		Shots:      []donationShot{},
	}
	for _, shot := range all {
		ann, _ := shot["annotation"].(map[string]any)
		rating, ok := donationRating(ann)
		if !ok {
			continue
		}
		ts, _ := shot["timestamp"].(int64)
		if since > 0 && ts < since {
			continue
		}
		id, _ := shot["id"].(int64)
		profile := donationProfileOf(shot)
		row := donationShot{
			Key:         hmacHex(secret, "shot:"+strconv.FormatInt(id, 10)),
			MachineType: donationMachineType(machineTypes, shot["machineId"]),
			ProfileKey:  donationProfileKey(profile),
			Profile:     profile,
			Datapoints:  donationDatapoints(shot),
			Annotation:  donationAnnotation{Rating: rating, DrinkType: donationDrinkType(ann["drinkType"]), TasteTag: donationTasteTag(ann["tasteTag"])},
			Scores:      map[string]*int{},
		}
		m := shots.ComputeShotMetrics(shot)
		if m.HasDose {
			row.Annotation.Dose = donationNumPtr(m.DoseG)
		}
		if m.HasYield {
			row.Annotation.Yield = donationNumPtr(m.YieldG)
		}
		if tds, ok := ann["tds"].(float64); ok && tds > 0 {
			row.Annotation.TDS = donationNumPtr(tds)
		}
		if bean := library.ResolveBeanForShot(shot, lib.Beans); bean != nil {
			if level, _ := bean["roastLevel"].(string); donationRoastLevels[level] {
				row.Annotation.RoastLevel = &level
			}
		}
		row.Annotation.BeanAgeDays = donationBeanAge(lib.Beans, ann, ts)
		for _, ms := range score(shot) {
			row.Scores[ms.Model] = ms.Score
		}
		out.Shots = append(out.Shots, row)
	}
	sort.Slice(out.Shots, func(i, j int) bool { return out.Shots[i].Key < out.Shots[j].Key })
	return out, nil
}

// getShotDonation serves GET /api/shot-donation[?since=YYYY-MM-DD].
func (h *Handlers) getShotDonation(w http.ResponseWriter, r *http.Request) {
	if !h.rl.Allow("shot-donation:"+auth.RemoteIP(r), donationRateLimitPerMin) {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	var since int64
	if s := r.URL.Query().Get("since"); s != "" {
		t, err := time.ParseInLocation("2006-01-02", s, time.Local)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid since date")
			return
		}
		since = t.Unix()
	}
	file, err := h.deps.buildShotDonation(since)
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="glp-shot-donation.json"`)
	writeJSON(w, http.StatusOK, file)
}

// donationRoastLevels mirrors the library's roast-level allow-list.
var donationRoastLevels = map[string]bool{
	"light": true, "medium-light": true, "medium": true, "medium-dark": true, "dark": true,
}

// donationPhaseTypes and donationCurves mirror the machines proto enums: the
// index is the enum number, the string its wire name.
var (
	donationPhaseTypes = []string{"FLOW", "PRESSURE", "MANUAL"}
	donationCurves     = []string{"EASE_IN_OUT", "EASE_IN", "EASE_OUT", "LINEAR", "INSTANT"}
)

// donationNum returns v rounded to 2 decimals when it is a finite float64,
// else 0 (which the profile structs then omit).
func donationNum(v any) float64 {
	if p := donationNumPtr(v); p != nil {
		return *p
	}
	return 0
}

// donationEnum returns a known enum name given as its string or its number,
// else "".
func donationEnum(v any, names []string) string {
	switch t := v.(type) {
	case string:
		for _, n := range names {
			if n == t {
				return t
			}
		}
	case float64:
		if t == math.Trunc(t) && t >= 0 && int(t) < len(names) {
			return names[int(t)]
		}
	}
	return ""
}

// donationProfileOf returns the shot's profile structure without any name or
// id, or nil when the shot has no profile with phases (GaggiMate shots).
func donationProfileOf(shot shots.Shot) *donationProfile {
	raw, _ := shot["profile"].(map[string]any)
	phases, _ := raw["phases"].([]any)
	if len(phases) == 0 {
		return nil
	}
	p := &donationProfile{Phases: make([]donationPhase, 0, len(phases)), WaterTemperature: donationNum(raw["waterTemperature"])}
	for _, e := range phases {
		ph, _ := e.(map[string]any)
		target, _ := ph["target"].(map[string]any)
		stop, _ := ph["stopConditions"].(map[string]any)
		skip, _ := ph["skip"].(bool)
		p.Phases = append(p.Phases, donationPhase{
			Restriction: donationNum(ph["restriction"]),
			Skip:        skip,
			StopConditions: donationPhaseStop{
				FlowAbove:          donationNum(stop["flowAbove"]),
				FlowBelow:          donationNum(stop["flowBelow"]),
				PressureAbove:      donationNum(stop["pressureAbove"]),
				PressureBelow:      donationNum(stop["pressureBelow"]),
				Time:               donationNum(stop["time"]),
				WaterPumpedInPhase: donationNum(stop["waterPumpedInPhase"]),
				Weight:             donationNum(stop["weight"]),
			},
			Target: donationTarget{
				Curve:  donationEnum(target["curve"], donationCurves),
				End:    donationNum(target["end"]),
				Start:  donationNum(target["start"]),
				Time:   donationNum(target["time"]),
				Volume: donationNum(target["volume"]),
			},
			Type:             donationEnum(ph["type"], donationPhaseTypes),
			WaterTemperature: donationNum(ph["waterTemperature"]),
		})
	}
	if g, ok := raw["globalStopConditions"].(map[string]any); ok {
		gs := donationGlobalStop{Time: donationNum(g["time"]), WaterPumped: donationNum(g["waterPumped"]), Weight: donationNum(g["weight"])}
		if gs != (donationGlobalStop{}) {
			p.GlobalStopConditions = &gs
		}
	}
	if r, ok := raw["recipe"].(map[string]any); ok {
		rc := donationRecipe{CoffeeIn: donationNum(r["coffeeIn"]), CoffeeOut: donationNum(r["coffeeOut"]), Ratio: donationNum(r["ratio"])}
		if rc != (donationRecipe{}) {
			p.Recipe = &rc
		}
	}
	return p
}

// donationProfileKey is the first 16 hex chars of SHA-256 over the profile's
// JSON (sorted keys, zero values omitted, numbers rounded), nil for no profile.
func donationProfileKey(p *donationProfile) *string {
	if p == nil {
		return nil
	}
	b, err := json.Marshal(p)
	if err != nil {
		return nil
	}
	sum := sha256.Sum256(b)
	key := hex.EncodeToString(sum[:])[:16]
	return &key
}

// donationMachineType returns the registry type of the shot's machine when it
// is gaggiuino or gaggimate, else nil (e.g. a deleted machine).
func donationMachineType(types map[int64]string, machineID any) *string {
	id, ok := machineID.(int64)
	if !ok {
		return nil
	}
	t := types[id]
	if t != "gaggiuino" && t != "gaggimate" {
		return nil
	}
	return &t
}

// donationBeanAge returns the stored bean age in days, else the library's
// shared rule for the shot's bean, else nil.
func donationBeanAge(beans []library.Entity, ann map[string]any, shotSec int64) *int {
	if f, ok := ann["beanAgeDays"].(float64); ok && f >= 0 && f == math.Trunc(f) {
		days := int(f)
		return &days
	}
	if ann == nil {
		return nil
	}
	if days, ok := library.BeanAgeForAnnotation(beans, ann, shotSec); ok {
		return &days
	}
	return nil
}
