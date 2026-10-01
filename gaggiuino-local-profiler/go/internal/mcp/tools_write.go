package mcp

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// The write tools are a separate, opt-in slice: they only exist when both the
// MCP master switch and the stored allowWrite toggle are on (mcp_settings,
// #1288). Each merges or appends into existing state rather than replacing it,
// is persisted immediately, and reports bad input or unknown ids as tool
// execution errors. No deletes, no trash, no machine control, no settings.
const (
	maxAnnotateNotes    = 2000
	maxGrinderNameLen   = 200
	maxGrindSettingLen  = 50
	maxMaintenanceNotes = 500
)

// writeAnnotations describes a write tool: never read-only, never open-world,
// and explicitly non-destructive. idempotent distinguishes tools that converge
// on the same state (annotate_shot, set_known_grind) from
// mark_maintenance_done, which appends a maintenance-log entry every call.
func writeAnnotations(title string, idempotent bool) *mcpsdk.ToolAnnotations {
	destructive := false
	openWorld := false
	return &mcpsdk.ToolAnnotations{
		Title:           title,
		ReadOnlyHint:    false,
		IdempotentHint:  idempotent,
		DestructiveHint: &destructive,
		OpenWorldHint:   &openWorld,
	}
}

// ── annotate_shot ─────────────────────────────────────────────────────────

type annotateShotInput struct {
	ID           int64   `json:"id" jsonschema:"the id of the shot to annotate; use list_shots to find ids"`
	Rating       *int    `json:"rating,omitempty" jsonschema:"the user's 1-5 star rating; omit to leave the stored rating unchanged"`
	Notes        *string `json:"notes,omitempty" jsonschema:"free-text notes, up to 2000 characters; omit to leave them unchanged, pass an empty string to clear"`
	GrindSetting *string `json:"grind_setting,omitempty" jsonschema:"free-text grinder setting (dial/click position), up to 50 characters; omit to leave it unchanged"`
}

type annotateShotOutput struct {
	ID           int64   `json:"id" jsonschema:"the annotated shot's id"`
	Rating       *int    `json:"rating,omitempty" jsonschema:"the shot's 1-5 star rating after the change"`
	Notes        *string `json:"notes,omitempty" jsonschema:"the shot's notes after the change"`
	GrindSetting *string `json:"grind_setting,omitempty" jsonschema:"the shot's grinder setting after the change"`
}

// ── set_known_grind ───────────────────────────────────────────────────────

type setKnownGrindInput struct {
	BeanID       int64  `json:"bean_id" jsonschema:"the bean whose known grind setting to record; use list_beans to find ids"`
	Grinder      string `json:"grinder" jsonschema:"the grinder the setting applies to, matched case-insensitively"`
	GrindSetting string `json:"grind_setting" jsonschema:"the remembered winning grind setting (dial/click position)"`
}

type setKnownGrindOutput struct {
	BeanID             int64               `json:"bean_id" jsonschema:"the updated bean's id"`
	BeanName           string              `json:"bean_name" jsonschema:"the updated bean's name"`
	KnownGrindSettings []knownGrindSetting `json:"known_grind_settings" jsonschema:"the bean's known grind settings after the change, newest first"`
}

// ── mark_maintenance_done ─────────────────────────────────────────────────

type markMaintenanceDoneInput struct {
	Task      string `json:"task" jsonschema:"the maintenance task to mark done"`
	MachineID int64  `json:"machine_id,omitempty" jsonschema:"the machine the task belongs to; omit or 0 for the default machine"`
	Notes     string `json:"notes,omitempty" jsonschema:"optional free-text note stored with the maintenance-log entry, up to 500 characters"`
}

type markMaintenanceDoneOutput struct {
	Task       string `json:"task" jsonschema:"the canonical task key that was marked done"`
	MachineID  int64  `json:"machine_id" jsonschema:"the machine the task was marked done for"`
	Status     string `json:"status" jsonschema:"recomputed due state after the change: due, soon, ok or never"`
	ShotsSince int    `json:"shots_since" jsonschema:"shots pulled since the task was last marked done"`
	DaysSince  *int64 `json:"days_since,omitempty" jsonschema:"days since the task was last marked done"`
}

