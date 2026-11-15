package library

import (
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// asAnySlice fails the test unless v is a JSON array.
func asAnySlice(t *testing.T, v any) []any {
	t.Helper()
	arr, ok := v.([]any)
	if !ok {
		t.Fatalf("value %#v is not a JSON array", v)
	}
	return arr
}

// TestSanitizePinnedProfiles covers #1963's stored pin list: a pin is
// {machineId, name}, machine ids must be whole and in range, names are trimmed
// and capped, duplicates collapse to the first occurrence and the list stops
// at maxPinnedProfiles entries.
func TestSanitizePinnedProfiles(t *testing.T) {
	longName := strings.Repeat("x", 500)
	tooMany := make([]any, 0, 25)
	tooManyWant := make([]any, 0, 25)
	for i := 1; i <= 25; i++ {
		name := "Profile " + strconv.Itoa(i)
		tooMany = append(tooMany, Entity{"machineId": float64(i), "name": name})
		tooManyWant = append(tooManyWant, Entity{"machineId": int64(i), "name": name})
	}

	pin := func(machineID float64, name string) []any {
		return []any{Entity{"machineId": machineID, "name": name}}
	}
	wantPin := func(machineID int64, name string) []any {
		return []any{Entity{"machineId": machineID, "name": name}}
	}
	duplicate := append(pin(1, "Londinium"), pin(1, "londinium ")...)
	twoMachines := append(pin(1, "Londinium"), pin(2, "Londinium")...)

	tests := []struct {
		name string
		in   any
		want []any
	}{
		{"not an array", "nope", []any{}},
		{"nil", nil, []any{}},
		{"empty list", []any{}, []any{}},
		{"machine id zero", pin(0, "Londinium"), []any{}},
		{"machine id negative", pin(-1, "Londinium"), []any{}},
		{"machine id fractional", pin(1.5, "Londinium"), []any{}},
		{"machine id not numeric", []any{Entity{"machineId": "x", "name": "Londinium"}}, []any{}},
		{"machine id missing", []any{Entity{"name": "Londinium"}}, []any{}},
		{"machine id above int32", pin(2147483648, "Londinium"), []any{}},
		{"machine id max int32", pin(2147483647, "Londinium"), wantPin(2147483647, "Londinium")},
		{"name missing", []any{Entity{"machineId": float64(1)}}, []any{}},
		{"name not a string", []any{Entity{"machineId": float64(1), "name": float64(3)}}, []any{}},
		{"name empty", pin(1, ""), []any{}},
		{"name whitespace", pin(1, "   "), []any{}},
		{"name trimmed", pin(1, "  Londinium  "), wantPin(1, "Londinium")},
		{"name capped", pin(1, longName), wantPin(1, strings.Repeat("x", 200))},
		{"item not an object", []any{"Londinium"}, []any{}},
		{"deduped case-insensitively", duplicate, wantPin(1, "Londinium")},
		{"same name on two machines", twoMachines, append(wantPin(1, "Londinium"), wantPin(2, "Londinium")...)},
		{"capped at twenty", tooMany, tooManyWant[:maxPinnedProfiles]},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizePinnedProfiles(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("sanitizePinnedProfiles(%#v) = %#v, want %#v", tc.in, got, tc.want)
			}
			for _, item := range got {
				entry, ok := item.(Entity)
				if !ok || len(entry) != 2 {
					t.Fatalf("output item = %#v, want a map with exactly machineId and name", item)
				}
				if _, ok := entry["machineId"].(int64); !ok {
					t.Errorf("machineId = %#v, want int64", entry["machineId"])
				}
				if _, ok := entry["name"].(string); !ok {
					t.Errorf("name = %#v, want string", entry["name"])
				}
			}
		})
	}
}

