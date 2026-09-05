package machines

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"nhooyr.io/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// This file ports lib/gaggiuino-ws-client.js: the short-lived-connection-
// per-request WebSocket client for the Gaggiuino machine's binary protobuf
// protocol. Each exported function here opens its own connection, sends one
// request, waits for the matching response, then closes — same pattern
// (and same rationale: the machine doesn't support, or need for this call
// volume, a persistent connection with request/response correlation ids)
// as the Node original. See live.go for the second, persistent-connection
// pattern (lib/gaggiuino-live-client.js's port) this machine type also
// uses, for continuously-pushed sensor/system-state data.
//
// nhooyr.io/websocket (per this phase's task brief) is used as the client
// library — its own package doc now points at a fork, coder/websocket,
// as the actively maintained home, but the API is unchanged and the
// module still resolves and builds correctly, so this port uses the
// explicitly-specified module path as directed.

// wsDefaultTimeout ports gaggiuino-ws-client.js's DEFAULT_TIMEOUT_MS.
const wsDefaultTimeout = 8 * time.Second

// Gaggiuino WS action codes — ports lib/gaggiuino-proto.js's `ND` map.
// Request (g_/c_ prefixed) and response (d_ prefixed) actions are
// different strings, not an echo — see responseAction below and
// lib/gaggiuino-proto.js's own header comment for why.
const (
	actionGetProfileDict       = "g_prof_dict"
	actionGetProfileByID       = "g_prof"
	actionCreateNewProfile     = "c_new_prof"
	actionUpdateProfile        = "c_upd_prof"
	actionDeleteProfile        = "c_del_prof"
	actionGetSystemState       = "g_sys_state"
	actionSetOperationMode     = "c_opmode"
	actionSetTarePending       = "c_tare_pend"
	actionServiceTest          = "c_service_test"
	actionSaveSettings         = "c_save_settings"
	actionPersistActiveProfile = "c_save_act_prof"

	respAck      = "d_resp"
	respNotif    = "d_notif"
	pushSensor   = "d_sensor_snap"
	pushSysState = "d_sys_state"
)

// responseAction ports lib/gaggiuino-proto.js's RESPONSE_ACTION map: the
// matching push-response action for each request action that answers with
// a specific data type rather than the generic d_resp ack (see sendCommand
// below for that other family).
var responseAction = map[string]string{
	actionGetProfileDict:   "d_prof_dict",
	actionGetProfileByID:   "d_prof",
	actionCreateNewProfile: "d_prof_dict",
	actionUpdateProfile:    "d_prof_dict",
	actionDeleteProfile:    "d_prof_dict",
}

// gaggiuinoWSURL ports gaggiuino-ws-client.js's wsUrlFor(baseUrl).
func gaggiuinoWSURL(baseURL string) (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("invalid base URL: %w", err)
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	return fmt.Sprintf("%s://%s/ws", scheme, u.Host), nil
}

// wsConnect ports the connect-with-timeout preamble every short-lived WS
// call in this package (wsSendAndWait/wsSendCommand here, plus
// gaggimateRequest/gaggimateWaitForStatus in gaggimate_ws.go) used to
// repeat verbatim: derive a timeout-bounded ctx, build the WS URL via
// urlFor, and dial it (#901 code review). Returns the derived ctx —
// callers must use it for Write/Read, not the ctx they passed in — and a
// cancel func the caller must defer alongside conn.CloseNow().
func wsConnect(ctx context.Context, baseURL string, urlFor func(string) (string, error), timeout time.Duration) (conn *websocket.Conn, dialCtx context.Context, cancel context.CancelFunc, err error) {
	dialCtx, cancel = context.WithTimeout(ctx, timeout)
	wsURL, err := urlFor(baseURL)
	if err != nil {
		cancel()
		return nil, nil, nil, err
	}
	// HTTPClient: httpClient pins the dial to the SSRF-guard-resolved IP
	// (guardedDialContext, http.go) instead of letting the WS handshake's
	// underlying HTTP request re-resolve the hostname independently (#987).
	conn, _, err = websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{HTTPClient: httpClient})
	if err != nil {
		cancel()
		return nil, nil, nil, fmt.Errorf("connecting to machine: %w", err)
	}
	return conn, dialCtx, cancel, nil
}