func registerWriteTools(srv *mcpsdk.Server, deps Deps) {
	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "annotate_shot",
		Title:        "Annotate shot",
		Description:  "Change one shot's annotation: its 1-5 star rating, free-text notes and free-text grinder setting (dial/click position). Only the fields you pass change; every other stored field (bean, dose, order info, ...) is preserved. The change is persisted immediately. Provide at least one field.",
		Annotations:  writeAnnotations("Annotate shot", true),
		InputSchema:  annotateShotSchema(),
		OutputSchema: mustSchema[annotateShotOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in annotateShotInput) (*mcpsdk.CallToolResult, annotateShotOutput, error) {
		out, err := annotateShot(deps, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "set_known_grind",
		Title:        "Set known grind",
		Description:  "Remember a bean's winning grind setting for a grinder: inserts a new (grinder, setting) entry or overwrites the existing one for that grinder, kept newest first and capped at 10. Grinder names are matched case-insensitively. The change is persisted immediately.",
		Annotations:  writeAnnotations("Set known grind", true),
		InputSchema:  setKnownGrindSchema(),
		OutputSchema: mustSchema[setKnownGrindOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in setKnownGrindInput) (*mcpsdk.CallToolResult, setKnownGrindOutput, error) {
		out, err := setKnownGrind(deps, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "mark_maintenance_done",
		Title:        "Mark maintenance done",
		Description:  "Mark a maintenance task as done now: stamps the task's last-done time and appends a maintenance-log entry, both persisted immediately. The response is the task's recomputed state (status, shots and days since). Task is one of the static tasks listed in the schema; the optional note is stored with the log entry.",
		Annotations:  writeAnnotations("Mark maintenance done", false),
		InputSchema:  markMaintenanceDoneSchema(),
		OutputSchema: mustSchema[markMaintenanceDoneOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in markMaintenanceDoneInput) (*mcpsdk.CallToolResult, markMaintenanceDoneOutput, error) {
		out, err := markMaintenanceDone(deps, in)
		return nil, out, err
	})
}

func annotateShotSchema() *jsonschema.Schema {
	s := mustSchema[annotateShotInput]()
	if p := schemaProp(s, "rating"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(5.0)
	}
	if p := schemaProp(s, "notes"); p != nil {
		p.MaxLength = jsonschema.Ptr(maxAnnotateNotes)
	}
	if p := schemaProp(s, "grind_setting"); p != nil {
		p.MaxLength = jsonschema.Ptr(maxGrindSettingLen)
	}
	return s
}

func setKnownGrindSchema() *jsonschema.Schema {
	s := mustSchema[setKnownGrindInput]()
	if p := schemaProp(s, "grinder"); p != nil {
		p.MinLength = jsonschema.Ptr(1)
		p.MaxLength = jsonschema.Ptr(maxGrinderNameLen)
	}
	if p := schemaProp(s, "grind_setting"); p != nil {
		p.MinLength = jsonschema.Ptr(1)
		p.MaxLength = jsonschema.Ptr(maxGrindSettingLen)
	}
	return s
}

func markMaintenanceDoneSchema() *jsonschema.Schema {
	s := mustSchema[markMaintenanceDoneInput]()
	if p := schemaProp(s, "task"); p != nil {
		p.Enum = stringEnum(maintenance.StaticTaskKeys())
	}
	if p := schemaProp(s, "notes"); p != nil {
		p.MaxLength = jsonschema.Ptr(maxMaintenanceNotes)
	}
	if p := schemaProp(s, "machine_id"); p != nil {
		p.Minimum = jsonschema.Ptr(0.0)
	}
	return s
}

func stringEnum(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

func annotateShot(deps Deps, in annotateShotInput) (annotateShotOutput, error) {
	if deps.Shots == nil || deps.ShotsRepo == nil {
		return annotateShotOutput{}, fmt.Errorf("shot history is not available")
	}
	if in.Rating == nil && in.Notes == nil && in.GrindSetting == nil {
		return annotateShotOutput{}, fmt.Errorf("nothing to change: provide at least one of rating, notes or grind_setting")
	}
	// Check existence first so an unknown id reports the same actionable error
	// the read tools do, instead of relying on the annotations FK failure.
	shot, err := deps.Shots.GetByID(in.ID)
	if err != nil {
		log.Printf("mcp: annotate_shot %d: %v", in.ID, err)
		return annotateShotOutput{}, fmt.Errorf("could not read shot %d; try again", in.ID)
	}
	if shot == nil {
		return annotateShotOutput{}, fmt.Errorf("shot %d not found; use list_shots to find ids", in.ID)
	}
	// Merge, never replace: UpdateAnnotation reads, overlays only the provided
	// fields (so keys this tool doesn't know — orderedBy, beanId, recipeId, ... —
	// survive untouched) and writes the result under one lock (#1273).
	ann, err := deps.ShotsRepo.UpdateAnnotation(in.ID, func(ann map[string]any) error {
		if in.Rating != nil {
			ann["rating"] = float64(*in.Rating)
		}
		if in.Notes != nil {
			ann["notes"] = *in.Notes
		}
		if in.GrindSetting != nil {
			ann["grindSetting"] = *in.GrindSetting
		}
		if issues := shots.ValidateAnnotation(ann); len(issues) > 0 {
			return &shots.AnnotationValidationError{Issues: issues}
		}
		return nil
	})
	if err != nil {
		var verr *shots.AnnotationValidationError
		if errors.As(err, &verr) {
			return annotateShotOutput{}, fmt.Errorf("invalid annotation: %s", formatValidationIssues(verr.Issues))
		}
		log.Printf("mcp: annotate_shot %d: saving: %v", in.ID, err)
		return annotateShotOutput{}, fmt.Errorf("could not save the annotation for shot %d; try again", in.ID)
	}
	if ann == nil {
		ann = map[string]any{}
	}
	out := annotateShotOutput{ID: in.ID}
	if rating, ok := annotationRating(ann); ok {
		out.Rating = &rating
	}
	if notes, ok := ann["notes"].(string); ok {
		out.Notes = &notes
	}
	if setting, ok := ann["grindSetting"].(string); ok {
		out.GrindSetting = &setting
	}
	return out, nil
}

func setKnownGrind(deps Deps, in setKnownGrindInput) (setKnownGrindOutput, error) {
	if deps.Library == nil {
		return setKnownGrindOutput{}, fmt.Errorf("the coffee library is not available")
	}
	grinder := strings.TrimSpace(in.Grinder)
	grindSetting := strings.TrimSpace(in.GrindSetting)
	if grinder == "" {
		return setKnownGrindOutput{}, fmt.Errorf("grinder is required")
	}
	if grindSetting == "" {
		return setKnownGrindOutput{}, fmt.Errorf("grind_setting is required")
	}
	var bean library.Entity
	err := deps.Library.Update(func(lib *library.Library) error {
		var found bool
		bean, found = library.UpsertKnownGrindSetting(lib, in.BeanID, grinder, grindSetting)
		if !found {
			return library.ErrSkipSave
		}
		return nil
	})
	if errors.Is(err, library.ErrSkipSave) {
		return setKnownGrindOutput{}, fmt.Errorf("bean %d not found; use list_beans to find ids", in.BeanID)
	}
	if err != nil {
		log.Printf("mcp: set_known_grind: updating library: %v", err)
		return setKnownGrindOutput{}, fmt.Errorf("could not update the coffee library; try again")
	}
	return setKnownGrindOutput{
		BeanID:             in.BeanID,
		BeanName:           entityStr(bean, "name"),
		KnownGrindSettings: knownGrinds(bean),
	}, nil
}

func markMaintenanceDone(deps Deps, in markMaintenanceDoneInput) (markMaintenanceDoneOutput, error) {
	if deps.Maintenance == nil || deps.ShotsRepo == nil || deps.Library == nil || deps.Registry == nil {
		return markMaintenanceDoneOutput{}, fmt.Errorf("maintenance data is not available")
	}
	machineID := in.MachineID
	if machineID == 0 {
		if err := deps.Registry.EnsureDefaultMachine(); err != nil {
			log.Printf("mcp: mark_maintenance_done: ensuring default machine: %v", err)
			return markMaintenanceDoneOutput{}, fmt.Errorf("could not resolve the default machine; try again")
		}
		id, err := defaultMachineID(deps.Registry)
		if err != nil {
			log.Printf("mcp: mark_maintenance_done: resolving default machine: %v", err)
			return markMaintenanceDoneOutput{}, fmt.Errorf("could not resolve the default machine; try again")
		}
		machineID = id
	} else {
		m, err := deps.Registry.GetMachine(machineID)
		if err != nil {
			log.Printf("mcp: mark_maintenance_done: machine %d: %v", machineID, err)
			return markMaintenanceDoneOutput{}, fmt.Errorf("could not read machines; try again")
		}
		if m == nil {
			return markMaintenanceDoneOutput{}, fmt.Errorf("machine %d not found; use get_machine_status to list machine ids", machineID)
		}
	}
	stats, err := maintenance.MarkTaskDone(deps.Maintenance, deps.ShotsRepo, deps.Library, deps.Registry, in.Task, in.Notes, machineID)
	if err != nil {
		if errors.Is(err, maintenance.ErrUnknownTask) {
			return markMaintenanceDoneOutput{}, fmt.Errorf("unknown maintenance task %q; use one of %s", in.Task, strings.Join(maintenance.StaticTaskKeys(), ", "))
		}
		log.Printf("mcp: mark_maintenance_done: task %q on machine %d: %v", in.Task, machineID, err)
		return markMaintenanceDoneOutput{}, fmt.Errorf("could not mark the maintenance task done; try again")
	}
	stat := stats[in.Task]
	out := markMaintenanceDoneOutput{
		Task:      in.Task,
		MachineID: machineID,
		Status:    statString(stat, "status"),
	}
	if v, ok := statInt(stat, "shotsSince"); ok {
		out.ShotsSince = boundedInt(v)
	}
	if v, ok := statInt(stat, "daysSince"); ok {
		out.DaysSince = &v
	}
	return out, nil
}

func formatValidationIssues(issues []shots.ValidationIssue) string {
	parts := make([]string, 0, len(issues))
	for _, issue := range issues {
		parts = append(parts, issue.Path+": "+issue.Message)
	}
	return strings.Join(parts, "; ")
}

// annotationRating reads a stored annotation value as a 1-5 rating, rejecting
// out-of-range and fractional numbers the same way the read tools do.
func annotationRating(ann map[string]any) (int, bool) {
	switch v := ann["rating"].(type) {
	case float64:
		if !(v >= 1 && v <= 5) || v != math.Trunc(v) {
			return 0, false
		}
		return int(v), true
	case int:
		if v < 1 || v > 5 {
			return 0, false
		}
		return v, true
	default:
		return 0, false
	}
}
