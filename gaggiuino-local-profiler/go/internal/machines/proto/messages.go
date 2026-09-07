package proto

import "fmt"

// Every message below ports one lib/gaggiuino-proto.js MessageType
// verbatim — same field numbers, same names (camelCased the same way),
// same scalar-type/wire-kind mapping (protobuf-ts's `T:` code: 2=float,
// 8=bool, 9=string, 12=bytes, 13=uint32 — see schema.proto's header
// comment for the full FieldDescriptorProto.Type table this maps against).
//
// Field types deliberately deviate from the wire's own bit width in one
// place: every `float` (wire: 32-bit fixed-point) field is a Go float64,
// not float32. This matches JavaScript, which has no float32 type either
// — protobuf-ts always hands callers a float64 (JS Number) up-converted
// from the wire's 32 bits, including that up-conversion's imprecision
// (e.g. a wire value of 93.7f decodes to 93.69999694824219 in both
// runtimes) — see node_vectors_test.go, which asserts this package
// reproduces that exact imprecision, not a "cleaner" float32-native one.
// The down-convert back to 32 bits happens only at the wire boundary
// (wire.go's floatField).
//
// Optional nested-message fields (PhaseDto.Target/StopConditions,
// ProfileDto.GlobalStopConditions/Recipe) are Go pointers: nil means
// "field absent from the wire" (and omitted from JSON via `omitempty`),
// matching protobuf-ts's own `undefined` for an unset message field
// (verified: JSON.stringify(ProfileDto.fromBinary(...)) omits
// globalStopConditions/recipe entirely when the source never set them,
// rather than emitting an empty object). Repeated message fields
// (ProfileDto.Phases, SavedProfilesDto.Profiles) are plain (never nil)
// slices, initialized to length 0 by Unmarshal so JSON output is `[]`,
// not `null`, matching protobuf-ts's own always-present-array behavior
// for an empty repeated field.

// ── Profile messages ────────────────────────────────────────────────────

// PhaseStopConditionsDto ports lib/gaggiuino-proto.js's PhaseStopConditionsDto.
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

// TransitionDto ports lib/gaggiuino-proto.js's TransitionDto.
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

// PhaseDto ports lib/gaggiuino-proto.js's PhaseDto.
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
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Skip = v != 0
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// GlobalStopConditionsDto ports lib/gaggiuino-proto.js's GlobalStopConditionsDto.
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
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.SwitchToManualPressureCtrl = v != 0
		case 5:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.SwitchToManuaFlowCtrl = v != 0
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// BrewRecipeDto ports lib/gaggiuino-proto.js's BrewRecipeDto.
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

// ProfileDto ports lib/gaggiuino-proto.js's ProfileDto.
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

// ── Envelope + saved-profile-list messages ──────────────────────────────

// WebSocketProfileIdCommandDto ports lib/gaggiuino-proto.js's
// WebSocketProfileIdCommandDto (the request payload for g_prof/c_del_prof).
type WebSocketProfileIdCommandDto struct {
	ID uint32 `json:"id"`
}

func (m *WebSocketProfileIdCommandDto) Marshal() []byte {
	w := &writer{}
	w.uint32Field(1, m.ID)
	return w.b
}

func (m *WebSocketProfileIdCommandDto) Unmarshal(b []byte) error {
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		if field == 1 {
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.ID = uint32(v)
			continue
		}
		if err := r.skip(wt); err != nil {
			return err
		}
	}
	return nil
}

// WebSocketMessageDto ports lib/gaggiuino-proto.js's WebSocketMessageDto —
// the envelope every frame in both directions is wrapped in (`action`
// routes to a message type, `data` is that type's own independently
// encoded bytes). Data is deliberately copied (not a subslice of the input
// buffer) since callers decode-then-store this across the lifetime of a
// WS read buffer that may be reused.
type WebSocketMessageDto struct {
	Action string `json:"action"`
	Data   []byte `json:"data,omitempty"`
}

func (m *WebSocketMessageDto) Marshal() []byte {
	w := &writer{}
	w.stringField(1, m.Action)
	w.bytesField(2, m.Data)
	return w.b
}

