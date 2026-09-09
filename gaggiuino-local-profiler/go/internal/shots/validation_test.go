package shots

import "testing"

func hasIssue(issues []ValidationIssue, path string) bool {
	for _, i := range issues {
		if i.Path == path {
			return true
		}
	}
	return false
}

func TestValidateAnnotation_ValidFullPayload(t *testing.T) {
	body := map[string]any{
		"coffee":          "Some Bean",
		"grindSetting":    "12",
		"notes":           "tasty",
		"drinkType":       nil, // explicit null must be accepted (nullable)
		"milkType":        float64(1700000000123),
		"rating":          float64(5),
		"score":           float64(87.5),
		"recipeId":        float64(42),
		"beanId":          float64(1),
		"beanBagId":       nil,
		"frozenPortionId": nil,
		"basketId":        float64(2),
		"puckScreenId":    float64(3),
		// passthrough field score.js reads but the schema never declares —
		// must not produce an issue.
		"dose": float64(18.5),
		"tds":  float64(9.2),
	}
	if issues := ValidateAnnotation(body); len(issues) != 0 {
		t.Errorf("expected no issues, got %+v", issues)
	}
}

func TestValidateAnnotation_EmptyBodyIsValid(t *testing.T) {
	// Every annotationSchema field is .optional() — an empty object must
	// validate cleanly (a shot can be annotated with nothing at all).
	if issues := ValidateAnnotation(map[string]any{}); len(issues) != 0 {
		t.Errorf("expected no issues for an empty body, got %+v", issues)
	}
}

func TestValidateAnnotation_RatingOutOfRange(t *testing.T) {
	for _, v := range []float64{0, 6, -1} {
		issues := ValidateAnnotation(map[string]any{"rating": v})
		if !hasIssue(issues, "rating") {
			t.Errorf("rating=%v: expected a rating issue, got %+v", v, issues)
		}
	}
}

func TestValidateAnnotation_WrongTypes(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
		path string
	}{
		{"coffee not a string", map[string]any{"coffee": float64(5)}, "coffee"},
		{"beanId not an integer", map[string]any{"beanId": float64(1.5)}, "beanId"},
		{"beanId not a number", map[string]any{"beanId": "1"}, "beanId"},
		{"rating null but not nullable-violating (should pass)", map[string]any{"rating": nil}, ""},
		{"notes too long", map[string]any{"notes": stringOfLen(2001)}, "notes"},
		{"coffee too long", map[string]any{"coffee": stringOfLen(201)}, "coffee"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := ValidateAnnotation(c.body)
			if c.path == "" {
				if len(issues) != 0 {
					t.Errorf("expected no issues, got %+v", issues)
				}
				return
			}
			if !hasIssue(issues, c.path) {
				t.Errorf("expected an issue on %q, got %+v", c.path, issues)
			}
		})
	}
}

func TestValidateAnnotation_NonNullableRejectsNull(t *testing.T) {
	// coffee/grindSetting/notes are optional but NOT nullable in the Zod
	// schema (no .nullable()) — an explicit null must fail, unlike an
	// absent key.
	issues := ValidateAnnotation(map[string]any{"coffee": nil})
	if !hasIssue(issues, "coffee") {
		t.Errorf("expected explicit null on non-nullable coffee to fail, got %+v", issues)
	}
}

func TestValidateShotDefaults_Valid(t *testing.T) {
	body := map[string]any{
		"drinkType":    "espresso",
		"coffee":       nil,
		"beanId":       float64(7),
		"basketId":     nil,
		"puckScreenId": nil,
		"grinder":      "Niche Zero",
		"dose":         float64(18),
	}
	if issues := ValidateShotDefaults(body); len(issues) != 0 {
		t.Errorf("expected no issues, got %+v", issues)
	}
}

func TestValidateShotDefaults_DoseMustBePositive(t *testing.T) {
	for _, v := range []float64{0, -1} {
		issues := ValidateShotDefaults(map[string]any{"dose": v})
		if !hasIssue(issues, "dose") {
			t.Errorf("dose=%v: expected a dose issue, got %+v", v, issues)
		}
	}
}

func TestValidateShotDefaults_DoseNullIsFine(t *testing.T) {
	if issues := ValidateShotDefaults(map[string]any{"dose": nil}); len(issues) != 0 {
		t.Errorf("expected null dose to be valid (nullable), got %+v", issues)
	}
}

func stringOfLen(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'x'
	}
	return string(b)
}
