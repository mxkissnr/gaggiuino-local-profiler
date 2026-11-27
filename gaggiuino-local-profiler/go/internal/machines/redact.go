package machines

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
)

// This file keeps the machine's own secrets away from the browser and out of
// GLP backups. #1431 started it with the system mqttPassword; #2231 adds the
// visualizer and profiler tokens, in the system category and in each Cafe
// Mode user's preferences (display.homeUsers[*].preferences).
//
// RedactSettings is the read side of the settings proxy in
// handlers_control.go: it drops every token and turns mqttPassword into the
// browser-only mqttPasswordSet marker. prepareSettingsWrite is the write
// side: a form the browser posts back never carries those values, so it puts
// the machine's current ones back before the write is forwarded, and merges a
// display write over the machine's current display settings. The backup code
// (internal/machinebackups) shares StripHomeUserTokens and
// RestoreHomeUserTokens.

// RedactSettings removes the machine's secrets from a settings JSON body
// before it goes to the browser: at any depth, each mqttPassword becomes
// mqttPasswordSet (true when it held a non-empty password) and every
// visualizerToken and sprofilerToken is dropped. Working at any depth covers a
// single category, the all-categories read (categories nested) and the
// per-user preferences without knowing where firmware puts them. A body that
// is not valid JSON, or carries none of these keys, is returned unchanged.
func RedactSettings(raw []byte) []byte {
	value, ok := decodeSettingsJSON(raw)
	if !ok || !redactValue(value) {
		return raw
	}
	redacted, err := encodeSettingsJSON(value)
	if err != nil {
		// Never fall back to raw: it still holds the secrets.
		return []byte(`{}`)
	}
	return redacted
}

// redactValue redacts value in place and reports whether it changed anything.
func redactValue(value any) bool {
	changed := false
	switch node := value.(type) {
	case map[string]any:
		if pw, present := node["mqttPassword"]; present {
			s, _ := pw.(string)
			delete(node, "mqttPassword")
			node["mqttPasswordSet"] = s != ""
			changed = true
		}
		for _, key := range tokenKeys {
			if _, present := node[key]; present {
				delete(node, key)
				changed = true
			}
		}
		for _, child := range node {
			if redactValue(child) {
				changed = true
			}
		}
	case []any:
		for _, child := range node {
			if redactValue(child) {
				changed = true
			}
		}
	}
	return changed
}

// systemSecretKeys are the system-category values RedactSettings keeps from
// the browser; a system write that lacks one gets the machine's current value.
var systemSecretKeys = []string{"mqttPassword", "visualizerToken", "sprofilerToken"}

var (
	errInvalidSettingsPayload    = errors.New("invalid settings payload")
	errUnreadableMachineSettings = errors.New("the machine's current settings could not be read")
)

// prepareSettingsWrite returns the body to forward for a write of the system
// or display category. A system write gets every secret it lacks back from
// the machine's current settings, and the browser-only mqttPasswordSet marker
// is dropped. A display write is laid over the machine's current display
// settings (the body's top-level keys win), so it never drops homeUsers or a
// field the caller did not send, and each user's missing tokens come back from
// the machine, matched by user id. current reads the machine's current
// settings of that category; it is only called when needed. Any failure to
// read them is an error: forwarding anyway could wipe a secret.
func prepareSettingsWrite(category string, rawBody []byte, current func() ([]byte, error)) ([]byte, error) {
	body, ok := settingsObjectOf(rawBody)
	if !ok {
		return nil, errInvalidSettingsPayload
	}
	if body == nil {
		body = map[string]any{}
	}
	needCurrent := category == "display"
	for _, key := range systemSecretKeys {
		if _, present := body[key]; !present && category == "system" {
			needCurrent = true
		}
	}
	var machine map[string]any
	if needCurrent {
		raw, err := current()
		if err != nil {
			return nil, err
		}
		machine, ok = settingsObjectOf(raw)
		if !ok || machine == nil {
			return nil, errUnreadableMachineSettings
		}
	}
	switch category {
	case "system":
		for _, key := range systemSecretKeys {
			if _, present := body[key]; !present {
				if value, has := machine[key]; has {
					body[key] = value
				}
			}
		}
		delete(body, "mqttPasswordSet")
	case "display":
		currentUsers := map[string]any{"homeUsers": machine["homeUsers"]}
		for key, value := range body {
			machine[key] = value
		}
		RestoreHomeUserTokens(machine, currentUsers)
		body = machine
	}
	return encodeSettingsJSON(body)
}

