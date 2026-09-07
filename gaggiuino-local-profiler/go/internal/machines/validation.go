package machines

import (
	"encoding/json"
	"fmt"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// This file ports lib/validation/schemas.js's machine-profile-input Zod
// schemas (phaseSchema/transitionSchema/phaseStopConditionsSchema/
// globalStopConditionsSchema/brewRecipeSchema/profileSchema) as plain Go
// structs with pointer fields for every zod `.optional()` — nil means
// "omitted", matching a request body that simply left the key out — plus
// toWireProfile(), the Go port of gaggiuino-ws-client.js's function of the
// same name: unlike proto.ProfileDto's own decode-path pointer semantics
// (nil = absent from the wire, see messages.go), toWireProfile()
// unconditionally builds a Target/StopConditions object for every phase —
// defaulting every unset field to zero — since that's what the Node
// original does (`target: {start: p.target?.start || 0, ...}`, never
// `undefined`). Only GlobalStopConditions/Recipe stay conditional
// (`profile.x ? {...} : undefined`), matching toWireProfile() exactly.

// TransitionInput ports transitionSchema.
type TransitionInput struct {
	Start  *float64               `json:"start"`
	End    *float64               `json:"end"`
	Curve  *proto.TransitionCurve `json:"curve"`
	Time   *float64               `json:"time"`
	Volume *float64               `json:"volume"`
}

// PhaseStopConditionsInput ports phaseStopConditionsSchema.
type PhaseStopConditionsInput struct {
	Time               *float64 `json:"time"`
	PressureAbove      *float64 `json:"pressureAbove"`
	PressureBelow      *float64 `json:"pressureBelow"`
	FlowAbove          *float64 `json:"flowAbove"`
	FlowBelow          *float64 `json:"flowBelow"`
	Weight             *float64 `json:"weight"`
	WaterPumpedInPhase *float64 `json:"waterPumpedInPhase"`
}

// PhaseInput ports phaseSchema. Type has no pointer/omitempty — zod's
// phaseTypeSchema is required (no `.optional()`) — but a JSON body that
// omits it entirely decodes to the Go zero value (proto.PhaseFlow) rather
// than a validation error the way zod's required-field check would 400;
// see doc.go for this documented, minor validation-parity gap.
type PhaseInput struct {
	Name             *string                   `json:"name"`
	Type             proto.PhaseType           `json:"type"`
	Target           *TransitionInput          `json:"target"`
	Restriction      *float64                  `json:"restriction"`
	StopConditions   *PhaseStopConditionsInput `json:"stopConditions"`
	WaterTemperature *float64                  `json:"waterTemperature"`
	Skip             *bool                     `json:"skip"`
}

// GlobalStopConditionsInput ports globalStopConditionsSchema.
type GlobalStopConditionsInput struct {
	Time                       *float64 `json:"time"`
	Weight                     *float64 `json:"weight"`
	WaterPumped                *float64 `json:"waterPumped"`
	SwitchToManualPressureCtrl *bool    `json:"switchToManualPressureCtrl"`
	SwitchToManuaFlowCtrl      *bool    `json:"switchToManuaFlowCtrl"`
}

// BrewRecipeInput ports brewRecipeSchema.
type BrewRecipeInput struct {
	CoffeeIn  *float64 `json:"coffeeIn"`
	CoffeeOut *float64 `json:"coffeeOut"`
	Ratio     *float64 `json:"ratio"`
}

// ProfileInput ports profileSchema — the request body shape for
// POST/PUT /api/machine/profile[/{id}]. MachineID is read directly off the
// decoded body by handlers.go (mirrors req.body?.machineId), not part of
// the wire conversion.
//
// RawBody is set by handlers_profiles.go from the original request bytes —
// not decoded from JSON — so GaggiMate's CreateProfile/UpdateProfile can
// pass the profile through unmodified (GaggiMate has its own JSON shape,
// unrelated to Gaggiuino's Phases/GlobalStopConditions structure).
type ProfileInput struct {
	ID                   *int64                     `json:"id"`
	Name                 string                     `json:"name"`
	Phases               []PhaseInput               `json:"phases"`
	GlobalStopConditions *GlobalStopConditionsInput `json:"globalStopConditions"`
	WaterTemperature     *float64                   `json:"waterTemperature"`
	Recipe               *BrewRecipeInput           `json:"recipe"`
	MachineID            *int64                     `json:"machineId"`
	RawBody              json.RawMessage            `json:"-"`
}

const maxProfileNameLen = 200
const maxPhaseNameLen = 100

// Validate ports profileSchema's structural checks (z.string().min(1).max(200)
// for name, z.array(phaseSchema).min(1) for phases, phaseSchema's
// z.string().max(100).optional() for each phase name). Numeric fields have
// no bounds in the zod schema either, so none are enforced here.
func (p ProfileInput) Validate() error {
	if len(p.Name) < 1 || len(p.Name) > maxProfileNameLen {
		return fmt.Errorf("name must be 1-%d characters", maxProfileNameLen)
	}
	if len(p.Phases) < 1 {
		return fmt.Errorf("phases must have at least 1 entry")
	}
	for i, ph := range p.Phases {
		if ph.Name != nil && len(*ph.Name) > maxPhaseNameLen {
			return fmt.Errorf("phases[%d].name must be at most %d characters", i, maxPhaseNameLen)
		}
	}
	return nil
}

// validateGaggiMateProfileBody checks the minimum structural requirements for a
// GaggiMate profile JSON before it is forwarded to the device. GaggiMate uses
// "label" (not "name") and "phases" (same as Gaggiuino's phases field).
func validateGaggiMateProfileBody(raw json.RawMessage) error {
	var p struct {
		Label  string `json:"label"`
		Phases []any  `json:"phases"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if len(p.Label) < 1 || len(p.Label) > maxProfileNameLen {
		return fmt.Errorf("label must be 1-%d characters", maxProfileNameLen)
	}
	if len(p.Phases) < 1 {
		return fmt.Errorf("phases must have at least 1 entry")
	}
	return nil
}

// injectIDIfAbsent injects {"id":<pathID>} into a GaggiMate profile JSON body
// when the body carries no "id" key. A body that already has an id (even null)
// is returned unchanged — the client's explicit value wins.
func injectIDIfAbsent(raw json.RawMessage, pathID string) json.RawMessage {
	if pathID == "" {
		return raw
	}
	var check map[string]json.RawMessage
	if err := json.Unmarshal(raw, &check); err != nil {
		return raw
	}
	if _, ok := check["id"]; ok {
		return raw
	}
	idJSON, err := json.Marshal(pathID)
	if err != nil {
		return raw
	}
	check["id"] = idJSON
	out, err := json.Marshal(check)
	if err != nil {
		return raw
	}
	return out
}

func floatOr(p *float64, def float64) float64 {
	if p == nil {
		return def
	}
	return *p
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

// toWirePhase ports toWireProfile()'s per-phase mapping.
func (ph PhaseInput) toWirePhase() proto.PhaseDto {
	name := ""
	if ph.Name != nil {
		name = *ph.Name
	}

	target := &proto.TransitionDto{}
	if ph.Target != nil {
		target.Start = floatOr(ph.Target.Start, 0)
		target.End = floatOr(ph.Target.End, 0)
		if ph.Target.Curve != nil {
			target.Curve = *ph.Target.Curve
		}
		target.Time = uint32(floatOr(ph.Target.Time, 0))
		target.Volume = floatOr(ph.Target.Volume, 0)
	}

	stop := &proto.PhaseStopConditionsDto{}
	if ph.StopConditions != nil {
		sc := ph.StopConditions
		stop.Time = uint32(floatOr(sc.Time, 0))
		stop.PressureAbove = floatOr(sc.PressureAbove, 0)
		stop.PressureBelow = floatOr(sc.PressureBelow, 0)
		stop.FlowAbove = floatOr(sc.FlowAbove, 0)
		stop.FlowBelow = floatOr(sc.FlowBelow, 0)
		stop.Weight = floatOr(sc.Weight, 0)
		stop.WaterPumpedInPhase = floatOr(sc.WaterPumpedInPhase, 0)
	}

	return proto.PhaseDto{
		Type:             ph.Type,
		Target:           target,
		Restriction:      floatOr(ph.Restriction, 0),
		StopConditions:   stop,
		WaterTemperature: floatOr(ph.WaterTemperature, 0),
		Name:             name,
		Skip:             boolOr(ph.Skip, false),
	}
}

// ToWireProfile ports gaggiuino-ws-client.js's toWireProfile(profile).
func (p ProfileInput) ToWireProfile() *proto.ProfileDto {
	var id uint32
	if p.ID != nil {
		id = uint32(*p.ID)
	}

	phases := make([]proto.PhaseDto, len(p.Phases))
	for i, ph := range p.Phases {
		phases[i] = ph.toWirePhase()
	}

	wire := &proto.ProfileDto{
		ID:               id,
		Name:             p.Name,
		Phases:           phases,
		WaterTemperature: floatOr(p.WaterTemperature, 0),
	}

	if p.GlobalStopConditions != nil {
		g := p.GlobalStopConditions
		wire.GlobalStopConditions = &proto.GlobalStopConditionsDto{
			Time:                       uint32(floatOr(g.Time, 0)),
			Weight:                     floatOr(g.Weight, 0),
			WaterPumped:                floatOr(g.WaterPumped, 0),
			SwitchToManualPressureCtrl: boolOr(g.SwitchToManualPressureCtrl, false),
			SwitchToManuaFlowCtrl:      boolOr(g.SwitchToManuaFlowCtrl, false),
		}
	}
	if p.Recipe != nil {
		rc := p.Recipe
		wire.Recipe = &proto.BrewRecipeDto{
			CoffeeIn:  floatOr(rc.CoffeeIn, 0),
			CoffeeOut: floatOr(rc.CoffeeOut, 0),
			Ratio:     floatOr(rc.Ratio, 0),
		}
	}
	return wire
}

// ── #597 settings/control proxy input validation ────────────────────────

// ValidateOperationMode ports operationModeSchema: BREW_MANUAL (1) is
// rejected (live-verified silent no-op while idle — see
// lib/machines/gaggiuino/adapter.js's setOperationMode() doc comment), and
// the value must otherwise be a defined OperationModeDto value (0-7).
func ValidateOperationMode(m proto.OperationMode) error {
	if m == proto.ModeBrewManual {
		return fmt.Errorf("BREW_MANUAL (1) is not supported via this proxy")
	}
	if m < proto.ModeBrewAuto || m > proto.ModeHome {
		return fmt.Errorf("invalid operation mode")
	}
	return nil
}

// ValidateServiceTestPeripheral ports serviceTestPeripheralSchema.
func ValidateServiceTestPeripheral(p proto.ServiceTestPeripheral) error {
	if p < proto.PeripheralPump || p > proto.PeripheralLED {
		return fmt.Errorf("invalid peripheral")
	}
	return nil
}

// ValidateSettingsPayload ports settingsPayloadSchema (z.record(z.string(),
// z.any()) — opaque JSON, only checked for being a JSON object). Passed
// straight through to the machine's own REST endpoint unmodified — see
// doc.go's bool-as-string quirk section for why this stays json.RawMessage
// rather than a typed struct all the way through.
func ValidateSettingsPayload(body json.RawMessage) error {
	_, err := decodeSettingsObject(body)
	return err
}
