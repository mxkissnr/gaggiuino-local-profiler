package machines

import (
	"context"
	"encoding/json"
)

// This file ports lib/machines/gaggimate/profiles.js: thin pass-throughs
// over gaggimate_ws.go's request() for GaggiMate's own profile JSON shape
// (req:profiles:list/load/save/delete/select) — save/delete forward
// straight to the machine (capabilities().profileEdit == true, see
// gaggimate_adapter.go); GaggiMate itself is the only place these profiles
// are stored, GLP keeps no local copy.

// ── parse helpers ────────────────────────────────────────────────────────
// Used by both the live-client Request path (gaggimate_adapter.go) and the
// fallback gaggimateRequest path below (live == nil / tests).

// gaggimateListEntry is the per-profile shape inside the profiles:list response.
// GaggiMate uses "label" (not "name") and string IDs (e.g. "lever", "adapt").
type gaggimateListEntry struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Utility bool   `json:"utility"`
}

func gaggimateParseProfileList(res map[string]any) ([]ProfileSummary, error) {
	raw, err := json.Marshal(res["profiles"])
	if err != nil {
		return []ProfileSummary{}, nil
	}
	var entries []gaggimateListEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return []ProfileSummary{}, nil
	}
	out := make([]ProfileSummary, len(entries))
	for i, e := range entries {
		out[i] = ProfileSummary{ID: e.ID, Name: e.Label, Utility: e.Utility}
	}
	return out, nil
}

func gaggimateParseProfile(res map[string]any) (json.RawMessage, error) {
	if profile, ok := res["profile"]; ok {
		return json.Marshal(profile)
	}
	return json.Marshal(res)
}

func gaggimateParseProfileSave(res map[string]any) (ProfileSummary, error) {
	body := res
	if p, ok := res["profile"]; ok {
		if m, ok := p.(map[string]any); ok {
			body = m
		}
	}
	id, _ := body["id"].(string)
	label, _ := body["label"].(string)
	if label == "" {
		label, _ = body["name"].(string)
	}
	return ProfileSummary{ID: id, Name: label}, nil
}

// ── fallback one-shot helpers (used when live client is nil) ─────────────

func gaggimateListProfiles(ctx context.Context, baseURL string) ([]ProfileSummary, error) {
	res, err := gaggimateRequest(ctx, baseURL, "req:profiles:list", nil)
	if err != nil {
		return nil, err
	}
	return gaggimateParseProfileList(res)
}

func gaggimateLoadProfile(ctx context.Context, baseURL string, id string) (json.RawMessage, error) {
	res, err := gaggimateRequest(ctx, baseURL, "req:profiles:load", map[string]any{"id": id})
	if err != nil {
		return nil, err
	}
	return gaggimateParseProfile(res)
}

// gaggimateSaveProfile ports saveProfile(baseUrl, profile) — used for both
// create and update (profiles.js's saveProfile is the same call either
// way; GaggiMate's own req:profiles:save has no separate create/update
// distinction). profile is passed through as GaggiMate's own JSON profile
// shape, not converted through Gaggiuino's ProfileInput/proto.ProfileDto —
// see gaggimate_adapter.go's CreateProfile/UpdateProfile doc comment.
func gaggimateSaveProfile(ctx context.Context, baseURL string, profile json.RawMessage) (ProfileSummary, error) {
	var decoded any
	if err := json.Unmarshal(profile, &decoded); err != nil {
		return ProfileSummary{}, err
	}
	res, err := gaggimateRequest(ctx, baseURL, "req:profiles:save", map[string]any{"profile": decoded})
	if err != nil {
		return ProfileSummary{}, err
	}
	return gaggimateParseProfileSave(res)
}

func gaggimateDeleteProfile(ctx context.Context, baseURL string, id string) error {
	_, err := gaggimateRequest(ctx, baseURL, "req:profiles:delete", map[string]any{"id": id})
	return err
}

func gaggimateSelectProfile(ctx context.Context, baseURL string, id string) error {
	_, err := gaggimateRequest(ctx, baseURL, "req:profiles:select", map[string]any{"id": id})
	return err
}
