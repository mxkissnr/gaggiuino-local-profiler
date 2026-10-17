package proto

import "fmt"

// ── Envelope + saved-profile-list messages ──────────────────────────────

// WebSocketProfileIdCommandDto is the request payload for g_prof/c_del_prof.
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

// WebSocketMessageDto is the envelope every frame in both directions is
// wrapped in (`action` routes to a message type, `data` is that type's own
// independently encoded bytes). Data is deliberately copied (not a subslice
// of the input buffer) since callers decode-then-store this across the
// lifetime of a WS read buffer that may be reused.
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

// WebSocketResponseDto is the generic `d_resp` acknowledgement for c_*
// commands (see ws.go's wsSendCommand).
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

// SavedProfileDto is one {id, name} entry in a profile-slot list.
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

// SavedProfilesDto is the d_prof_dict push (GetProfileDict/CreateNewProfile/
// UpdateProfile/DeleteProfile all answer with this).
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

// NotificationDto is the `d_notif` push, notably the c_service_test
// completion signal (see ws.go's wsSendCommand).
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
