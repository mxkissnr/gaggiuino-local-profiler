// lib/machines/gaggiuino/adapter.js's #597 settings/firmware REST proxy
// functions (getSettings, updateSettings, getFirmwareProgress,
// triggerFirmwareUpdate) — plain REST passthrough to the machine's own
// /api/settings/* and /api/firmware/* endpoints. Mirrors
// test/gaggiuino-adapter.test.js's mock-HTTP-server approach.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const req = createRequire(import.meta.url);

vi.spyOn(req('../lib/ssrf-guard'), 'assertMachineHost').mockResolvedValue();

describe('gaggiuino adapter settings/firmware proxy (#597)', () => {
    let httpServer, port, adapter;

    beforeAll(async () => {
        adapter = req('../lib/machines/gaggiuino/adapter');

        httpServer = http.createServer((request, response) => {
            const send = (status, body) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(body));
            };

            if (request.method === 'GET' && request.url === '/api/settings') {
                return send(200, { boiler: { steamSetPoint: 145 }, system: { pumpFlowAtZero: 0.5 } });
            }
            if (request.method === 'GET' && request.url === '/api/settings/boiler') {
                return send(200, { steamSetPoint: 145, offsetTemp: 5 });
            }
            if (request.method === 'POST' && request.url === '/api/settings/boiler') {
                let body = '';
                request.on('data', (c) => { body += c; });
                return request.on('end', () => send(200, { success: true, echoed: JSON.parse(body) }));
            }
            if (request.method === 'GET' && request.url === '/api/firmware/progress') {
                return send(200, { progress: 42, status: 'IN_PROGRESS', type: 'C_FW' });
            }
            if (request.method === 'POST' && request.url === '/api/firmware/update-all') {
                return send(200, { message: 'Update started', success: true });
            }
            send(404, { error: 'not found' });
        });

        await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
        port = httpServer.address().port;
    });

    afterAll(() => httpServer.close());

    const machine = () => ({ host: `127.0.0.1:${port}`, type: 'gaggiuino' });

    it('getSettings with no category fetches the full settings object', async () => {
        const settings = await adapter.getSettings(machine());
        expect(settings).toEqual({ boiler: { steamSetPoint: 145 }, system: { pumpFlowAtZero: 0.5 } });
    });

    it('getSettings with a category fetches just that category', async () => {
        const settings = await adapter.getSettings(machine(), 'boiler');
        expect(settings).toEqual({ steamSetPoint: 145, offsetTemp: 5 });
    });

    it('updateSettings posts the payload to the category endpoint', async () => {
        const result = await adapter.updateSettings(machine(), 'boiler', { steamSetPoint: 150 });
        expect(result.success).toBe(true);
        expect(result.echoed).toEqual({ steamSetPoint: 150 });
    });

    it('getFirmwareProgress returns the progress payload', async () => {
        const progress = await adapter.getFirmwareProgress(machine());
        expect(progress).toEqual({ progress: 42, status: 'IN_PROGRESS', type: 'C_FW' });
    });

    it('triggerFirmwareUpdate posts to update-all', async () => {
        const result = await adapter.triggerFirmwareUpdate(machine());
        expect(result).toEqual({ message: 'Update started', success: true });
    });

    it('capabilities() reports settingsProxy: true', () => {
        expect(adapter.capabilities().settingsProxy).toBe(true);
    });
});
