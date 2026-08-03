// WebSocket client for the Gaggiuino machine's binary protobuf protocol
// (see lib/gaggiuino-proto.js for the message schema and where it came
// from). The machine has no REST endpoint for writing profiles — only this
// WebSocket channel supports create/update/delete. Newer firmware (build
// 7889b7d+) adds a REST GET /api/profile/:id for detail reads, so
// getProfileById here is now a fallback for that (used when the REST call
// fails, e.g. older firmware) rather than the only read path — see
// lib/machines/gaggiuino/adapter.js's getProfile().
//
// Each exported function opens its own short-lived connection, sends one
// request, waits for the matching push-response action, then closes — the
// machine doesn't support (and doesn't need, for our call volume) a
// persistent connection with request/response correlation IDs.
const WebSocket = require('ws');
const {
    ND, RESPONSE_ACTION, WebSocketMessageDto, WebSocketProfileIdCommandDto,
    ProfileDto, SavedProfilesDto, PhaseTypeDto, TransitionCurveDto,
    WebSocketResponseDto, WebSocketResponseResultDto,
    UpdateSystemStateCommandDto, ServiceTestCommandDto,
    OperationModeDto, ServiceTestPeripheralDto,
    NotificationDto,
} = require('./gaggiuino-proto');

const DEFAULT_TIMEOUT_MS = 8000;

