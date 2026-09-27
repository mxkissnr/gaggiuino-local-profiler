package library

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

func scoreBeanShot(ann map[string]any) shots.Shot {
	if ann == nil {
		return shots.Shot{}
	}
	return shots.Shot{"annotation": ann}
}

func TestScoreBean_BeanIDMatch(t *testing.T) {
	beans := []Entity{
		{"id": 1.0, "name": "First", "brewTempC": 88.0},
		{"id": 2.0, "name": "Second", "brewTempC": 93.5, "brewRatio": "1:2.2"},
	}
	bean := ScoreBean(scoreBeanShot(map[string]any{"beanId": 2.0, "coffee": "First"}), beans)
	if bean == nil {
		t.Fatal("expected a bean for a matching beanId")
	}
	if bean.BrewTempC == nil || *bean.BrewTempC != 93.5 {
		t.Errorf("BrewTempC = %v, want 93.5 (beanId wins over the coffee name)", bean.BrewTempC)
	}
	if bean.BrewRatio != "1:2.2" {
		t.Errorf("BrewRatio = %q, want 1:2.2", bean.BrewRatio)
	}
}

func TestScoreBean_CoffeeNameFallbackCaseInsensitive(t *testing.T) {
	beans := []Entity{{"id": 1.0, "name": "Ethiopia Guji", "brewTempC": 91.0}}
	bean := ScoreBean(scoreBeanShot(map[string]any{"coffee": "ethiopia guji"}), beans)
	if bean == nil {
		t.Fatal("expected a bean from a case-insensitive coffee-name match")
	}
	if bean.BrewTempC == nil || *bean.BrewTempC != 91.0 {
		t.Errorf("BrewTempC = %v, want 91.0", bean.BrewTempC)
	}
}

func TestScoreBean_NoAnnotation(t *testing.T) {
	if bean := ScoreBean(scoreBeanShot(nil), []Entity{{"id": 1.0, "brewTempC": 90.0}}); bean != nil {
		t.Errorf("expected nil for a shot without an annotation, got %+v", bean)
	}
}

func TestScoreBean_Unresolved(t *testing.T) {
	beans := []Entity{{"id": 1.0, "name": "Known"}}
	bean := ScoreBean(scoreBeanShot(map[string]any{"beanId": 7.0, "coffee": "Unknown"}), beans)
	if bean != nil {
		t.Errorf("expected nil when nothing matches, got %+v", bean)
	}
}

func TestScoreBean_BeanWithoutTargets(t *testing.T) {
	beans := []Entity{{"id": 3.0, "name": "No Targets"}}
	bean := ScoreBean(scoreBeanShot(map[string]any{"beanId": 3.0}), beans)
	if bean == nil {
		t.Fatal("expected a non-nil bean when the annotation resolves")
	}
	if bean.BrewTempC != nil {
		t.Errorf("BrewTempC = %v, want nil for a bean without a target", bean.BrewTempC)
	}
	if bean.BrewRatio != "" {
		t.Errorf("BrewRatio = %q, want empty for a bean without a target ratio", bean.BrewRatio)
	}
}

func TestScoreBean_NonPositiveTempIgnored(t *testing.T) {
	beans := []Entity{{"id": 4.0, "brewTempC": 0.0}}
	bean := ScoreBean(scoreBeanShot(map[string]any{"beanId": 4.0}), beans)
	if bean == nil {
		t.Fatal("expected a non-nil bean")
	}
	if bean.BrewTempC != nil {
		t.Errorf("BrewTempC = %v, want nil for a non-positive temperature", bean.BrewTempC)
	}
}

func TestResolveBeanForShot_IntBeanID(t *testing.T) {
	beans := []Entity{{"id": int64(5), "name": "Int ID"}}
	if got := ResolveBeanForShot(scoreBeanShot(map[string]any{"beanId": int64(5)}), beans); got == nil {
		t.Error("expected an in-memory int64 beanId to match")
	}
}
