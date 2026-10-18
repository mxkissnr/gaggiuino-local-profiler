package proto

import "fmt"

// Every message below mirrors one wire-schema MessageType verbatim — same
// field numbers, same names (camelCased the same way), same scalar-type/
// wire-kind mapping (the `T:` code: 2=float, 8=bool, 9=string, 12=bytes,
// 13=uint32 — see schema.proto's header comment for the full
// FieldDescriptorProto.Type table this maps against).
//
// Field types deliberately deviate from the wire's own bit width in one
// place: every `float` (wire: 32-bit fixed-point) field is a Go float64,
// not float32. This matches the reference implementation, which has no
// float32 type either — callers always get a float64 up-converted from the
// wire's 32 bits, including that up-conversion's imprecision (e.g. a wire
// value of 93.7f decodes to 93.69999694824219) — see node_vectors_test.go,
// which asserts this package reproduces that exact imprecision, not a
// "cleaner" float32-native one. The down-convert back to 32 bits happens
// only at the wire boundary (wire.go's floatField).
//
// Optional nested-message fields (PhaseDto.Target/StopConditions,
// ProfileDto.GlobalStopConditions/Recipe) are Go pointers: nil means
// "field absent from the wire" (and omitted from JSON via `omitempty`),
// matching the wire format's own `undefined` for an unset message field
// (verified: JSON.stringify of a decoded ProfileDto omits
// globalStopConditions/recipe entirely when the source never set them,
// rather than emitting an empty object). Repeated message fields
// (ProfileDto.Phases, SavedProfilesDto.Profiles) are plain (never nil)
// slices, initialized to length 0 by Unmarshal so JSON output is `[]`,
// not `null`, matching the wire format's own always-present-array behavior
// for an empty repeated field.

// ── Profile messages ────────────────────────────────────────────────────

// PhaseStopConditionsDto holds a phase's stop conditions.
type PhaseStopConditionsDto struct {
	Time               uint32  `json:"time"`
	PressureAbove      float64 `json:"pressureAbove"`
	PressureBelow      float64 `json:"pressureBelow"`
	FlowAbove          float64 `json:"flowAbove"`
	FlowBelow          float64 `json:"flowBelow"`
	Weight             float64 `json:"weight"`
	WaterPumpedInPhase float64 `json:"waterPumpedInPhase"`
}

func (m *PhaseStopConditionsDto) Marshal() []byte {
	w := &writer{}
	w.uint32Field(1, m.Time)
	w.floatField(2, m.PressureAbove)
	w.floatField(3, m.PressureBelow)
	w.floatField(4, m.FlowAbove)
	w.floatField(5, m.FlowBelow)
	w.floatField(6, m.Weight)
	w.floatField(7, m.WaterPumpedInPhase)
	return w.b
}

