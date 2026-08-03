// Gaggiuino machine WebSocket/Protobuf message schema — reconstructed field-
// for-field from the machine's own web UI bundle (reflection-based message
// definitions the bundle ships for its own protobuf-ts runtime) and verified
// live against a real machine: GetProfileDict, GetProfileById, CreateNewProfile,
// UpdateProfile and DeleteProfile were all round-tripped successfully.
//
// Updating or deleting a profile only works over this binary WebSocket
// protocol (`ws://<host>/ws`) — no REST equivalent exists for either
// (live-verified, #580). Reads (GET /api/profiles/all, the list) exist as
// REST and are used elsewhere in this app (routes/system.js). Profile
// *detail* also gained a REST read on newer firmware (build 7889b7d+,
// GET /api/profile/:id, same JSON shape as ProfileDto below) — GLP tries
// that first and falls back to this module's getProfileById on older
// firmware (see lib/machines/gaggiuino/adapter.js's getProfile()). Newer
// firmware also gained a REST *create* (POST /api/profile, create-only —
// an `id` in the body is ignored, always minting a new one, #580), tried
// first by this module's createProfile() equivalent in the adapter. This
// module remains required for update/delete on every firmware version, and
// as the create/detail-read fallback for older firmware.
//
// #597: SensorStateSnapshotDto/SystemStateDto/UpdateSystemStateCommandDto/
// ServiceTestCommandDto below were added straight from the Gaggiuino
// project's own published WS API reference (docs/rest-api/websocket.md in
// gaggiuino/gaggiuino.github.io) rather than reverse-engineered from a
// bundle — field numbers/types are transcribed verbatim from that doc.
// ServiceTestCommandDto (and ServiceTestPeripheralDto) have since been
// live-verified against a real machine (#600, LED peripheral): the machine
// correctly interpreted the command and flashed the LED. Unexpectedly, no
// `d_resp` was ever sent for it despite the docs stating every c_* command
// gets one — the actual completion signal was a `d_resp`-shaped-but-different
// push, `d_notif` (NotificationDto below), with message "Service test
// complete". gaggiuino-ws-client.js's sendCommand() treats a matching
// d_notif as an alternative success signal specifically for c_service_test
// (not broadened to other commands, which already work via d_resp as
// documented — opmode/tare live-verified separately, see #581's closure).
// Settings themselves (GaggiaSettingsDto) are deliberately NOT modeled here:
// the settings proxy uses the REST endpoints (GET/POST /api/settings/*, see
// lib/machines/gaggiuino/adapter.js), which carry plain JSON, not this
// binary protocol.
const { MessageType } = require('@protobuf-ts/runtime');

// ── Enums ──
const PhaseTypeDto = { 0: 'FLOW', FLOW: 0, 1: 'PRESSURE', PRESSURE: 1, 2: 'MANUAL', MANUAL: 2 };
const TransitionCurveDto = { 0: 'EASE_IN_OUT', EASE_IN_OUT: 0, 1: 'EASE_IN', EASE_IN: 1, 2: 'EASE_OUT', EASE_OUT: 2, 3: 'LINEAR', LINEAR: 3, 4: 'INSTANT', INSTANT: 4 };
const WebSocketResponseResultDto = { 0: 'SUCCESS', SUCCESS: 0, 1: 'ERROR', ERROR: 1 };
const OperationModeDto = {
    0: 'BREW_AUTO', BREW_AUTO: 0, 1: 'BREW_MANUAL', BREW_MANUAL: 1,
    2: 'FLUSH', FLUSH: 2, 3: 'DESCALE', DESCALE: 3, 4: 'STEAM', STEAM: 4,
    5: 'FLUSH_AUTO', FLUSH_AUTO: 5, 6: 'HOT_WATER', HOT_WATER: 6, 7: 'HOME', HOME: 7,
};
const ServiceTestPeripheralDto = { 0: 'PUMP', PUMP: 0, 1: 'VALVE', VALVE: 1, 2: 'VALVE_B', VALVE_B: 2, 3: 'LED', LED: 3 };
const NotificationTypeDto = { 0: 'INFO', INFO: 0, 1: 'SUCCESS', SUCCESS: 1, 2: 'WARN', WARN: 2, 3: 'ERROR', ERROR: 3 };

