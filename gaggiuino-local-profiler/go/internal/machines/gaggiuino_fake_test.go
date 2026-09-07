package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"

	"nhooyr.io/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// fakeGaggiuinoMachine is a minimal stand-in for a real Gaggiuino
// controller's combined REST+WebSocket surface, used to exercise ws.go/
// gaggiuino_adapter.go/handlers.go end-to-end without real hardware (see
// doc.go's "no live-hardware verification happens in this package" note —
// this is exactly the substitute the task brief asked for: a
// fully-scripted fake server standing in for the real protocol,
// distinct from proto/node_vectors_test.go's ground-truth wire-format
// cross-check against lib/gaggiuino-proto.js).
type fakeGaggiuinoMachine struct {
	*httptest.Server

	mu       sync.Mutex
	profiles []proto.SavedProfileDto
	nextID   uint32

	restProfileDetail404 bool // force GetProfile's REST attempt to fail so it falls back to WS
	restProfileCreate404 bool // force CreateProfile's REST attempt to fail so it falls back to WS

	settingsBody           []byte // raw bytes returned by GET /api/settings/{category} — set per test to exercise the bool-as-string quirk verbatim
	lastUpdateSettingsBody []byte // raw bytes POSTed to /api/settings/{category} — captured for passthrough assertions
}

func newFakeGaggiuinoMachine() *fakeGaggiuinoMachine {
	f := &fakeGaggiuinoMachine{nextID: 1}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", f.handleWS)
	mux.HandleFunc("/api/system/status", f.handleStatus)
	mux.HandleFunc("/api/profiles/all", f.handleProfilesAll)
	mux.HandleFunc("/api/profile/", f.handleProfileDetail)
	mux.HandleFunc("/api/profile", f.handleProfileCreate)
	mux.HandleFunc("/api/settings/", f.handleSettingsCategory)
	mux.HandleFunc("/api/settings", f.handleSettingsAll)
	mux.HandleFunc("/api/firmware/progress", f.handleFirmwareProgress)
	mux.HandleFunc("/api/firmware/update-all", f.handleFirmwareUpdate)
	f.Server = httptest.NewServer(mux)
	return f
}

func (f *fakeGaggiuinoMachine) handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"temperature":93.5,"targetTemperature":94,"pressure":9,"weight":18.2,"brewSwitchState":true,"steamSwitchState":false,"profileId":1,"profileName":"Espresso"}`)
}

func (f *fakeGaggiuinoMachine) handleProfilesAll(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(f.profiles)
}

func (f *fakeGaggiuinoMachine) handleProfileDetail(w http.ResponseWriter, r *http.Request) {
	if f.restProfileDetail404 {
		http.NotFound(w, r)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/profile/")
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"id":%s,"name":"REST Profile","phases":[]}`, id)
}

func (f *fakeGaggiuinoMachine) handleProfileCreate(w http.ResponseWriter, r *http.Request) {
	if f.restProfileCreate404 || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	id := f.nextID
	f.nextID++
	name, _ := body["name"].(string)
	f.profiles = append(f.profiles, proto.SavedProfileDto{ID: id, Name: name})
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"id":%d,"name":%q}`, id, name)
}

func (f *fakeGaggiuinoMachine) handleSettingsAll(w http.ResponseWriter, r *http.Request) {
	f.writeSettings(w)
}

func (f *fakeGaggiuinoMachine) handleSettingsCategory(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.lastUpdateSettingsBody = body
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(body) // echo back — the machine's own POST /api/settings/{category} returns the applied settings
		return
	}
	f.writeSettings(w)
}

func (f *fakeGaggiuinoMachine) writeSettings(w http.ResponseWriter) {
	f.mu.Lock()
	body := f.settingsBody
	f.mu.Unlock()
	if body == nil {
		body = []byte(`{}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

