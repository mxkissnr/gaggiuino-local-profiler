package proto

// ── #597 command / state messages ───────────────────────────────────────

// UpdateSystemStateCommandDto is the shared payload for c_opmode and
// c_tare_pend (see ws.go's wsSetOperationMode/wsTare).
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
			if m.TarePending, err = r.bool(); err != nil {
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

// ServiceTestCommandDto is the c_service_test request payload.
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

// SensorStateSnapshotDto is the continuous `d_sensor_snap` push, real
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
			if m.BrewActive, err = r.bool(); err != nil {
				return err
			}
		case 2:
			if m.SteamActive, err = r.bool(); err != nil {
				return err
			}
		case 3:
			if m.HotWaterSwitchState, err = r.bool(); err != nil {
				return err
			}
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
			if m.BoilerState, err = r.bool(); err != nil {
				return err
			}
		case 12:
			if m.BrewSwitchActive, err = r.bool(); err != nil {
				return err
			}
		case 13:
			if m.ValveState, err = r.bool(); err != nil {
				return err
			}
		case 14:
			if m.SteamValveState, err = r.bool(); err != nil {
				return err
			}
		case 15:
			if m.ValveBState, err = r.bool(); err != nil {
				return err
			}
		case 16:
			if m.SteamBoilerRelayState, err = r.bool(); err != nil {
				return err
			}
		case 17:
			if m.PinBrewLevel, err = r.bool(); err != nil {
				return err
			}
		case 18:
			if m.PinSteamLevel, err = r.bool(); err != nil {
				return err
			}
		case 19:
			if m.PinWaterLevel, err = r.bool(); err != nil {
				return err
			}
		case 20:
			if m.PinRelayLevel, err = r.bool(); err != nil {
				return err
			}
		case 21:
			if m.PinValveLevel, err = r.bool(); err != nil {
				return err
			}
		case 22:
			if m.PinValveBLevel, err = r.bool(); err != nil {
				return err
			}
		case 23:
			if m.PinRelayValveBLevel, err = r.bool(); err != nil {
				return err
			}
		case 24:
			if m.PinSteamValveRelayLevel, err = r.bool(); err != nil {
				return err
			}
		case 25:
			if m.PinSteamBoilerRelayLevel, err = r.bool(); err != nil {
				return err
			}
		case 26:
			if m.PinZcLevel, err = r.bool(); err != nil {
				return err
			}
		case 27:
			if m.PinDimmerLevel, err = r.bool(); err != nil {
				return err
			}
		case 28:
			if m.PinThermoCsLevel, err = r.bool(); err != nil {
				return err
			}
		case 29:
			if m.PinThermoClkLevel, err = r.bool(); err != nil {
				return err
			}
		case 30:
			if m.PinThermoDoLevel, err = r.bool(); err != nil {
				return err
			}
		case 31:
			if m.PinThermoDiLevel, err = r.bool(); err != nil {
				return err
			}
		case 32:
			if m.PinHx711SckLevel, err = r.bool(); err != nil {
				return err
			}
		case 33:
			if m.PinHx711Dout1Level, err = r.bool(); err != nil {
				return err
			}
		case 34:
			if m.PinHx711Dout2Level, err = r.bool(); err != nil {
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

// SystemStateDto is pushed on change and in response to g_sys_state.
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
			if m.StartupInitFinished, err = r.bool(); err != nil {
				return err
			}
		case 2:
			if m.TofReady, err = r.bool(); err != nil {
				return err
			}
		case 3:
			if m.IsSteamForgottenON, err = r.bool(); err != nil {
				return err
			}
		case 4:
			if m.ScalesPresent, err = r.bool(); err != nil {
				return err
			}
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
			if m.TarePending, err = r.bool(); err != nil {
				return err
			}
		case 9:
			b, err := r.bytes()
			if err != nil {
				return err
			}
			m.CoreType = string(b)
		case 10:
			if m.ThermocoupleFaulted, err = r.bool(); err != nil {
				return err
			}
		case 11:
			if m.PressureSensorFaulted, err = r.bool(); err != nil {
				return err
			}
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
			if m.PcbV2, err = r.bool(); err != nil {
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
