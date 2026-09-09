package backup

import (
	"regexp"
	"time"
)

func nowMillis() int64 { return time.Now().UnixMilli() }

// This file ports routes/backup.js's restore-time row sanitizers:
// sanitizeMaintenanceRow, sanitizeMaintenanceLogRow, sanitizeOrderRow, and
// the image path-traversal/integrity guard (validateEntityImages /
// validateRestoredLibraryImages).

// sanitizeMaintenanceRow ports sanitizeMaintenanceRow(r): loosely
// validates one raw `maintenance` export row ({machineId, key, data}).
// Returns (nil, false) for anything that doesn't pass.
func sanitizeMaintenanceRow(r map[string]any) (map[string]any, bool) {
	if r == nil {
		return nil, false
	}
	machineID, ok := jsIntStrict(r["machineId"])
	if !ok || machineID <= 0 {
		return nil, false
	}
	key, _ := r["key"].(string)
	key = trimString(key)
	if key == "" || len([]rune(key)) > 100 {
		return nil, false
	}
	rawData, ok := r["data"].(map[string]any)
	if !ok {
		return nil, false
	}
	data := map[string]any{}
	for k, v := range rawData {
		if len([]rune(k)) > 50 {
			continue
		}
		switch t := v.(type) {
		case nil:
			data[k] = nil
		case float64:
			data[k] = t
		case string:
			data[k] = truncateRunes(t, 500)
		}
		// booleans/objects/arrays aren't part of any known maintenance
		// task's shape — dropped, matching the Node original.
	}
	return map[string]any{"machineId": machineID, "key": truncateRunes(key, 100), "data": data}, true
}

var dateOnlyRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// sanitizeMaintenanceLogRow ports sanitizeMaintenanceLogRow(r), including
// maintenanceLogSchema's constraints (task 1-100 chars; notes/machine
// optional strings capped at 1000/200 chars, defaulting to "" when absent
// — but REJECTING the whole row, like zod's .max(), if present and over
// length, never silently truncating).
func sanitizeMaintenanceLogRow(r map[string]any) (map[string]any, bool) {
	if r == nil {
		return nil, false
	}
	id, idOK := jsFiniteNumber(r["id"])
	ts, tsOK := jsFiniteNumber(r["ts"])
	if !idOK || !tsOK {
		return nil, false
	}
	date, _ := r["date"].(string)
	if !dateOnlyRe.MatchString(date) {
		return nil, false
	}
	task, ok := zodString(r["task"], 1, 100, "")
	if !ok {
		return nil, false
	}
	notes, ok := zodString(r["notes"], 0, 1000, "")
	if !ok {
		return nil, false
	}
	machine, ok := zodString(r["machine"], 0, 200, "")
	if !ok {
		return nil, false
	}
	shotCount, _ := jsFiniteNumber(r["shotCount"])
	machineID, ok := jsIntStrict(r["machineId"])
	if !ok || machineID <= 0 {
		machineID = 1
	}
	return map[string]any{
		"id": int64(id), "ts": int64(ts), "date": date,
		"task": task, "machine": machine, "notes": notes,
		"shotCount": int64(shotCount), "machineId": machineID,
	}, true
}

// zodString ports a z.string().min(min).max(max).optional().default(def)
// field: absent/nil -> (def, true); present but not a string, or a string
// outside [min,max] -> (_, false) (fails validation, unlike trimMax's
// silent truncation elsewhere in this codebase — zod's .max() genuinely
// rejects an over-length value rather than truncating it).
func zodString(v any, min, max int, def string) (string, bool) {
	if v == nil {
		return def, true
	}
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	n := len([]rune(s))
	if n < min || n > max {
		return "", false
	}
	return s, true
}

// orderStatuses mirrors backup.js's ORDER_STATUSES.
var orderStatuses = map[string]bool{"pending": true, "accepted": true, "done": true, "declined": true}

// sanitizeOrderRow ports sanitizeOrderRow(o): loosely validates one raw
// order row on restore, mirroring the field set/length caps POST
// /api/orders and its lifecycle actions already accept.
func sanitizeOrderRow(o map[string]any) (map[string]any, bool) {
	if o == nil {
		return nil, false
	}
	id, _ := o["id"].(string)
	id = trimString(id)
	if id == "" || len([]rune(id)) > 100 {
		return nil, false
	}
	status, _ := o["status"].(string)
	if !orderStatuses[status] {
		return nil, false
	}
	out := map[string]any{
		"id": truncateRunes(id, 100), "status": status,
		"item":     strOrDefault(o["item"], 100, ""),
		"customer": strOrDefault(o["customer"], 50, ""),
		"note":     strOrDefault(o["note"], 200, ""),
	}
	out["variant"] = strOrNilPtr(o["variant"], 50)
	out["notifyService"] = strOrNilPtr(o["notifyService"], 100)
	out["declineReason"] = strOrNilPtr(o["declineReason"], 200)
	out["haUserId"] = strOrNilPtr(o["haUserId"], 100)
	out["machine"] = strOrNilPtr(o["machine"], 100)
	if n, ok := jsFiniteNumber(o["createdAt"]); ok {
		out["createdAt"] = int64(n)
	} else {
		out["createdAt"] = nowMillis()
	}
	out["completedAt"] = numOrNil(o["completedAt"])
	out["acceptedAt"] = numOrNil(o["acceptedAt"])
	out["eta"] = numOrNil(o["eta"])
	if machineID, ok := jsIntStrict(o["machineId"]); ok && machineID > 0 {
		out["machineId"] = machineID
	} else {
		out["machineId"] = int64(1)
	}
	out["beanId"] = intOrNil(o["beanId"])
	out["shotId"] = intOrNil(o["shotId"])
	return out, true
}

func strOrDefault(v any, max int, def string) string {
	s, ok := v.(string)
	if !ok {
		return def
	}
	return truncateRunes(s, max)
}

func strOrNilPtr(v any, max int) any {
	if v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		return nil
	}
	return truncateRunes(s, max)
}

func numOrNil(v any) any {
	n, ok := jsFiniteNumber(v)
	if !ok {
		return nil
	}
	return int64(n)
}

func intOrNil(v any) any {
	n, ok := jsIntStrict(v)
	if !ok {
		return nil
	}
	return n
}

// jsFiniteNumber mirrors `typeof v === 'number' && Number.isFinite(v)`.
func jsFiniteNumber(v any) (float64, bool) {
	n, ok := v.(float64)
	return n, ok
}

// jsIntStrict mirrors `Number.isInteger(v)`: a JSON number with no
// fractional part (JSON has no separate int type — every number decodes
// to float64).
func jsIntStrict(v any) (int64, bool) {
	n, ok := v.(float64)
	if !ok || n != float64(int64(n)) {
		return 0, false
	}
	return int64(n), true
}

func trimString(s string) string {
	i, j := 0, len(s)
	for i < j && isSpace(s[i]) {
		i++
	}
	for j > i && isSpace(s[j-1]) {
		j--
	}
	return s[i:j]
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}
