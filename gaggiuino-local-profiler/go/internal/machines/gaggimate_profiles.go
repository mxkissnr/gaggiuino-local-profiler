package machines

import (
	"encoding/json"
	"fmt"
	"strings"
)

// This file holds the parse helpers for GaggiMate's own profile JSON shape
// (req:profiles:list/load/save/delete/select). The requests themselves go
// through the live client's Request (gaggimate_live.go), driven from
// gaggimate_adapter.go — GaggiMate itself is the only place these profiles
// are stored, GLP keeps no local copy.

// ── parse helpers ────────────────────────────────────────────────────────

// gaggimateParseProfileList reads the profiles:list response entry by entry
// (rather than unmarshalling the array into a typed slice) so a single entry
// of an unexpected shape — a numeric id, say — is skipped instead of emptying
// the whole list. GaggiMate uses "label" (not "name") and string ids (e.g.
// "lever", "adapt"), but a numeric id is accepted the same way
// ProfileSummary.UnmarshalJSON accepts one.
func gaggimateParseProfileList(res map[string]any) ([]ProfileSummary, error) {
	rawProfiles, ok := res["profiles"]
	if !ok || rawProfiles == nil {
		return nil, fmt.Errorf("gaggimate: profile list response carries no profiles")
	}
	raw, err := json.Marshal(rawProfiles)
	if err != nil {
		return nil, fmt.Errorf("gaggimate: encoding profile list: %w", err)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("gaggimate: profile list is not an array: %w", err)
	}
	out := make([]ProfileSummary, 0, len(entries))
	for _, entry := range entries {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(entry, &fields); err != nil {
			continue
		}
		idRaw, ok := fields["id"]
		if !ok || string(idRaw) == "null" {
			continue
		}
		id := strings.TrimSpace(jsonRawToProfileID(idRaw))
		if id == "" {
			continue
		}
		var label string
		_ = json.Unmarshal(fields["label"], &label)
		var utility bool
		_ = json.Unmarshal(fields["utility"], &utility)
		out = append(out, ProfileSummary{ID: id, Name: label, Utility: utility})
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