// wsSendAndWait ports sendAndWait(baseUrl, action, requestData, responseMsgType):
// sends one WebSocketMessageDto and decodes the payload of the first
// matching push-response action seen, via decode. requestData may be nil
// (several actions, e.g. GetProfileDict, take none).
func wsSendAndWait(ctx context.Context, baseURL, action string, requestData []byte, decode func([]byte) error) error {
	expected, ok := responseAction[action]
	if !ok {
		return fmt.Errorf("no known response action for request action %q", action)
	}

	conn, ctx, cancel, err := wsConnect(ctx, baseURL, gaggiuinoWSURL, wsDefaultTimeout)
	if err != nil {
		return err
	}
	defer cancel()
	defer conn.CloseNow()

	req := &proto.WebSocketMessageDto{Action: action, Data: requestData}
	if err := conn.Write(ctx, websocket.MessageBinary, req.Marshal()); err != nil {
		return fmt.Errorf("sending request: %w", err)
	}

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return fmt.Errorf("timed out waiting for %q from the machine", expected)
			}
			return fmt.Errorf("waiting for %q from the machine: %w", expected, err)
		}
		var envelope proto.WebSocketMessageDto
		if err := envelope.Unmarshal(data); err != nil {
			continue // not a valid envelope frame, ignore
		}
		// Node's own check here is `!envelope.data` — always false in
		// JS, since protobuf-ts decodes an unset/empty bytes field to an
		// empty (but still truthy) Uint8Array, never null/undefined
		// (verified directly against the real runtime). So the Node
		// original only ever filters on action, not on data being
		// present/non-empty — an empty-but-valid response (e.g.
		// GetProfileDict with zero saved profiles, which legitimately
		// encodes to zero data bytes) must not be skipped here either.
		if envelope.Action != expected {
			continue
		}
		if err := decode(envelope.Data); err != nil {
			return fmt.Errorf("failed to decode %q response: %w", expected, err)
		}
		conn.Close(websocket.StatusNormalClosure, "")
		return nil
	}
}

// wsSendCommand ports sendCommand(baseUrl, action, requestData): sends a
// c_* command and waits for its generic `d_resp` acknowledgement — distinct
// from wsSendAndWait, which correlates by waiting for a different,
// action-specific push. c_service_test is the one documented exception
// (#600, live-verified): the machine sends a `d_notif` ("Service test
// complete") instead of a d_resp for that command only — message carries
// its text when non-empty, matching sendCommand()'s `{ok:true, message}`
// return for that case.
func wsSendCommand(ctx context.Context, baseURL, action string, requestData []byte) (message string, err error) {
	conn, ctx, cancel, err := wsConnect(ctx, baseURL, gaggiuinoWSURL, wsDefaultTimeout)
	if err != nil {
		return "", err
	}
	defer cancel()
	defer conn.CloseNow()

	req := &proto.WebSocketMessageDto{Action: action, Data: requestData}
	if err := conn.Write(ctx, websocket.MessageBinary, req.Marshal()); err != nil {
		return "", fmt.Errorf("sending command: %w", err)
	}

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return "", fmt.Errorf("timed out waiting for a %q acknowledgement from the machine", action)
			}
			return "", fmt.Errorf("waiting for a %q acknowledgement from the machine: %w", action, err)
		}
		var envelope proto.WebSocketMessageDto
		if err := envelope.Unmarshal(data); err != nil {
			continue
		}
		// See wsSendAndWait's comment on the identical `!envelope.data`
		// check in the Node original — always false in JS, so no
		// presence/non-empty filtering happens there either; only the
		// action switch below actually discriminates.

		if envelope.Action == respAck {
			var resp proto.WebSocketResponseDto
			if err := resp.Unmarshal(envelope.Data); err != nil {
				continue
			}
			if resp.Action != action {
				continue // ack for a different in-flight command on this connection
			}
			if resp.Result == proto.ResultError {
				msg := resp.ErrorMessage
				if msg == "" {
					msg = fmt.Sprintf("machine rejected %q", action)
				}
				conn.Close(websocket.StatusNormalClosure, "")
				return "", fmt.Errorf("%s", msg)
			}
			conn.Close(websocket.StatusNormalClosure, "")
			return "", nil
		}

		// c_service_test-only fallback — see this function's header comment.
		if action == actionServiceTest && envelope.Action == respNotif {
			var notif proto.NotificationDto
			if err := notif.Unmarshal(envelope.Data); err != nil {
				continue
			}
			conn.Close(websocket.StatusNormalClosure, "")
			return notif.Message, nil
		}
	}
}

// ── Profile CRUD (ports the profile-management functions in
// gaggiuino-ws-client.js) ──────────────────────────────────────────────

func wsGetProfileDict(ctx context.Context, baseURL string) ([]proto.SavedProfileDto, error) {
	var dict proto.SavedProfilesDto
	if err := wsSendAndWait(ctx, baseURL, actionGetProfileDict, nil, dict.Unmarshal); err != nil {
		return nil, err
	}
	return dict.Profiles, nil
}