// baseUrl: 'http://host' or 'http://host:port' (as returned by
// lib/data.js's getMachineBaseUrl) — converted to the matching ws:// URL.
function wsUrlFor(baseUrl) {
    const u = new URL(baseUrl);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}/ws`;
}

// Sends one WebSocketMessageDto and resolves with the decoded payload of the
// first matching push-response action seen. `requestData` (already-encoded
// bytes) is optional — several actions (GetProfileDict) take none.
function sendAndWait(baseUrl, action, requestData, responseMsgType, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const expectedAction = RESPONSE_ACTION[action];
        if (!expectedAction) return reject(new Error(`No known response action for request action "${action}"`));

        let settled = false;
        const ws = new WebSocket(wsUrlFor(baseUrl));
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ws.terminate();
            reject(new Error(`Timed out waiting for "${expectedAction}" from the machine`));
        }, timeoutMs);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* already closing */ }
            err ? reject(err) : resolve(value);
        }

        ws.on('open', () => {
            const msg = WebSocketMessageDto.create(requestData !== undefined ? { action, data: requestData } : { action });
            ws.send(WebSocketMessageDto.toBinary(msg));
        });

        ws.on('message', (data) => {
            if (settled) return;
            let envelope;
            try { envelope = WebSocketMessageDto.fromBinary(data); } catch { return; } // not a valid envelope frame, ignore
            if (envelope.action !== expectedAction || !envelope.data) return;
            try {
                finish(null, responseMsgType.fromBinary(envelope.data));
            } catch (e) {
                finish(new Error(`Failed to decode "${expectedAction}" response: ${e.message}`));
            }
        });

        ws.on('error', (e) => finish(new Error(`WebSocket error: ${e.message}`)));
    });
}

// Sends a c_* command and waits for its `d_resp` acknowledgement instead of
// a specific follow-up data push (#597) — distinct from sendAndWait() above,
// which correlates by waiting for a *different*, action-specific push (e.g.
// d_prof_dict after c_new_prof). The commands this wraps (opmode/tare/
// service-test/save-settings/save-active-profile) are confirmed by the
// generic ack itself: WebSocketResponseDto.action echoes the action sent,
// and .result/.errorMessage report success or failure.
//
// c_service_test is a documented exception (#600, live-verified): the
// machine never sends a d_resp for it, only a d_notif ("Service test
// complete"). Treated as an alternative success signal ONLY for that one
// action — every other command here still works via d_resp exactly as
// documented (opmode/tare live-verified separately, #581), so this isn't
// broadened to the whole function.
function sendCommand(baseUrl, action, requestData, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(wsUrlFor(baseUrl));
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ws.terminate();
            reject(new Error(`Timed out waiting for a "${action}" acknowledgement from the machine`));
        }, timeoutMs);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* already closing */ }
            err ? reject(err) : resolve(value);
        }

        ws.on('open', () => {
            const msg = WebSocketMessageDto.create(requestData !== undefined ? { action, data: requestData } : { action });
            ws.send(WebSocketMessageDto.toBinary(msg));
        });

        ws.on('message', (data) => {
            if (settled) return;
            let envelope;
            try { envelope = WebSocketMessageDto.fromBinary(data); } catch { return; }
            if (!envelope.data) return;

            if (envelope.action === 'd_resp') {
                let resp;
                try { resp = WebSocketResponseDto.fromBinary(envelope.data); } catch { return; }
                if (resp.action !== action) return; // ack for a different in-flight command on this connection
                if (resp.result === WebSocketResponseResultDto.ERROR) finish(new Error(resp.errorMessage || `Machine rejected "${action}"`));
                else finish(null, { ok: true });
                return;
            }

            // c_service_test-only fallback — see this function's header comment.
            if (action === ND.ServiceTest && envelope.action === 'd_notif') {
                let notif;
                try { notif = NotificationDto.fromBinary(envelope.data); } catch { return; }
                finish(null, { ok: true, message: notif.message });
            }
        });

        ws.on('error', (e) => finish(new Error(`WebSocket error: ${e.message}`)));
    });
}

async function getProfileDict(baseUrl) {
    const dict = await sendAndWait(baseUrl, ND.GetProfileDict, undefined, SavedProfilesDto);
    return dict.profiles; // [{id, name}, ...]
}

async function getProfileById(baseUrl, id) {
    const req = WebSocketProfileIdCommandDto.toBinary(WebSocketProfileIdCommandDto.create({ id }));
    return sendAndWait(baseUrl, ND.GetProfileById, req, ProfileDto);
}

// `profile` uses the app's plain-JSON shape (phase.type/curve as strings
// like "PRESSURE"/"LINEAR", matching the machine's own web UI convention)
// — converted to the wire enum ints here, mirroring the machine UI's own
// Tj() transform (see lib/gaggiuino-proto.js's header comment / the memory
// note this was reverse-engineered from — no unit scaling, raw floats).
function toWireProfile(profile) {
    return {
        id: profile.id || 0,
        name: profile.name,
        phases: (profile.phases || []).map(p => ({
            name: p.name || '',
            type: typeof p.type === 'string' ? PhaseTypeDto[p.type] : p.type,
            target: {
                start: p.target?.start || 0,
                end: p.target?.end || 0,
                curve: typeof p.target?.curve === 'string' ? TransitionCurveDto[p.target.curve] : (p.target?.curve || 0),
                time: p.target?.time || 0,
                volume: p.target?.volume || 0,
            },
            restriction: p.restriction || 0,
            stopConditions: {
                time: p.stopConditions?.time || 0,
                pressureAbove: p.stopConditions?.pressureAbove || 0,
                pressureBelow: p.stopConditions?.pressureBelow || 0,
                flowAbove: p.stopConditions?.flowAbove || 0,
                flowBelow: p.stopConditions?.flowBelow || 0,
                weight: p.stopConditions?.weight || 0,
                waterPumpedInPhase: p.stopConditions?.waterPumpedInPhase || 0,
            },
            skip: !!p.skip,
            waterTemperature: p.waterTemperature || 0,
        })),
        globalStopConditions: profile.globalStopConditions ? {
            time: profile.globalStopConditions.time || 0,
            weight: profile.globalStopConditions.weight || 0,
            waterPumped: profile.globalStopConditions.waterPumped || 0,
            switchToManualPressureCtrl: !!profile.globalStopConditions.switchToManualPressureCtrl,
            switchToManuaFlowCtrl: !!profile.globalStopConditions.switchToManuaFlowCtrl,
        } : undefined,
        waterTemperature: profile.waterTemperature || 0,
        recipe: profile.recipe ? {
            coffeeIn: profile.recipe.coffeeIn || 0,
            coffeeOut: profile.recipe.coffeeOut || 0,
            ratio: profile.recipe.ratio || 0,
        } : undefined,
    };
}

async function createProfile(baseUrl, profile) {
    const wire = ProfileDto.create(toWireProfile(profile));
    const dict = await sendAndWait(baseUrl, ND.CreateNewProfile, ProfileDto.toBinary(wire), SavedProfilesDto);
    const created = dict.profiles.find(p => p.name === profile.name);
    if (!created) throw new Error('Machine did not confirm the new profile in its profile list');
    return created; // {id, name}
}

async function updateProfile(baseUrl, profile) {
    if (profile.id == null) throw new Error('updateProfile requires profile.id — create a profile first');
    const wire = ProfileDto.create(toWireProfile(profile));
    const dict = await sendAndWait(baseUrl, ND.UpdateProfile, ProfileDto.toBinary(wire), SavedProfilesDto);
    const updated = dict.profiles.find(p => p.id === profile.id);
    if (!updated) throw new Error(`Machine did not confirm profile id ${profile.id} after update`);
    return updated; // {id, name}
}

async function deleteProfile(baseUrl, id) {
    const req = WebSocketProfileIdCommandDto.toBinary(WebSocketProfileIdCommandDto.create({ id }));
    const dict = await sendAndWait(baseUrl, ND.DeleteProfile, req, SavedProfilesDto);
    const stillThere = dict.profiles.some(p => p.id === id);
    if (stillThere) throw new Error(`Machine did not confirm deletion of profile id ${id}`);
    return dict.profiles;
}

// #597 — settings/control proxy commands. All share sendCommand()'s
// generic d_resp ack rather than a specific data push; see that function's
// header comment for why this differs from the profile CRUD functions above.

// mode: OperationModeDto enum name or numeric value (see gaggiuino-proto.js)
// — converted to the wire enum int here, same convention as
// toWireProfile()'s type/curve handling above. tarePending is always false
// here — c_tare_pend below is the dedicated path for a tare, and this field
// is unread by the opmode handler regardless (see
// UpdateSystemStateCommandDto's doc comment).
async function setOperationMode(baseUrl, mode) {
    const operationMode = typeof mode === 'string' ? OperationModeDto[mode] : mode;
    const req = UpdateSystemStateCommandDto.toBinary(UpdateSystemStateCommandDto.create({ operationMode, tarePending: false }));
    return sendCommand(baseUrl, ND.SetOperationMode, req);
}

// operationMode is required by the wire format but ignored by the
// c_tare_pend handler (see UpdateSystemStateCommandDto's doc comment) —
// BREW_AUTO (0) is sent as an inert placeholder, same convention the
// machine's own web UI uses.
async function tare(baseUrl) {
    const req = UpdateSystemStateCommandDto.toBinary(UpdateSystemStateCommandDto.create({ operationMode: 0, tarePending: true }));
    return sendCommand(baseUrl, ND.SetTarePending, req);
}

// peripheral: ServiceTestPeripheralDto enum name or numeric value. Only
// takes effect while the machine is idle (refused otherwise) — see
// ServiceTestCommandDto's doc comment in gaggiuino-proto.js.
async function serviceTest(baseUrl, peripheral) {
    const wirePeripheral = typeof peripheral === 'string' ? ServiceTestPeripheralDto[peripheral] : peripheral;
    const req = ServiceTestCommandDto.toBinary(ServiceTestCommandDto.create({ peripheral: wirePeripheral }));
    return sendCommand(baseUrl, ND.ServiceTest, req);
}

// Persists whatever settings are currently applied in RAM (e.g. via the
// machine's own UI, or a prior REST POST /api/settings/* — which already
// auto-persists on its own) to flash. See websocket.md's "Settings
// persistence" section for the RAM-apply/flash-persist split this mirrors.
async function saveSettings(baseUrl) {
    return sendCommand(baseUrl, ND.SaveSettings, undefined);
}

// Persists the active profile + its ID to flash (c_save_act_prof).
async function saveActiveProfile(baseUrl) {
    return sendCommand(baseUrl, ND.PersistActiveProfile, undefined);
}

module.exports = {
    getProfileDict, getProfileById, createProfile, updateProfile, deleteProfile, toWireProfile, wsUrlFor,
    setOperationMode, tare, serviceTest, saveSettings, saveActiveProfile,
};
