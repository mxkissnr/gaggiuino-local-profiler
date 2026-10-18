package orders

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// menuIDRe and notifyServiceRe guard values that end up in a URL path or an
// HA service call. Both accept only the shapes the app itself generates
// (`m_<ms>`, `ord_<ms>_<token>`, `notify.<service>`), so a restored bundle
// cannot widen them.
var (
	menuIDRe        = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
	notifyServiceRe = regexp.MustCompile(`^notify\.[a-z0-9_]+$`)
)

// NormalizeMenuItem builds a canonical MenuItem from a raw map, applying the
// same field rules the create/update handlers do. Both POST /api/orders/menu
// and the backup restore go through it, so a damaged menu restored from a
// bundle can't reach the Orders view, the kiosk or the order card carrying a
// field shape those readers iterate blindly (e.g. variants as a string).
//
// Unknown keys are dropped; ok is false when the item has no usable name.
func NormalizeMenuItem(raw map[string]any) (MenuItem, bool) {
	name := trimMax(raw["name"], 200)
	if name == "" {
		return nil, false
	}
	id, _ := raw["id"].(string)
	if !menuIDRe.MatchString(id) {
		id = "m_" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	}
	createdAt, ok := raw["createdAt"].(float64)
	if !ok {
		createdAt = float64(time.Now().UnixMilli())
	}
	return MenuItem{
		"id":        id,
		"name":      name,
		"emoji":     sanitizeEmoji(raw["emoji"], "☕"),
		"createdAt": createdAt,
		"trending":  boolOf(raw["trending"]),
		"variants":  stringSliceMax(raw["variants"], 50),
		"useBeans":  boolOf(raw["useBeans"]),
		"useMilks":  boolOf(raw["useMilks"]),
		"milkMl":    milkMlOrNil(raw["milkMl"]),
	}, true
}

// NormalizeSettings builds a canonical Settings map from a raw map, applying
// the same field rules postSettings does. Unlike postSettings (a merge with
// the stored settings), this returns a complete object: enabled defaults to
// false, broadcastRecipients is always an array and the enabled notify_*
// toggles are only copied over when they are genuine booleans. Unknown keys
// are dropped.
func NormalizeSettings(raw map[string]any) Settings {
	s := Settings{
		"enabled":             false,
		"broadcastRecipients": normalizeRecipients(raw["broadcastRecipients"]),
	}
	if v, ok := raw["enabled"].(bool); ok {
		s["enabled"] = v
	}
	if v, present := raw["baristaNotifyService"]; present {
		s["baristaNotifyService"] = NormalizeNotifyService(v)
	}
	for _, key := range notifyToggleKeys {
		if v, ok := raw[key].(bool); ok {
			s[key] = v
		}
	}
	return s
}

// normalizeRecipients keeps only the `notify.*` strings out of a raw
// broadcastRecipients value, each trimmed to 100 runes; a non-array (or an
// absent field) yields an empty array.
func normalizeRecipients(raw any) []any {
	arr, ok := raw.([]any)
	if !ok {
		return []any{}
	}
	out := make([]any, 0, len(arr))
	for _, v := range arr {
		if str, ok := v.(string); ok && strings.HasPrefix(str, "notify.") {
			out = append(out, trimMax(str, 100))
		}
	}
	return out
}

// NormalizeNotifyService keeps a `notify.<service>` string whose service name
// is plain lowercase letters, digits and underscores, at most 100 runes;
// anything else collapses to nil. The backup restore and the settings handlers
// both go through it, so a stored value always names a notify service.
func NormalizeNotifyService(v any) any {
	str, ok := v.(string)
	if !ok {
		return nil
	}
	str = strings.TrimSpace(str)
	if len([]rune(str)) > 100 || !notifyServiceRe.MatchString(str) {
		return nil
	}
	return str
}