// ── Action codes — request (g_/c_ prefixed) and their matching server-push
// response action (d_ prefixed) are DIFFERENT strings, not the same one
// echoed back. e.g. request GetProfileDict ('g_prof_dict') is answered by a
// push whose action is 'd_prof_dict', not 'g_prof_dict'. The #597 commands
// below (SetOperationMode/SetTarePending/ServiceTest/SaveSettings) are
// acknowledged by the generic 'd_resp' (WebSocketResponseDto) instead of a
// dedicated push action — see gaggiuino-ws-client.js's sendCommand(), not
// sendAndWait()/RESPONSE_ACTION below, which is only for the request/push
// pairs that answer with a specific data type. ──
const ND = {
    GetActiveProfile: 'g_act_prof', UpdateActiveProfile: 'c_upd_act_prof',
    UpdateActiveProfileId: 'c_upd_act_prof_id', PersistActiveProfile: 'c_save_act_prof',
    GetProfileDict: 'g_prof_dict', GetProfileById: 'g_prof',
    CreateNewProfile: 'c_new_prof', UpdateProfile: 'c_upd_prof',
    DeleteProfile: 'c_del_prof', ReorderProfile: 'c_reorder_prof',
    GetSystemState: 'g_sys_state', SetOperationMode: 'c_opmode', SetTarePending: 'c_tare_pend',
    ServiceTest: 'c_service_test', SaveSettings: 'c_save_settings',
};
// Matching push-response action for each request action above.
const RESPONSE_ACTION = {
    [ND.GetProfileDict]: 'd_prof_dict',
    [ND.GetProfileById]: 'd_prof',
    [ND.CreateNewProfile]: 'd_prof_dict',
    [ND.UpdateProfile]: 'd_prof_dict',
    [ND.DeleteProfile]: 'd_prof_dict',
};

let PhaseStopConditionsDto, TransitionDto, PhaseDto, GlobalStopConditionsDto,
    BrewRecipeDto, ProfileDto, WebSocketProfileIdCommandDto,
    WebSocketMessageDto, WebSocketResponseDto, SavedProfileDto, SavedProfilesDto,
    UpdateSystemStateCommandDto, ServiceTestCommandDto, SensorStateSnapshotDto, SystemStateDto,
    NotificationDto;

PhaseStopConditionsDto = new MessageType('PhaseStopConditionsDto', [
    { no: 1, name: 'time', kind: 'scalar', T: 13 },
    { no: 2, name: 'pressureAbove', kind: 'scalar', T: 2 },
    { no: 3, name: 'pressureBelow', kind: 'scalar', T: 2 },
    { no: 4, name: 'flowAbove', kind: 'scalar', T: 2 },
    { no: 5, name: 'flowBelow', kind: 'scalar', T: 2 },
    { no: 6, name: 'weight', kind: 'scalar', T: 2 },
    { no: 7, name: 'waterPumpedInPhase', kind: 'scalar', T: 2 },
]);

TransitionDto = new MessageType('TransitionDto', [
    { no: 1, name: 'start', kind: 'scalar', T: 2 },
    { no: 2, name: 'end', kind: 'scalar', T: 2 },
    { no: 3, name: 'curve', kind: 'enum', T: () => ['TransitionCurveDto', TransitionCurveDto] },
    { no: 4, name: 'time', kind: 'scalar', T: 13 },
    { no: 5, name: 'volume', kind: 'scalar', T: 2 },
]);

PhaseDto = new MessageType('PhaseDto', [
    { no: 1, name: 'type', kind: 'enum', T: () => ['PhaseTypeDto', PhaseTypeDto] },
    { no: 2, name: 'target', kind: 'message', T: () => TransitionDto },
    { no: 3, name: 'restriction', kind: 'scalar', T: 2 },
    { no: 4, name: 'stopConditions', kind: 'message', T: () => PhaseStopConditionsDto },
    { no: 5, name: 'waterTemperature', kind: 'scalar', T: 2 },
    { no: 6, name: 'name', kind: 'scalar', T: 9 },
    { no: 7, name: 'skip', kind: 'scalar', T: 8 },
]);

GlobalStopConditionsDto = new MessageType('GlobalStopConditionsDto', [
    { no: 1, name: 'time', kind: 'scalar', T: 13 },
    { no: 2, name: 'weight', kind: 'scalar', T: 2 },
    { no: 3, name: 'waterPumped', kind: 'scalar', T: 2 },
    { no: 4, name: 'switchToManualPressureCtrl', kind: 'scalar', T: 8 },
    { no: 5, name: 'switchToManuaFlowCtrl', kind: 'scalar', T: 8 },
]);

