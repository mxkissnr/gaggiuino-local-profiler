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

// donationRating returns the annotation's star rating when it is a whole
// number from 1 to 5.
func donationRating(ann map[string]any) (int, bool) {
	f, ok := ann["rating"].(float64)
	if !ok || f != math.Trunc(f) || f < 1 || f > 5 {
		return 0, false
	}
	return int(f), true
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
// shot made at or after since (Unix seconds; 0 = all).
func (d Dependencies) buildShotDonation(since int64) (donationFile, error) {
	secret, err := donationSecret(d.DB)
	if err != nil {
		return donationFile{}, err
	}
	all, err := d.ShotsRepo.FindAllExcludingTrash()
	if err != nil {
		return donationFile{}, err
	}
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
		// Slice 1 of #2220 writes the keys and the rating; the datapoints,
		// annotation values, profile, machine type and scores follow.
		row := donationShot{
			Key:        hmacHex(secret, "shot:"+strconv.FormatInt(id, 10)),
			Datapoints: map[string]any{},
			Annotation: donationAnnotation{Rating: rating},
			Scores:     map[string]*int{},
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