func (m *PhaseStopConditionsDto) Unmarshal(b []byte) error {
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Time = uint32(v)
		case 2:
			if m.PressureAbove, err = r.float(); err != nil {
				return err
			}
		case 3:
			if m.PressureBelow, err = r.float(); err != nil {
				return err
			}
		case 4:
			if m.FlowAbove, err = r.float(); err != nil {
				return err
			}
		case 5:
			if m.FlowBelow, err = r.float(); err != nil {
				return err
			}
		case 6:
			if m.Weight, err = r.float(); err != nil {
				return err
			}
		case 7:
			if m.WaterPumpedInPhase, err = r.float(); err != nil {
				return err
			}
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// TransitionDto describes a move from one phase's setpoint to the next.
type TransitionDto struct {
	Start  float64         `json:"start"`
	End    float64         `json:"end"`
	Curve  TransitionCurve `json:"curve"`
	Time   uint32          `json:"time"`
	Volume float64         `json:"volume"`
}

func (m *TransitionDto) Marshal() []byte {
	w := &writer{}
	w.floatField(1, m.Start)
	w.floatField(2, m.End)
	w.enumField(3, int32(m.Curve))
	w.uint32Field(4, m.Time)
	w.floatField(5, m.Volume)
	return w.b
}

func (m *TransitionDto) Unmarshal(b []byte) error {
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			if m.Start, err = r.float(); err != nil {
				return err
			}
		case 2:
			if m.End, err = r.float(); err != nil {
				return err
			}
		case 3:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Curve = TransitionCurve(int32(v))
		case 4:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Time = uint32(v)
		case 5:
			if m.Volume, err = r.float(); err != nil {
				return err
			}
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// PhaseDto is one phase of a brew profile.
type PhaseDto struct {
	Type             PhaseType               `json:"type"`
	Target           *TransitionDto          `json:"target,omitempty"`
	Restriction      float64                 `json:"restriction"`
	StopConditions   *PhaseStopConditionsDto `json:"stopConditions,omitempty"`
	WaterTemperature float64                 `json:"waterTemperature"`
	Name             string                  `json:"name"`
	Skip             bool                    `json:"skip"`
}

func (m *PhaseDto) Marshal() []byte {
	w := &writer{}
	w.enumField(1, int32(m.Type))
	if m.Target != nil {
		w.rawMessageField(2, m.Target.Marshal())
	}
	w.floatField(3, m.Restriction)
	if m.StopConditions != nil {
		w.rawMessageField(4, m.StopConditions.Marshal())
	}
	w.floatField(5, m.WaterTemperature)
	w.stringField(6, m.Name)
	w.boolField(7, m.Skip)
	return w.b
}

func (m *PhaseDto) Unmarshal(b []byte) error {
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Type = PhaseType(int32(v))
		case 2:
			payload, err := r.bytes()
			if err != nil {
				return err
			}
			m.Target = &TransitionDto{}
			if err := m.Target.Unmarshal(payload); err != nil {
				return fmt.Errorf("PhaseDto.target: %w", err)
			}
		case 3:
			if m.Restriction, err = r.float(); err != nil {
				return err
			}
		case 4:
			payload, err := r.bytes()
			if err != nil {
				return err
			}
			m.StopConditions = &PhaseStopConditionsDto{}
			if err := m.StopConditions.Unmarshal(payload); err != nil {
				return fmt.Errorf("PhaseDto.stopConditions: %w", err)
			}
		case 5:
			if m.WaterTemperature, err = r.float(); err != nil {
				return err
			}
		case 6:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.Name = string(b)
		case 7:
			if m.Skip, err = r.bool(); err != nil {
				return err
			}
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// GlobalStopConditionsDto holds a profile's global stop conditions.
type GlobalStopConditionsDto struct {
	Time                       uint32  `json:"time"`
	Weight                     float64 `json:"weight"`
	WaterPumped                float64 `json:"waterPumped"`
	SwitchToManualPressureCtrl bool    `json:"switchToManualPressureCtrl"`
	SwitchToManuaFlowCtrl      bool    `json:"switchToManuaFlowCtrl"`
}

func (m *GlobalStopConditionsDto) Marshal() []byte {
	w := &writer{}
	w.uint32Field(1, m.Time)
	w.floatField(2, m.Weight)
	w.floatField(3, m.WaterPumped)
	w.boolField(4, m.SwitchToManualPressureCtrl)
	w.boolField(5, m.SwitchToManuaFlowCtrl)
	return w.b
}

func (m *GlobalStopConditionsDto) Unmarshal(b []byte) error {
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Time = uint32(v)
		case 2:
			if m.Weight, err = r.float(); err != nil {
				return err
			}
		case 3:
			if m.WaterPumped, err = r.float(); err != nil {
				return err
			}
		case 4:
			if m.SwitchToManualPressureCtrl, err = r.bool(); err != nil {
				return err
			}
		case 5:
			if m.SwitchToManuaFlowCtrl, err = r.bool(); err != nil {
				return err
			}
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// BrewRecipeDto is a profile's brew recipe.
type BrewRecipeDto struct {
	CoffeeIn  float64 `json:"coffeeIn"`
	CoffeeOut float64 `json:"coffeeOut"`
	Ratio     float64 `json:"ratio"`
}

func (m *BrewRecipeDto) Marshal() []byte {
	w := &writer{}
	w.floatField(1, m.CoffeeIn)
	w.floatField(2, m.CoffeeOut)
	w.floatField(3, m.Ratio)
	return w.b
}

func (m *BrewRecipeDto) Unmarshal(b []byte) error {
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			if m.CoffeeIn, err = r.float(); err != nil {
				return err
			}
		case 2:
			if m.CoffeeOut, err = r.float(); err != nil {
				return err
			}
		case 3:
			if m.Ratio, err = r.float(); err != nil {
				return err
			}
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// ProfileDto is a brew profile.
type ProfileDto struct {
	Name                 string                   `json:"name"`
	Phases               []PhaseDto               `json:"phases"`
	GlobalStopConditions *GlobalStopConditionsDto `json:"globalStopConditions,omitempty"`
	WaterTemperature     float64                  `json:"waterTemperature"`
	Recipe               *BrewRecipeDto           `json:"recipe,omitempty"`
	ID                   uint32                   `json:"id"`
}

func (m *ProfileDto) Marshal() []byte {
	w := &writer{}
	w.stringField(1, m.Name)
	for i := range m.Phases {
		w.rawMessageField(2, m.Phases[i].Marshal())
	}
	if m.GlobalStopConditions != nil {
		w.rawMessageField(3, m.GlobalStopConditions.Marshal())
	}
	w.floatField(4, m.WaterTemperature)
	if m.Recipe != nil {
		w.rawMessageField(5, m.Recipe.Marshal())
	}
	w.uint32Field(6, m.ID)
	return w.b
}

func (m *ProfileDto) Unmarshal(b []byte) error {
	m.Phases = []PhaseDto{}
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.Name = string(b)
		case 2:
			payload, err := r.bytes()
			if err != nil {
				return err
			}
			var phase PhaseDto
			if err := phase.Unmarshal(payload); err != nil {
				return fmt.Errorf("ProfileDto.phases[%d]: %w", len(m.Phases), err)
			}
			m.Phases = append(m.Phases, phase)
		case 3:
			payload, err := r.bytes()
			if err != nil {
				return err
			}
			m.GlobalStopConditions = &GlobalStopConditionsDto{}
			if err := m.GlobalStopConditions.Unmarshal(payload); err != nil {
				return fmt.Errorf("ProfileDto.globalStopConditions: %w", err)
			}
		case 4:
			if m.WaterTemperature, err = r.float(); err != nil {
				return err
			}
		case 5:
			payload, err := r.bytes()
			if err != nil {
				return err
			}
			m.Recipe = &BrewRecipeDto{}
			if err := m.Recipe.Unmarshal(payload); err != nil {
				return fmt.Errorf("ProfileDto.recipe: %w", err)
			}
		case 6:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.ID = uint32(v)
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}