// decodeSettingsJSON decodes one JSON value, keeping number literals as they
// are (json.Number); anything that is not exactly one valid JSON value fails.
func decodeSettingsJSON(raw []byte) (any, bool) {
	if !json.Valid(raw) {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, false
	}
	return value, true
}

// settingsObjectOf decodes a JSON object; null gives a nil map and true.
func settingsObjectOf(raw []byte) (map[string]any, bool) {
	value, ok := decodeSettingsJSON(raw)
	if !ok {
		return nil, false
	}
	if value == nil {
		return nil, true
	}
	obj, isObject := value.(map[string]any)
	return obj, isObject
}

// encodeSettingsJSON renders value as compact JSON without HTML escaping, so
// string values reach the machine exactly as they were sent.
func encodeSettingsJSON(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// tokenKeys are the visualizer and profiler upload tokens. The system
// category carries them, and since firmware main-7cb0a86 (#2231) so does each
// Cafe Mode user's display.homeUsers[*].preferences. They are secrets: never
// stored in a GLP backup and never sent to the browser.
var tokenKeys = []string{"visualizerToken", "sprofilerToken"}

// StripHomeUserTokens deletes every per-user token from display, a display
// settings object. A user or preferences value that is not a JSON object is
// skipped; a caller that must fail closed checks the shape first.
func StripHomeUserTokens(display map[string]any) {
	users, _ := display["homeUsers"].([]any)
	for _, u := range users {
		user, _ := u.(map[string]any)
		prefs, _ := user["preferences"].(map[string]any)
		for _, key := range tokenKeys {
			delete(prefs, key)
		}
	}
}

// RestoreHomeUserTokens copies the per-user tokens from current, the
// machine's current display settings, into target, matching users by id and
// never by position. Only tokens missing from a target user's preferences are
// copied, so a value the caller sent on purpose wins. Users found on one side
// only, and users without a preferences object, are left alone. It returns
// how many values it copied.
func RestoreHomeUserTokens(target, current map[string]any) int {
	byID := map[string]map[string]any{}
	currentUsers, _ := current["homeUsers"].([]any)
	for _, u := range currentUsers {
		user, _ := u.(map[string]any)
		key, ok := homeUserKey(user)
		prefs, isObject := user["preferences"].(map[string]any)
		if _, seen := byID[key]; ok && isObject && !seen {
			byID[key] = prefs
		}
	}
	copied := 0
	targetUsers, _ := target["homeUsers"].([]any)
	for _, u := range targetUsers {
		user, _ := u.(map[string]any)
		key, ok := homeUserKey(user)
		prefs, isObject := user["preferences"].(map[string]any)
		source, found := byID[key]
		if !ok || !isObject || !found {
			continue
		}
		for _, name := range tokenKeys {
			if _, present := prefs[name]; present {
				continue
			}
			if value, has := source[name]; has {
				prefs[name] = value
				copied++
			}
		}
	}
	return copied
}

// homeUserKey is a user's id as a map key. Numbers and strings stay apart, so
// 1 and "1" are different users; a user without a usable id has no key.
func homeUserKey(user map[string]any) (string, bool) {
	switch id := user["id"].(type) {
	case json.Number:
		return "n:" + id.String(), true
	case float64:
		return "n:" + strconv.FormatFloat(id, 'f', -1, 64), true
	case string:
		return "s:" + id, true
	}
	return "", false
}