// libraryBeanPins reads the single bean's stored pins back through
// GET /api/library.
func libraryBeanPins(t *testing.T, mux *http.ServeMux) (any, bool) {
	t.Helper()
	rec := doJSON(t, mux, http.MethodGet, "/api/library", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/library status = %d; body=%s", rec.Code, rec.Body.String())
	}
	beans := asAnySlice(t, decodeBody(t, rec.Body.Bytes())["beans"])
	if len(beans) != 1 {
		t.Fatalf("expected exactly one bean, got %+v", beans)
	}
	bean, _ := beans[0].(map[string]any)
	pins, present := bean["pinnedProfiles"]
	return pins, present
}

// TestUpdateBeanPinnedProfiles covers #1963's partial-update route: the client
// sends the whole list, an absent field keeps the stored pins and an empty
// list clears them.
func TestUpdateBeanPinnedProfiles(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Kenya AA"}))
	bean := decodeBody(t, rec.Body.Bytes())
	if _, present := bean["pinnedProfiles"]; present {
		t.Fatalf("created bean carries pinnedProfiles: %+v", bean)
	}
	id := int64(bean["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{
		"pinnedProfiles": []any{
			map[string]any{"machineId": 2, "name": " Adaptive "},
			map[string]any{"machineId": 2, "name": "adaptive"},
		},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d; body=%s", rec.Code, rec.Body.String())
	}
	pins := asAnySlice(t, decodeBody(t, rec.Body.Bytes())["pinnedProfiles"])
	if len(pins) != 1 {
		t.Fatalf("expected one pin after dedupe, got %+v", pins)
	}
	pin, _ := pins[0].(map[string]any)
	if pin["machineId"] != float64(2) || pin["name"] != "Adaptive" {
		t.Fatalf("pin = %+v, want {machineId:2 name:Adaptive}", pin)
	}

	if stored, present := libraryBeanPins(t, mux); !present || len(asAnySlice(t, stored)) != 1 {
		t.Fatalf("stored pins after update = %+v (present=%v)", stored, present)
	}

	// A PUT that does not mention pinnedProfiles keeps the stored list.
	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"notes": "x"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("notes update status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if stored, present := libraryBeanPins(t, mux); !present || len(asAnySlice(t, stored)) != 1 {
		t.Fatalf("pins after unrelated update = %+v (present=%v)", stored, present)
	}

	// An empty list clears the pins.
	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"pinnedProfiles": []any{}}))
	if rec.Code != http.StatusOK {
		t.Fatalf("clear status = %d; body=%s", rec.Code, rec.Body.String())
	}
	stored, present := libraryBeanPins(t, mux)
	if !present {
		t.Fatal("pinnedProfiles key disappeared after clear")
	}
	if arr := asAnySlice(t, stored); len(arr) != 0 {
		t.Fatalf("pins after clear = %+v, want an empty array", stored)
	}
}

// TestSanitizeBeanFieldsPinnedProfiles covers #1963's restore path: a crafted
// backup's pins run through the same sanitiser, and a bean without pins keeps
// no key.
func TestSanitizeBeanFieldsPinnedProfiles(t *testing.T) {
	hostile := make([]any, 0, 31)
	for i := 1; i <= 30; i++ {
		hostile = append(hostile, Entity{"machineId": float64(i), "name": strings.Repeat("x", 500)})
	}
	hostile = append(hostile, Entity{"machineId": 1.5, "name": "Fractional"})

	out := SanitizeBeanFields(Entity{"name": "Kenya AA", "pinnedProfiles": hostile})
	pins := asAnySlice(t, out["pinnedProfiles"])
	if len(pins) != maxPinnedProfiles {
		t.Fatalf("restored pins = %+v, want %d entries", out["pinnedProfiles"], maxPinnedProfiles)
	}
	for _, item := range pins {
		entry, _ := item.(Entity)
		name, _ := entry["name"].(string)
		if len(name) != 200 {
			t.Fatalf("restored pin name length = %d, want 200", len(name))
		}
		if _, ok := entry["machineId"].(int64); !ok {
			t.Fatalf("restored pin machineId = %#v, want int64", entry["machineId"])
		}
	}

	if _, present := SanitizeBeanFields(Entity{"name": "Kenya AA"})["pinnedProfiles"]; present {
		t.Fatal("a bean without pins gained a pinnedProfiles key")
	}
}