BrewRecipeDto = new MessageType('BrewRecipeDto', [
    { no: 1, name: 'coffeeIn', kind: 'scalar', T: 2 },
    { no: 2, name: 'coffeeOut', kind: 'scalar', T: 2 },
    { no: 3, name: 'ratio', kind: 'scalar', T: 2 },
]);

ProfileDto = new MessageType('ProfileDto', [
    { no: 1, name: 'name', kind: 'scalar', T: 9 },
    { no: 2, name: 'phases', kind: 'message', repeat: 2, T: () => PhaseDto },
    { no: 3, name: 'globalStopConditions', kind: 'message', T: () => GlobalStopConditionsDto },
    { no: 4, name: 'waterTemperature', kind: 'scalar', T: 2 },
    { no: 5, name: 'recipe', kind: 'message', T: () => BrewRecipeDto },
    { no: 6, name: 'id', kind: 'scalar', T: 13 },
]);

WebSocketProfileIdCommandDto = new MessageType('WebSocketProfileIdCommandDto', [
    { no: 1, name: 'id', kind: 'scalar', T: 13 },
]);

WebSocketMessageDto = new MessageType('WebSocketMessageDto', [
    { no: 1, name: 'action', kind: 'scalar', T: 9 },
    { no: 2, name: 'data', kind: 'scalar', T: 12 },
]);

WebSocketResponseDto = new MessageType('WebSocketResponseDto', [
    { no: 1, name: 'action', kind: 'scalar', T: 9 },
    { no: 2, name: 'result', kind: 'enum', T: () => ['WebSocketResponseResultDto', WebSocketResponseResultDto] },
    { no: 3, name: 'errorMessage', kind: 'scalar', T: 9 },
]);

SavedProfileDto = new MessageType('SavedProfileDto', [
    { no: 1, name: 'id', kind: 'scalar', T: 13 },
    { no: 2, name: 'name', kind: 'scalar', T: 9 },
]);

SavedProfilesDto = new MessageType('SavedProfilesDto', [
    { no: 1, name: 'profiles', kind: 'message', repeat: 2, T: () => SavedProfileDto },
]);

// Pushed as `d_notif` — mirrors the machine's on-screen/MQTT notifications.
// Live-verified (#600): the completion signal for c_service_test arrives
// this way, not via d_resp — see the header comment above.
NotificationDto = new MessageType('NotificationDto', [
    { no: 1, name: 'type', kind: 'enum', T: () => ['NotificationTypeDto', NotificationTypeDto] },
    { no: 2, name: 'message', kind: 'scalar', T: 9 },
]);

// #597 additions below — see the header comment: transcribed from the
// published WS API doc, not reverse-engineered/live-verified like the
// profile CRUD messages above.

// Shared payload for c_opmode and c_tare_pend — each handler only reads the
// one field it cares about, so the unused one is sent as a placeholder (see
// gaggiuino-ws-client.js's tare()/setOperationMode()).
UpdateSystemStateCommandDto = new MessageType('UpdateSystemStateCommandDto', [
    { no: 1, name: 'operationMode', kind: 'enum', T: () => ['OperationModeDto', OperationModeDto] },
    { no: 2, name: 'tarePending', kind: 'scalar', T: 8 },
]);

ServiceTestCommandDto = new MessageType('ServiceTestCommandDto', [
    { no: 1, name: 'peripheral', kind: 'enum', T: () => ['ServiceTestPeripheralDto', ServiceTestPeripheralDto] },
]);