func (m *WebSocketMessageDto) Unmarshal(b []byte) error {
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
			m.Action = string(b)
		case 2:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.Data = append([]byte(nil), b...)
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// WebSocketResponseDto ports lib/gaggiuino-proto.js's WebSocketResponseDto
// — the generic `d_resp` acknowledgement for c_* commands (see ws.go's
// sendCommand).
type WebSocketResponseDto struct {
	Action       string                  `json:"action"`
	Result       WebSocketResponseResult `json:"result"`
	ErrorMessage string                  `json:"errorMessage"`
}

func (m *WebSocketResponseDto) Marshal() []byte {
	w := &writer{}
	w.stringField(1, m.Action)
	w.enumField(2, int32(m.Result))
	w.stringField(3, m.ErrorMessage)
	return w.b
}

func (m *WebSocketResponseDto) Unmarshal(b []byte) error {
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
			m.Action = string(b)
		case 2:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Result = WebSocketResponseResult(int32(v))
		case 3:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.ErrorMessage = string(b)
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// SavedProfileDto ports lib/gaggiuino-proto.js's SavedProfileDto (one
// {id, name} entry in a profile-slot list).
type SavedProfileDto struct {
	ID   uint32 `json:"id"`
	Name string `json:"name"`
}

func (m *SavedProfileDto) Marshal() []byte {
	w := &writer{}
	w.uint32Field(1, m.ID)
	w.stringField(2, m.Name)
	return w.b
}

func (m *SavedProfileDto) Unmarshal(b []byte) error {
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
			m.ID = uint32(v)
		case 2:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.Name = string(b)
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// SavedProfilesDto ports lib/gaggiuino-proto.js's SavedProfilesDto — the
// d_prof_dict push (GetProfileDict/CreateNewProfile/UpdateProfile/
// DeleteProfile all answer with this).
type SavedProfilesDto struct {
	Profiles []SavedProfileDto `json:"profiles"`
}

func (m *SavedProfilesDto) Marshal() []byte {
	w := &writer{}
	for i := range m.Profiles {
		w.rawMessageField(1, m.Profiles[i].Marshal())
	}
	return w.b
}

func (m *SavedProfilesDto) Unmarshal(b []byte) error {
	m.Profiles = []SavedProfileDto{}
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		if field == 1 {
			payload, err := r.bytes()
			if err != nil {
				return err
			}
			var p SavedProfileDto
			if err := p.Unmarshal(payload); err != nil {
				return fmt.Errorf("SavedProfilesDto.profiles[%d]: %w", len(m.Profiles), err)
			}
			m.Profiles = append(m.Profiles, p)
			continue
		}
		if err := r.skip(wt); err != nil {
			return err
		}
	}
	return nil
}

// NotificationDto ports lib/gaggiuino-proto.js's NotificationDto — the
// `d_notif` push, notably the c_service_test completion signal (see
// ws.go's sendCommand).
type NotificationDto struct {
	Type    NotificationType `json:"type"`
	Message string           `json:"message"`
}

func (m *NotificationDto) Marshal() []byte {
	w := &writer{}
	w.enumField(1, int32(m.Type))
	w.stringField(2, m.Message)
	return w.b
}

func (m *NotificationDto) Unmarshal(b []byte) error {
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
			m.Type = NotificationType(int32(v))
		case 2:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.Message = string(b)
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// ── #597 command / state messages ───────────────────────────────────────

// UpdateSystemStateCommandDto ports lib/gaggiuino-proto.js's
// UpdateSystemStateCommandDto — shared payload for c_opmode and
// c_tare_pend (see ws.go's setOperationMode/tare).
type UpdateSystemStateCommandDto struct {
	OperationMode OperationMode `json:"operationMode"`
	TarePending   bool          `json:"tarePending"`
}

func (m *UpdateSystemStateCommandDto) Marshal() []byte {
	w := &writer{}
	w.enumField(1, int32(m.OperationMode))
	w.boolField(2, m.TarePending)
	return w.b
}

func (m *UpdateSystemStateCommandDto) Unmarshal(b []byte) error {
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
			m.OperationMode = OperationMode(int32(v))
		case 2:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.TarePending = v != 0
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// ServiceTestCommandDto ports lib/gaggiuino-proto.js's ServiceTestCommandDto.
type ServiceTestCommandDto struct {
	Peripheral ServiceTestPeripheral `json:"peripheral"`
}

func (m *ServiceTestCommandDto) Marshal() []byte {
	w := &writer{}
	w.enumField(1, int32(m.Peripheral))
	return w.b
}

func (m *ServiceTestCommandDto) Unmarshal(b []byte) error {
	r := newReader(b)
	for r.len() > 0 {
		field, wt, err := r.tag()
		if err != nil {
			return err
		}
		if field == 1 {
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.Peripheral = ServiceTestPeripheral(int32(v))
			continue
		}
		if err := r.skip(wt); err != nil {
			return err
		}
	}
	return nil
}

// SensorStateSnapshotDto ports lib/gaggiuino-proto.js's
// SensorStateSnapshotDto — the continuous `d_sensor_snap` push, real
// (unscaled) numbers unlike the x10-scaled REST/shot wire formats.
type SensorStateSnapshotDto struct {
	BrewActive               bool    `json:"brewActive"`
	SteamActive              bool    `json:"steamActive"`
	HotWaterSwitchState      bool    `json:"hotWaterSwitchState"`
	Temperature              float64 `json:"temperature"`
	WaterTemperature         float64 `json:"waterTemperature"`
	Pressure                 float64 `json:"pressure"`
	PumpFlow                 float64 `json:"pumpFlow"`
	WeightFlow               float64 `json:"weightFlow"`
	Weight                   float64 `json:"weight"`
	WaterLevel               uint32  `json:"waterLevel"`
	BoilerState              bool    `json:"boilerState"`
	BrewSwitchActive         bool    `json:"brewSwitchActive"`
	ValveState               bool    `json:"valveState"`
	SteamValveState          bool    `json:"steamValveState"`
	ValveBState              bool    `json:"valveBState"`
	SteamBoilerRelayState    bool    `json:"steamBoilerRelayState"`
	PinBrewLevel             bool    `json:"pinBrewLevel"`
	PinSteamLevel            bool    `json:"pinSteamLevel"`
	PinWaterLevel            bool    `json:"pinWaterLevel"`
	PinRelayLevel            bool    `json:"pinRelayLevel"`
	PinValveLevel            bool    `json:"pinValveLevel"`
	PinValveBLevel           bool    `json:"pinValveBLevel"`
	PinRelayValveBLevel      bool    `json:"pinRelayValveBLevel"`
	PinSteamValveRelayLevel  bool    `json:"pinSteamValveRelayLevel"`
	PinSteamBoilerRelayLevel bool    `json:"pinSteamBoilerRelayLevel"`
	PinZcLevel               bool    `json:"pinZcLevel"`
	PinDimmerLevel           bool    `json:"pinDimmerLevel"`
	PinThermoCsLevel         bool    `json:"pinThermoCsLevel"`
	PinThermoClkLevel        bool    `json:"pinThermoClkLevel"`
	PinThermoDoLevel         bool    `json:"pinThermoDoLevel"`
	PinThermoDiLevel         bool    `json:"pinThermoDiLevel"`
	PinHx711SckLevel         bool    `json:"pinHx711SckLevel"`
	PinHx711Dout1Level       bool    `json:"pinHx711Dout1Level"`
	PinHx711Dout2Level       bool    `json:"pinHx711Dout2Level"`
}

func (m *SensorStateSnapshotDto) Marshal() []byte {
	w := &writer{}
	w.boolField(1, m.BrewActive)
	w.boolField(2, m.SteamActive)
	w.boolField(3, m.HotWaterSwitchState)
	w.floatField(4, m.Temperature)
	w.floatField(5, m.WaterTemperature)
	w.floatField(6, m.Pressure)
	w.floatField(7, m.PumpFlow)
	w.floatField(8, m.WeightFlow)
	w.floatField(9, m.Weight)
	w.uint32Field(10, m.WaterLevel)
	w.boolField(11, m.BoilerState)
	w.boolField(12, m.BrewSwitchActive)
	w.boolField(13, m.ValveState)
	w.boolField(14, m.SteamValveState)
	w.boolField(15, m.ValveBState)
	w.boolField(16, m.SteamBoilerRelayState)
	w.boolField(17, m.PinBrewLevel)
	w.boolField(18, m.PinSteamLevel)
	w.boolField(19, m.PinWaterLevel)
	w.boolField(20, m.PinRelayLevel)
	w.boolField(21, m.PinValveLevel)
	w.boolField(22, m.PinValveBLevel)
	w.boolField(23, m.PinRelayValveBLevel)
	w.boolField(24, m.PinSteamValveRelayLevel)
	w.boolField(25, m.PinSteamBoilerRelayLevel)
	w.boolField(26, m.PinZcLevel)
	w.boolField(27, m.PinDimmerLevel)
	w.boolField(28, m.PinThermoCsLevel)
	w.boolField(29, m.PinThermoClkLevel)
	w.boolField(30, m.PinThermoDoLevel)
	w.boolField(31, m.PinThermoDiLevel)
	w.boolField(32, m.PinHx711SckLevel)
	w.boolField(33, m.PinHx711Dout1Level)
	w.boolField(34, m.PinHx711Dout2Level)
	return w.b
}

func (m *SensorStateSnapshotDto) Unmarshal(b []byte) error {
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
			m.BrewActive = v != 0
		case 2:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.SteamActive = v != 0
		case 3:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.HotWaterSwitchState = v != 0
		case 4:
			if m.Temperature, err = r.float(); err != nil {
				return err
			}
		case 5:
			if m.WaterTemperature, err = r.float(); err != nil {
				return err
			}
		case 6:
			if m.Pressure, err = r.float(); err != nil {
				return err
			}
		case 7:
			if m.PumpFlow, err = r.float(); err != nil {
				return err
			}
		case 8:
			if m.WeightFlow, err = r.float(); err != nil {
				return err
			}
		case 9:
			if m.Weight, err = r.float(); err != nil {
				return err
			}
		case 10:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.WaterLevel = uint32(v)
		case 11:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.BoilerState = v != 0
		case 12:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.BrewSwitchActive = v != 0
		case 13:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.ValveState = v != 0
		case 14:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.SteamValveState = v != 0
		case 15:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.ValveBState = v != 0
		case 16:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.SteamBoilerRelayState = v != 0
		case 17:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinBrewLevel = v != 0
		case 18:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinSteamLevel = v != 0
		case 19:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinWaterLevel = v != 0
		case 20:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinRelayLevel = v != 0
		case 21:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinValveLevel = v != 0
		case 22:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinValveBLevel = v != 0
		case 23:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinRelayValveBLevel = v != 0
		case 24:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinSteamValveRelayLevel = v != 0
		case 25:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinSteamBoilerRelayLevel = v != 0
		case 26:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinZcLevel = v != 0
		case 27:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinDimmerLevel = v != 0
		case 28:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinThermoCsLevel = v != 0
		case 29:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinThermoClkLevel = v != 0
		case 30:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinThermoDoLevel = v != 0
		case 31:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinThermoDiLevel = v != 0
		case 32:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinHx711SckLevel = v != 0
		case 33:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinHx711Dout1Level = v != 0
		case 34:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PinHx711Dout2Level = v != 0
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}

// SystemStateDto ports lib/gaggiuino-proto.js's SystemStateDto — pushed on
// change and in response to g_sys_state.
type SystemStateDto struct {
	StartupInitFinished       bool          `json:"startupInitFinished"`
	TofReady                  bool          `json:"tofReady"`
	IsSteamForgottenON        bool          `json:"isSteamForgottenON"`
	ScalesPresent             bool          `json:"scalesPresent"`
	OperationMode             OperationMode `json:"operationMode"`
	TimeAlive                 uint32        `json:"timeAlive"`
	CoreVersion               string        `json:"coreVersion"`
	TarePending               bool          `json:"tarePending"`
	CoreType                  string        `json:"coreType"`
	ThermocoupleFaulted       bool          `json:"thermocoupleFaulted"`
	PressureSensorFaulted     bool          `json:"pressureSensorFaulted"`
	ThermocoupleFaultReason   string        `json:"thermocoupleFaultReason"`
	PressureSensorFaultReason string        `json:"pressureSensorFaultReason"`
	PcbV2                     bool          `json:"pcbV2"`
}

func (m *SystemStateDto) Marshal() []byte {
	w := &writer{}
	w.boolField(1, m.StartupInitFinished)
	w.boolField(2, m.TofReady)
	w.boolField(3, m.IsSteamForgottenON)
	w.boolField(4, m.ScalesPresent)
	w.enumField(5, int32(m.OperationMode))
	w.uint32Field(6, m.TimeAlive)
	w.stringField(7, m.CoreVersion)
	w.boolField(8, m.TarePending)
	w.stringField(9, m.CoreType)
	w.boolField(10, m.ThermocoupleFaulted)
	w.boolField(11, m.PressureSensorFaulted)
	w.stringField(12, m.ThermocoupleFaultReason)
	w.stringField(13, m.PressureSensorFaultReason)
	w.boolField(14, m.PcbV2)
	return w.b
}

func (m *SystemStateDto) Unmarshal(b []byte) error {
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
			m.StartupInitFinished = v != 0
		case 2:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.TofReady = v != 0
		case 3:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.IsSteamForgottenON = v != 0
		case 4:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.ScalesPresent = v != 0
		case 5:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.OperationMode = OperationMode(int32(v))
		case 6:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.TimeAlive = uint32(v)
		case 7:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.CoreVersion = string(b)
		case 8:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.TarePending = v != 0
		case 9:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.CoreType = string(b)
		case 10:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.ThermocoupleFaulted = v != 0
		case 11:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PressureSensorFaulted = v != 0
		case 12:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.ThermocoupleFaultReason = string(b)
		case 13:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.PressureSensorFaultReason = string(b)
		case 14:
			v, err := r.varint()
			if err != nil {
				return err
			}
			m.PcbV2 = v != 0
		default:
			if err := r.skip(wt); err != nil {
				return err
			}
		}
	}
	return nil
}
