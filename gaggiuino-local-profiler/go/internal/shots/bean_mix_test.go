package shots

import (
	"testing"
)

// mixAnnotation builds the canonical two-bean mix the tests share: 10 g of bean
// 12 ("Bean A") and 8 g of bean 7 ("Bean B"), with the top-level coffee/beanId
// naming the primary bean (the part with the most grams).
func mixAnnotation() map[string]any {
	mix := []any{
		map[string]any{"beanId": float64(12), "coffee": "Bean A", "grams": float64(10)},
		map[string]any{"beanId": float64(7), "coffee": "Bean B", "grams": float64(8)},
	}
	return map[string]any{"coffee": "Bean A", "beanId": float64(12), "dose": float64(18), "beanMix": mix}
}

func TestBeanMix_TwoParts(t *testing.T) {
	parts := BeanMix(mixAnnotation())
	if len(parts) != 2 {
		t.Fatalf("BeanMix = %+v, want 2 parts", parts)
	}
	if parts[0].BeanID == nil || *parts[0].BeanID != 12 || parts[0].Coffee != "Bean A" || parts[0].Grams != 10 {
		t.Errorf("part 0 = %+v, want bean 12 / Bean A / 10 g", parts[0])
	}
	if parts[1].BeanID == nil || *parts[1].BeanID != 7 || parts[1].Coffee != "Bean B" || parts[1].Grams != 8 {
		t.Errorf("part 1 = %+v, want bean 7 / Bean B / 8 g", parts[1])
	}
	if !IsBeanMix(mixAnnotation()) {
		t.Error("IsBeanMix = false, want true")
	}
}

func TestBeanMix_AbsentOrSingleBean(t *testing.T) {
	check := func(name string, ann map[string]any) {
		t.Run(name, func(t *testing.T) {
			if parts := BeanMix(ann); parts != nil {
				t.Errorf("BeanMix = %+v, want nil", parts)
			}
			if IsBeanMix(ann) {
				t.Error("IsBeanMix = true, want false")
			}
		})
	}
	check("no annotation", map[string]any{})
	check("single bean", map[string]any{"coffee": "Bean A", "beanId": float64(12)})
	check("null beanMix", map[string]any{"coffee": "Bean A", "beanMix": nil})
	check("one part only", map[string]any{"beanMix": []any{map[string]any{"coffee": "Bean A", "grams": float64(18)}}})
	check("empty array", map[string]any{"coffee": "Bean A", "beanMix": []any{}})
	check("not an array", map[string]any{"coffee": "Bean A", "beanMix": "Bean A + Bean B"})
	check("bad part shapes", map[string]any{"beanMix": []any{"Bean A", "Bean B"}})
}

func TestBeanMix_PartsWithoutOptionalBeanID(t *testing.T) {
	mix := []any{
		map[string]any{"coffee": "Bean A", "grams": float64(10)},
		map[string]any{"beanId": nil, "coffee": "Bean B", "grams": float64(8)},
	}
	parts := BeanMix(map[string]any{"beanMix": mix})
	if len(parts) != 2 {
		t.Fatalf("BeanMix = %+v, want 2 parts", parts)
	}
	if parts[0].BeanID != nil || parts[1].BeanID != nil {
		t.Errorf("BeanID = %v / %v, want nil for parts without a beanId", parts[0].BeanID, parts[1].BeanID)
	}
}

func TestBeanLabel(t *testing.T) {
	if got := BeanLabel(mixAnnotation()); got != "Bean A + Bean B" {
		t.Errorf("BeanLabel(mix) = %q, want %q", got, "Bean A + Bean B")
	}
	if got := BeanLabel(map[string]any{"coffee": "Bean A"}); got != "Bean A" {
		t.Errorf("BeanLabel(single) = %q, want %q", got, "Bean A")
	}
	if got := BeanLabel(map[string]any{}); got != "" {
		t.Errorf("BeanLabel(empty) = %q, want empty", got)
	}
	if got := BeanLabel(nil); got != "" {
		t.Errorf("BeanLabel(nil) = %q, want empty", got)
	}
}

func TestValidateAnnotation_BeanMixValid(t *testing.T) {
	if issues := ValidateAnnotation(mixAnnotation()); len(issues) != 0 {
		t.Errorf("expected no issues for a valid mix, got %+v", issues)
	}
	// Explicit null and an absent key are both fine.
	if issues := ValidateAnnotation(map[string]any{"coffee": "Bean A", "beanMix": nil}); len(issues) != 0 {
		t.Errorf("expected no issues for a null beanMix, got %+v", issues)
	}
	if issues := ValidateAnnotation(map[string]any{"coffee": "Bean A"}); len(issues) != 0 {
		t.Errorf("expected no issues for an absent beanMix, got %+v", issues)
	}
	// Only the coffee name and grams are required, so a part without a beanId is valid.
	mix := []any{
		map[string]any{"coffee": "Bean A", "grams": float64(10)},
		map[string]any{"coffee": "Bean B", "grams": float64(18)},
	}
	if issues := ValidateAnnotation(map[string]any{"beanMix": mix}); len(issues) != 0 {
		t.Errorf("expected no issues for a mix without beanIds, got %+v", issues)
	}
}