func wsGetProfileByID(ctx context.Context, baseURL string, id int) (*proto.ProfileDto, error) {
	req := &proto.WebSocketProfileIdCommandDto{ID: uint32(id)}
	var profile proto.ProfileDto
	if err := wsSendAndWait(ctx, baseURL, actionGetProfileByID, req.Marshal(), profile.Unmarshal); err != nil {
		return nil, err
	}
	return &profile, nil
}

func wsCreateProfile(ctx context.Context, baseURL string, profile ProfileInput) (proto.SavedProfileDto, error) {
	wire := profile.ToWireProfile()
	var dict proto.SavedProfilesDto
	if err := wsSendAndWait(ctx, baseURL, actionCreateNewProfile, wire.Marshal(), dict.Unmarshal); err != nil {
		return proto.SavedProfileDto{}, err
	}
	for _, p := range dict.Profiles {
		if p.Name == profile.Name {
			return p, nil
		}
	}
	return proto.SavedProfileDto{}, fmt.Errorf("machine did not confirm the new profile in its profile list")
}

func wsUpdateProfile(ctx context.Context, baseURL string, profile ProfileInput) (proto.SavedProfileDto, error) {
	if profile.ID == nil {
		return proto.SavedProfileDto{}, fmt.Errorf("updateProfile requires profile.id — create a profile first")
	}
	wire := profile.ToWireProfile()
	var dict proto.SavedProfilesDto
	if err := wsSendAndWait(ctx, baseURL, actionUpdateProfile, wire.Marshal(), dict.Unmarshal); err != nil {
		return proto.SavedProfileDto{}, err
	}
	for _, p := range dict.Profiles {
		if uint32(p.ID) == uint32(*profile.ID) {
			return p, nil
		}
	}
	return proto.SavedProfileDto{}, fmt.Errorf("machine did not confirm profile id %d after update", *profile.ID)
}

func wsDeleteProfile(ctx context.Context, baseURL string, id int) ([]proto.SavedProfileDto, error) {
	req := &proto.WebSocketProfileIdCommandDto{ID: uint32(id)}
	var dict proto.SavedProfilesDto
	if err := wsSendAndWait(ctx, baseURL, actionDeleteProfile, req.Marshal(), dict.Unmarshal); err != nil {
		return nil, err
	}
	for _, p := range dict.Profiles {
		if int(p.ID) == id {
			return nil, fmt.Errorf("machine did not confirm deletion of profile id %d", id)
		}
	}
	return dict.Profiles, nil
}

// ── #597 settings/control commands ──────────────────────────────────────

// wsSetOperationMode ports setOperationMode(baseUrl, mode). tarePending is
// always false here — wsTare below is the dedicated path for a tare, and
// this field is unread by the opmode handler regardless (see
// UpdateSystemStateCommandDto's doc comment in proto/schema.proto).
func wsSetOperationMode(ctx context.Context, baseURL string, mode proto.OperationMode) error {
	req := &proto.UpdateSystemStateCommandDto{OperationMode: mode, TarePending: false}
	_, err := wsSendCommand(ctx, baseURL, actionSetOperationMode, req.Marshal())
	return err
}

// wsTare ports tare(baseUrl): BREW_AUTO (0) is sent as an inert
// placeholder for the required-but-ignored operationMode field, same
// convention the machine's own web UI uses.
func wsTare(ctx context.Context, baseURL string) error {
	req := &proto.UpdateSystemStateCommandDto{OperationMode: proto.ModeBrewAuto, TarePending: true}
	_, err := wsSendCommand(ctx, baseURL, actionSetTarePending, req.Marshal())
	return err
}

// wsServiceTest ports serviceTest(baseUrl, peripheral) — returns the
// machine's d_notif message text (only ever non-empty for this command,
// see wsSendCommand's header comment).
func wsServiceTest(ctx context.Context, baseURL string, peripheral proto.ServiceTestPeripheral) (string, error) {
	req := &proto.ServiceTestCommandDto{Peripheral: peripheral}
	return wsSendCommand(ctx, baseURL, actionServiceTest, req.Marshal())
}

// wsSaveSettings ports saveSettings(baseUrl): persists whatever settings
// are currently applied in RAM to flash.
func wsSaveSettings(ctx context.Context, baseURL string) error {
	_, err := wsSendCommand(ctx, baseURL, actionSaveSettings, nil)
	return err
}

// wsSaveActiveProfile ports saveActiveProfile(baseUrl): persists the
// active profile + its ID to flash (c_save_act_prof).
func wsSaveActiveProfile(ctx context.Context, baseURL string) error {
	_, err := wsSendCommand(ctx, baseURL, actionPersistActiveProfile, nil)
	return err
}