func (f *fakeGaggiuinoMachine) handleFirmwareProgress(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"progress":0,"status":"IDLE","type":"C_FW"}`)
}

func (f *fakeGaggiuinoMachine) handleFirmwareUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"message":"started","success":true}`)
}

// handleWS implements just enough of the binary protobuf protocol
// (proto/schema.proto) to exercise ws.go's request/response functions:
// GetProfileDict/GetProfileById/CreateNewProfile/UpdateProfile/DeleteProfile
// (d_prof_dict/d_prof pushes) and the #597 c_* commands (d_resp ack, with
// c_service_test's documented d_notif exception).
func (f *fakeGaggiuinoMachine) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := r.Context()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var envelope proto.WebSocketMessageDto
		if err := envelope.Unmarshal(data); err != nil {
			continue
		}
		f.respond(ctx, conn, envelope)
	}
}

func (f *fakeGaggiuinoMachine) respond(ctx context.Context, conn *websocket.Conn, req proto.WebSocketMessageDto) {
	send := func(action string, payload []byte) {
		msg := &proto.WebSocketMessageDto{Action: action, Data: payload}
		_ = conn.Write(ctx, websocket.MessageBinary, msg.Marshal())
	}
	sendAck := func(action string, ok bool, errMsg string) {
		result := proto.ResultSuccess
		if !ok {
			result = proto.ResultError
		}
		resp := &proto.WebSocketResponseDto{Action: action, Result: result, ErrorMessage: errMsg}
		send(respAck, resp.Marshal())
	}

	switch req.Action {
	case actionGetProfileDict:
		f.mu.Lock()
		dict := &proto.SavedProfilesDto{Profiles: append([]proto.SavedProfileDto{}, f.profiles...)}
		f.mu.Unlock()
		send("d_prof_dict", dict.Marshal())

	case actionGetProfileByID:
		var idReq proto.WebSocketProfileIdCommandDto
		_ = idReq.Unmarshal(req.Data)
		profile := &proto.ProfileDto{ID: idReq.ID, Name: "WS Profile", Phases: []proto.PhaseDto{}}
		send("d_prof", profile.Marshal())

	case actionCreateNewProfile:
		var p proto.ProfileDto
		_ = p.Unmarshal(req.Data)
		f.mu.Lock()
		id := f.nextID
		f.nextID++
		f.profiles = append(f.profiles, proto.SavedProfileDto{ID: id, Name: p.Name})
		dict := &proto.SavedProfilesDto{Profiles: append([]proto.SavedProfileDto{}, f.profiles...)}
		f.mu.Unlock()
		send("d_prof_dict", dict.Marshal())

	case actionUpdateProfile:
		var p proto.ProfileDto
		_ = p.Unmarshal(req.Data)
		f.mu.Lock()
		for i := range f.profiles {
			if f.profiles[i].ID == p.ID {
				f.profiles[i].Name = p.Name
			}
		}
		dict := &proto.SavedProfilesDto{Profiles: append([]proto.SavedProfileDto{}, f.profiles...)}
		f.mu.Unlock()
		send("d_prof_dict", dict.Marshal())

	case actionDeleteProfile:
		var idReq proto.WebSocketProfileIdCommandDto
		_ = idReq.Unmarshal(req.Data)
		f.mu.Lock()
		out := f.profiles[:0]
		for _, p := range f.profiles {
			if p.ID != idReq.ID {
				out = append(out, p)
			}
		}
		f.profiles = out
		dict := &proto.SavedProfilesDto{Profiles: append([]proto.SavedProfileDto{}, f.profiles...)}
		f.mu.Unlock()
		send("d_prof_dict", dict.Marshal())

	case actionSetOperationMode, actionSetTarePending, actionSaveSettings, actionPersistActiveProfile:
		sendAck(req.Action, true, "")

	case actionServiceTest:
		// #600: no d_resp for this one — only a d_notif.
		notif := &proto.NotificationDto{Type: proto.NotificationSuccess, Message: "Service test complete"}
		send(respNotif, notif.Marshal())
	}
}