func TestValidateAnnotation_BeanMixThreeOrFourPartsValid(t *testing.T) {
	mix := []any{
		map[string]any{"beanId": float64(1), "coffee": "Bean A", "grams": float64(6)},
		map[string]any{"beanId": float64(2), "coffee": "Bean B", "grams": float64(6)},
		map[string]any{"beanId": float64(3), "coffee": "Bean C", "grams": float64(6)},
	}
	if issues := ValidateAnnotation(map[string]any{"beanMix": mix}); len(issues) != 0 {
		t.Errorf("expected no issues for a 3-part mix, got %+v", issues)
	}
	mix = append(mix, map[string]any{"beanId": float64(4), "coffee": "Bean D", "grams": float64(4)})
	if issues := ValidateAnnotation(map[string]any{"beanMix": mix}); len(issues) != 0 {
		t.Errorf("expected no issues for a 4-part mix, got %+v", issues)
	}
}

func TestValidateAnnotation_BeanMixDuplicateNullIDsAllowed(t *testing.T) {
	mix := []any{
		map[string]any{"beanId": nil, "coffee": "Bean A", "grams": float64(10)},
		map[string]any{"beanId": nil, "coffee": "Bean B", "grams": float64(8)},
	}
	if issues := ValidateAnnotation(map[string]any{"beanMix": mix}); len(issues) != 0 {
		t.Errorf("expected no issues for two null beanIds, got %+v", issues)
	}
}

func TestValidateAnnotation_BeanMixGramsNotComparedToDose(t *testing.T) {
	// The parts add up to 18 g while the dose says 30: deliberately not an issue.
	mix := []any{
		map[string]any{"coffee": "Bean A", "grams": float64(10)},
		map[string]any{"coffee": "Bean B", "grams": float64(8)},
	}
	if issues := ValidateAnnotation(map[string]any{"dose": float64(30), "beanMix": mix}); len(issues) != 0 {
		t.Errorf("expected no issues when the parts do not sum to the dose, got %+v", issues)
	}
}

func TestValidateAnnotation_BeanMixInvalid(t *testing.T) {
	part := func(overrides map[string]any) map[string]any {
		m := map[string]any{"coffee": "Bean A", "grams": float64(10)}
		for k, v := range overrides {
			m[k] = v
		}
		return m
	}
	check := func(name string, ann map[string]any, path string) {
		t.Run(name, func(t *testing.T) {
			if issues := ValidateAnnotation(ann); !hasIssue(issues, path) {
				t.Errorf("expected an issue at %q, got %+v", path, issues)
			}
		})
	}

	check("not an array", map[string]any{"beanMix": "nope"}, "beanMix")
	check("one part", map[string]any{"beanMix": []any{part(nil)}}, "beanMix")
	check("five parts", map[string]any{"beanMix": []any{part(nil), part(nil), part(nil), part(nil), part(nil)}}, "beanMix")
	check("part not an object", map[string]any{"beanMix": []any{part(nil), "Bean B"}}, "beanMix[1]")
	check("missing coffee", map[string]any{"beanMix": []any{part(nil), map[string]any{"grams": float64(8)}}}, "beanMix[1].coffee")
	check("null coffee", map[string]any{"beanMix": []any{part(nil), map[string]any{"coffee": nil, "grams": float64(8)}}}, "beanMix[1].coffee")
	check("empty coffee", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"coffee": ""})}}, "beanMix[1].coffee")
	check("coffee not a string", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"coffee": float64(3)})}}, "beanMix[1].coffee")
	check("coffee too long", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"coffee": longCoffee(201)})}}, "beanMix[1].coffee")
	check("missing grams", map[string]any{"beanMix": []any{part(nil), map[string]any{"coffee": "Bean B"}}}, "beanMix[1].grams")
	check("null grams", map[string]any{"beanMix": []any{part(nil), map[string]any{"coffee": "Bean B", "grams": nil}}}, "beanMix[1].grams")
	check("zero grams", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"grams": float64(0)})}}, "beanMix[1].grams")
	check("negative grams", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"grams": float64(-2)})}}, "beanMix[1].grams")
	check("too many grams", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"grams": float64(100.5)})}}, "beanMix[1].grams")
	check("grams not a number", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"grams": "8"})}}, "beanMix[1].grams")
	check("beanId not an integer", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"beanId": float64(7.5)})}}, "beanMix[1].beanId")
	check("beanId not a number", map[string]any{"beanMix": []any{part(nil), part(map[string]any{"beanId": "7"})}}, "beanMix[1].beanId")
	check("duplicate beanId", map[string]any{"beanMix": []any{part(map[string]any{"beanId": float64(12)}), part(map[string]any{"beanId": float64(12), "coffee": "Bean B"})}}, "beanMix[1].beanId")
}

