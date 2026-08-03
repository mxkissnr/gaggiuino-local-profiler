// lib/gaggiuino-ws-client.js's #597 command functions (setOperationMode,
// tare, serviceTest, saveSettings, saveActiveProfile) — all built on
// sendCommand(), which correlates by the generic `d_resp` ack rather than a
// dedicated push action (see that function's header comment in the source).
// Mirrors test/gaggiuino-ws-client.test.js's mock-WS-server approach.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);

describe('gaggiuino-ws-client #597 commands', () => {
    let server, port, gaggiuinoWs, proto;

    beforeAll(async () => {
        gaggiuinoWs = req('../lib/gaggiuino-ws-client');
        proto = req('../lib/gaggiuino-proto');
        server = new WebSocketServer({ port: 0 });
        port = server.address().port;

        server.on('connection', (ws) => {
            ws.on('message', (data) => {
                const envelope = proto.WebSocketMessageDto.fromBinary(data);
                const ack = (action, result, errorMessage) => {
                    const resp = proto.WebSocketResponseDto.create({ action, result, errorMessage: errorMessage || '' });
                    const msg = proto.WebSocketMessageDto.create({ action: 'd_resp', data: proto.WebSocketResponseDto.toBinary(resp) });
                    ws.send(proto.WebSocketMessageDto.toBinary(msg));
                };

                if (envelope.action === proto.ND.SetOperationMode) {
                    const cmd = proto.UpdateSystemStateCommandDto.fromBinary(envelope.data);
                    // BREW_MANUAL(1) simulates the live-verified idle no-op: never acks.
                    if (cmd.operationMode === 1) return;
                    ack(proto.ND.SetOperationMode, proto.WebSocketResponseResultDto.SUCCESS);
                } else if (envelope.action === proto.ND.SetTarePending) {
                    const cmd = proto.UpdateSystemStateCommandDto.fromBinary(envelope.data);
                    if (!cmd.tarePending) return ack(proto.ND.SetTarePending, proto.WebSocketResponseResultDto.ERROR, 'tarePending not set');
                    ack(proto.ND.SetTarePending, proto.WebSocketResponseResultDto.SUCCESS);
                } else if (envelope.action === proto.ND.ServiceTest) {
                    const cmd = proto.ServiceTestCommandDto.fromBinary(envelope.data);
                    if (cmd.peripheral === 99) return ack(proto.ND.ServiceTest, proto.WebSocketResponseResultDto.ERROR, 'machine not idle');
                    ack(proto.ND.ServiceTest, proto.WebSocketResponseResultDto.SUCCESS);
                } else if (envelope.action === proto.ND.SaveSettings) {
                    ack(proto.ND.SaveSettings, proto.WebSocketResponseResultDto.SUCCESS);
                } else if (envelope.action === proto.ND.PersistActiveProfile) {
                    ack(proto.ND.PersistActiveProfile, proto.WebSocketResponseResultDto.SUCCESS);
                }
            });
        });
    });

    afterAll(() => server.close());

    const baseUrl = () => `http://127.0.0.1:${port}`;

    it('setOperationMode resolves ok on a SUCCESS ack', async () => {
        await expect(gaggiuinoWs.setOperationMode(baseUrl(), 'STEAM')).resolves.toEqual({ ok: true });
    });

    it('setOperationMode accepts the numeric wire value too', async () => {
        await expect(gaggiuinoWs.setOperationMode(baseUrl(), 4)).resolves.toEqual({ ok: true });
    });

    it('setOperationMode times out when the machine never acks (BREW_MANUAL-while-idle no-op)', async () => {
        await expect(gaggiuinoWs.setOperationMode(baseUrl(), 1)).rejects.toThrow(/Timed out/);
    }, 12000);

    it('tare resolves ok', async () => {
        await expect(gaggiuinoWs.tare(baseUrl())).resolves.toEqual({ ok: true });
    });

    it('serviceTest resolves ok for a valid peripheral', async () => {
        await expect(gaggiuinoWs.serviceTest(baseUrl(), 'LED')).resolves.toEqual({ ok: true });
    });

    it('serviceTest rejects with the machine\'s error message', async () => {
        await expect(gaggiuinoWs.serviceTest(baseUrl(), 99)).rejects.toThrow(/machine not idle/);
    });

    it('saveSettings resolves ok', async () => {
        await expect(gaggiuinoWs.saveSettings(baseUrl())).resolves.toEqual({ ok: true });
    });

    it('saveActiveProfile resolves ok', async () => {
        await expect(gaggiuinoWs.saveActiveProfile(baseUrl())).resolves.toEqual({ ok: true });
    });
});

// #600: real hardware never acks c_service_test via d_resp, only a d_notif
// ("Service test complete") — live-verified against gaggia.intern. This
// mock server reproduces that (d_notif only, no d_resp) to prove
// sendCommand()'s fallback works, separately from the d_resp-based mock
// server above.
describe('gaggiuino-ws-client c_service_test d_notif fallback (#600)', () => {
    let server, port, gaggiuinoWs, proto;

    beforeAll(async () => {
        gaggiuinoWs = req('../lib/gaggiuino-ws-client');
        proto = req('../lib/gaggiuino-proto');
        server = new WebSocketServer({ port: 0 });
        port = server.address().port;

        server.on('connection', (ws) => {
            ws.on('message', (data) => {
                const envelope = proto.WebSocketMessageDto.fromBinary(data);
                if (envelope.action !== proto.ND.ServiceTest) return;
                const notif = proto.NotificationDto.create({ type: proto.NotificationTypeDto.INFO, message: 'Service test complete' });
                const msg = proto.WebSocketMessageDto.create({ action: 'd_notif', data: proto.NotificationDto.toBinary(notif) });
                ws.send(proto.WebSocketMessageDto.toBinary(msg));
            });
        });
    });

    afterAll(() => server.close());

    it('resolves ok from a d_notif ack when no d_resp ever arrives', async () => {
        await expect(gaggiuinoWs.serviceTest(`http://127.0.0.1:${port}`, 'LED')).resolves.toEqual({ ok: true, message: 'Service test complete' });
    });
});
