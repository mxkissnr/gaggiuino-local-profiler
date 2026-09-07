package backup

// This file ports routes/backup.js's section-scoping constants/logic:
// BACKUP_SECTIONS, SECTION_BUNDLE_KEYS, SECTION_PRESENCE_BUNDLE_KEYS, and
// normaliseSections(raw).

// backupSections mirrors BACKUP_SECTIONS: the six independently selectable
// backup domains, used for both export scope and restore scope selection.
var backupSections = map[string]bool{
	"shots": true, "maintenance": true, "orders": true,
	"machines": true, "settings": true, "secrets": true,
}

// sectionBundleKeys mirrors SECTION_BUNDLE_KEYS: which top-level bundle
// keys a section pulls in on export.
var sectionBundleKeys = map[string][]string{
	"shots":       {"shots", "annotations", "coffee_library", "blocklist", "trash", "images"},
	"maintenance": {"maintenance", "maintenance_log"},
	"orders":      {"orders"},
	"machines":    {"machines"},
	"settings":    {"kv"},
	"secrets":     {"secrets"},
}

// sectionPresenceBundleKeys mirrors SECTION_PRESENCE_BUNDLE_KEYS: the
// narrower set of keys that prove a section is actually *present* in a
// file being restored (dry-run preview's `sectionsPresent`).
var sectionPresenceBundleKeys = map[string][]string{
	"shots":       {"shots"},
	"maintenance": {"maintenance", "maintenance_log"},
	"orders":      {"orders"},
	"machines":    {"machines"},
	"settings":    {"kv"},
	"secrets":     {"secrets"},
}

// sectionOrder is backupSections' iteration in a fixed order — Go map
// iteration is randomized, and section order shows up in the dry-run
// preview's `sectionsPresent` array and the scoped-export bundle's own
// `sections` field, both JSON arrays where order is visible (unlike an
// object's key order).
var sectionOrder = []string{"shots", "maintenance", "orders", "machines", "settings", "secrets"}

// sections represents normaliseSections(raw)'s three-way result: nil means
// "all sections" (the raw value wasn't an array at all — omitted request
// field); non-nil (possibly empty) means an explicit selection.
type sections map[string]bool

// has reports whether s selects the given section — a nil s (meaning "all
// sections") always reports true, matching every `sections === null ||
// sections.has(x)` check throughout routes/backup.js.
func (s sections) has(name string) bool {
	if s == nil {
		return true
	}
	return s[name]
}

// normaliseSections ports normaliseSections(raw): raw must be a []any of
// section-name strings to produce a non-nil result; anything else (absent,
// wrong type) means "all sections". Unknown section names are silently
// dropped rather than rejected.
func normaliseSections(raw any) sections {
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := sections{}
	for _, v := range arr {
		name, ok := v.(string)
		if ok && backupSections[name] {
			out[name] = true
		}
	}
	return out
}

// orderedNames returns s's selected section names in sectionOrder, for
// building a deterministic `sections` array on a scoped export.
func (s sections) orderedNames() []string {
	if s == nil {
		return nil
	}
	out := make([]string, 0, len(s))
	for _, name := range sectionOrder {
		if s[name] {
			out = append(out, name)
		}
	}
	return out
}