// longCoffee returns a coffee name of exactly n runes, for the length cap tests.
func longCoffee(n int) string {
	out := make([]rune, n)
	for i := range out {
		out[i] = 'a'
	}
	return string(out)
}

func TestGetAnnotatedDoses_SplitsBeanMix(t *testing.T) {
	_, _, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1700000000, nil, "V60", nil, mixAnnotation())
	insertShot(t, sqlDB, 2, 1700000100, nil, "V60", nil, map[string]any{"coffee": "Single Bean", "beanId": float64(3), "dose": float64(20)})

	rows, err := NewRepository(sqlDB).GetAnnotatedDoses()
	if err != nil {
		t.Fatalf("GetAnnotatedDoses: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d dose rows, want 3 (two mix parts + one single bean): %+v", len(rows), rows)
	}

	byBean := map[int64]AnnotatedDose{}
	for _, row := range rows {
		if row.BeanID == nil || row.Dose == nil {
			t.Fatalf("row %+v has a nil BeanID/Dose", row)
		}
		byBean[*row.BeanID] = row
	}
	if got := byBean[12]; got.Coffee != "Bean A" || *got.Dose != 10 || got.Timestamp != 1700000000 {
		t.Errorf("bean 12 row = %+v, want Bean A / 10 g / ts 1700000000", got)
	}
	if got := byBean[7]; got.Coffee != "Bean B" || *got.Dose != 8 || got.Timestamp != 1700000000 {
		t.Errorf("bean 7 row = %+v, want Bean B / 8 g / ts 1700000000", got)
	}
	// The mixed shot's top-level dose (18) must not appear as an extra row for
	// the primary bean: bean 12 carries its 10 g share only.
	if got := byBean[3]; got.Coffee != "Single Bean" || *got.Dose != 20 || got.Timestamp != 1700000100 {
		t.Errorf("bean 3 row = %+v, want the unchanged single-bean tuple", got)
	}
}

func TestGetAnnotatedDoses_SingleBeanUnchanged(t *testing.T) {
	_, _, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1700000000, nil, "V60", nil, map[string]any{"coffee": "Single Bean", "beanId": float64(3), "dose": float64(20)})
	insertShot(t, sqlDB, 2, 1700000100, nil, "V60", nil, map[string]any{"coffee": "No Bean ID"})

	rows, err := NewRepository(sqlDB).GetAnnotatedDoses()
	if err != nil {
		t.Fatalf("GetAnnotatedDoses: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2: %+v", len(rows), rows)
	}
	if rows[0].Coffee != "Single Bean" || rows[0].BeanID == nil || *rows[0].BeanID != 3 || rows[0].Dose == nil || *rows[0].Dose != 20 {
		t.Errorf("first row = %+v, want the unchanged single-bean tuple", rows[0])
	}
	if rows[1].Coffee != "No Bean ID" || rows[1].BeanID != nil || rows[1].Dose != nil {
		t.Errorf("second row = %+v, want coffee only with nil BeanID/Dose", rows[1])
	}
}

func TestGetAnnotatedDoses_ExcludesTrashedMixedShot(t *testing.T) {
	_, _, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1700000000, nil, "V60", nil, mixAnnotation())
	insertTrashEntry(t, sqlDB, 1, 1700000500)

	rows, err := NewRepository(sqlDB).GetAnnotatedDoses()
	if err != nil {
		t.Fatalf("GetAnnotatedDoses: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("got %d rows for a trashed mixed shot, want 0: %+v", len(rows), rows)
	}
}

func TestGetAnnotatedDoses_MalformedBeanMixFallsBackToSingleRow(t *testing.T) {
	_, _, sqlDB := newTestHandlers(t)
	mix := []any{map[string]any{"coffee": "Bean A", "grams": float64(10)}}
	insertShot(t, sqlDB, 1, 1700000000, nil, "V60", nil, map[string]any{"coffee": "Bean A", "beanId": float64(12), "dose": float64(18), "beanMix": mix})

	rows, err := NewRepository(sqlDB).GetAnnotatedDoses()
	if err != nil {
		t.Fatalf("GetAnnotatedDoses: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 (a one-part mix is not a mix): %+v", len(rows), rows)
	}
	if rows[0].Coffee != "Bean A" || rows[0].Dose == nil || *rows[0].Dose != 18 {
		t.Errorf("row = %+v, want the top-level single-bean tuple", rows[0])
	}
}