// Live sensor readings pushed continuously as `d_sensor_snap` — real
// (unscaled) numbers, unlike the x10-scaled-integer shot/REST-status wire
// formats. See lib/gaggiuino-live-client.js for the persistent-connection
// cache that decodes these.
SensorStateSnapshotDto = new MessageType('SensorStateSnapshotDto', [
    { no: 1, name: 'brewActive', kind: 'scalar', T: 8 },
    { no: 2, name: 'steamActive', kind: 'scalar', T: 8 },
    { no: 3, name: 'hotWaterSwitchState', kind: 'scalar', T: 8 },
    { no: 4, name: 'temperature', kind: 'scalar', T: 2 },
    { no: 5, name: 'waterTemperature', kind: 'scalar', T: 2 },
    { no: 6, name: 'pressure', kind: 'scalar', T: 2 },
    { no: 7, name: 'pumpFlow', kind: 'scalar', T: 2 },
    { no: 8, name: 'weightFlow', kind: 'scalar', T: 2 },
    { no: 9, name: 'weight', kind: 'scalar', T: 2 },
    { no: 10, name: 'waterLevel', kind: 'scalar', T: 13 },
    { no: 11, name: 'boilerState', kind: 'scalar', T: 8 },
    { no: 12, name: 'brewSwitchActive', kind: 'scalar', T: 8 },
    { no: 13, name: 'valveState', kind: 'scalar', T: 8 },
    { no: 14, name: 'steamValveState', kind: 'scalar', T: 8 },
    { no: 15, name: 'valveBState', kind: 'scalar', T: 8 },
    { no: 16, name: 'steamBoilerRelayState', kind: 'scalar', T: 8 },
    { no: 17, name: 'pinBrewLevel', kind: 'scalar', T: 8 },
    { no: 18, name: 'pinSteamLevel', kind: 'scalar', T: 8 },
    { no: 19, name: 'pinWaterLevel', kind: 'scalar', T: 8 },
    { no: 20, name: 'pinRelayLevel', kind: 'scalar', T: 8 },
    { no: 21, name: 'pinValveLevel', kind: 'scalar', T: 8 },
    { no: 22, name: 'pinValveBLevel', kind: 'scalar', T: 8 },
    { no: 23, name: 'pinRelayValveBLevel', kind: 'scalar', T: 8 },
    { no: 24, name: 'pinSteamValveRelayLevel', kind: 'scalar', T: 8 },
    { no: 25, name: 'pinSteamBoilerRelayLevel', kind: 'scalar', T: 8 },
    { no: 26, name: 'pinZcLevel', kind: 'scalar', T: 8 },
    { no: 27, name: 'pinDimmerLevel', kind: 'scalar', T: 8 },
    { no: 28, name: 'pinThermoCsLevel', kind: 'scalar', T: 8 },
    { no: 29, name: 'pinThermoClkLevel', kind: 'scalar', T: 8 },
    { no: 30, name: 'pinThermoDoLevel', kind: 'scalar', T: 8 },
    { no: 31, name: 'pinThermoDiLevel', kind: 'scalar', T: 8 },
    { no: 32, name: 'pinHx711SckLevel', kind: 'scalar', T: 8 },
    { no: 33, name: 'pinHx711Dout1Level', kind: 'scalar', T: 8 },
    { no: 34, name: 'pinHx711Dout2Level', kind: 'scalar', T: 8 },
]);

// System/status info pushed on change and in response to g_sys_state.
SystemStateDto = new MessageType('SystemStateDto', [
    { no: 1, name: 'startupInitFinished', kind: 'scalar', T: 8 },
    { no: 2, name: 'tofReady', kind: 'scalar', T: 8 },
    { no: 3, name: 'isSteamForgottenON', kind: 'scalar', T: 8 },
    { no: 4, name: 'scalesPresent', kind: 'scalar', T: 8 },
    { no: 5, name: 'operationMode', kind: 'enum', T: () => ['OperationModeDto', OperationModeDto] },
    { no: 6, name: 'timeAlive', kind: 'scalar', T: 13 },
    { no: 7, name: 'coreVersion', kind: 'scalar', T: 9 },
    { no: 8, name: 'tarePending', kind: 'scalar', T: 8 },
    { no: 9, name: 'coreType', kind: 'scalar', T: 9 },
    { no: 10, name: 'thermocoupleFaulted', kind: 'scalar', T: 8 },
    { no: 11, name: 'pressureSensorFaulted', kind: 'scalar', T: 8 },
    { no: 12, name: 'thermocoupleFaultReason', kind: 'scalar', T: 9 },
    { no: 13, name: 'pressureSensorFaultReason', kind: 'scalar', T: 9 },
    { no: 14, name: 'pcbV2', kind: 'scalar', T: 8 },
]);

module.exports = {
    PhaseTypeDto, TransitionCurveDto, WebSocketResponseResultDto, OperationModeDto,
    ServiceTestPeripheralDto, NotificationTypeDto, ND, RESPONSE_ACTION,
    PhaseStopConditionsDto, TransitionDto, PhaseDto, GlobalStopConditionsDto,
    BrewRecipeDto, ProfileDto, WebSocketProfileIdCommandDto,
    WebSocketMessageDto, WebSocketResponseDto, SavedProfileDto, SavedProfilesDto,
    UpdateSystemStateCommandDto, ServiceTestCommandDto, SensorStateSnapshotDto, SystemStateDto,
    NotificationDto,
};
