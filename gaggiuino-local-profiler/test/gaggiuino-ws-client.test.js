// lib/gaggiuino-ws-client.js was verified live against a real Gaggiuino
// machine (create/read/update/delete all round-tripped correctly — see the
// project memory note this was reverse-engineered and confirmed from). These
// tests can't hit real hardware, so they run a mock WebSocket server that
// speaks the exact same protobuf envelope/action protocol, to lock in the
// request/response matching, error handling and timeout behavior without a
// live machine — and to catch any accidental drift in the schema going
// forward.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';

// lib/gaggiuino-ws-client.js and lib/gaggiuino-proto.js are CommonJS
// (this repo has no "type":"module") — createRequire lets this ESM test
// file load them directly instead of juggling dynamic-import interop.
const req = createRequire(import.meta.url);

describe('gaggiuino-ws-client', () => {
    let server, port, gaggiuinoWs, proto;

    beforeAll(async () => {
        gaggiuinoWs = req('../lib/gaggiuino-ws-client');
        proto = req('../lib/gaggiuino-proto');
        server = new WebSocketServer({ port: 0 });
        port = server.address().port;

        server.on('connection', (ws) => {
            ws.on('message', (data) => {
                const envelope = proto.WebSocketMessageDto.fromBinary(data);
                const reply = (action, payload) => {
                    const msg = proto.WebSocketMessageDto.create({
                        action, data: payload !== undefined ? payload : undefined,
                    });
                    ws.send(proto.WebSocketMessageDto.toBinary(msg));
                };

                if (envelope.action === proto.ND.GetProfileDict) {
                    const dict = proto.SavedProfilesDto.create({ profiles: [{ id: 1, name: 'Existing' }] });
                    reply('d_prof_dict', proto.SavedProfilesDto.toBinary(dict));
                } else if (envelope.action === proto.ND.GetProfileById) {
                    const id = proto.WebSocketProfileIdCommandDto.fromBinary(envelope.data).id;
                    if (id === 999) return; // simulate "never responds" for the timeout test
                    const profile = proto.ProfileDto.create({
                        id, name: 'Mock Profile',
                        phases: [{ name: 'P1', type: 1, target: { start: 0, end: 9, curve: 3, time: 1000, volume: 0 }, restriction: 0, stopConditions: { time: 5000, pressureAbove: 0, pressureBelow: 0, flowAbove: 0, flowBelow: 0, weight: 0, waterPumpedInPhase: 0 }, skip: false, waterTemperature: 93 }],
                        waterTemperature: 93,
                    });
                    reply('d_prof', proto.ProfileDto.toBinary(profile));
                } else if (envelope.action === proto.ND.CreateNewProfile) {
                    const p = proto.ProfileDto.fromBinary(envelope.data);
                    const dict = proto.SavedProfilesDto.create({ profiles: [{ id: 1, name: 'Existing' }, { id: 42, name: p.name }] });
                    reply('d_prof_dict', proto.SavedProfilesDto.toBinary(dict));
                } else if (envelope.action === proto.ND.UpdateProfile) {
                    const p = proto.ProfileDto.fromBinary(envelope.data);
                    const dict = proto.SavedProfilesDto.create({ profiles: [{ id: p.id, name: p.name }] });
                    reply('d_prof_dict', proto.SavedProfilesDto.toBinary(dict));
                } else if (envelope.action === proto.ND.DeleteProfile) {
                    const { id } = proto.WebSocketProfileIdCommandDto.fromBinary(envelope.data);
                    // id 1 "deletes" successfully (dropped from the list); any other id
                    // simulates a failed deletion — the machine still lists it.
                    const dict = proto.SavedProfilesDto.create({
                        profiles: id === 1 ? [] : [{ id, name: 'Still Here' }],
                    });
                    reply('d_prof_dict', proto.SavedProfilesDto.toBinary(dict));
                }
            });
        });
    });

    afterAll(() => server.close());

    const baseUrl = () => `http://127.0.0.1:${port}`;

    it('getProfileDict lists profiles', async () => {
        const profiles = await gaggiuinoWs.getProfileDict(baseUrl());
        expect(profiles).toEqual([{ id: 1, name: 'Existing' }]);
    });

    it('getProfileById decodes full phase detail', async () => {
        const profile = await gaggiuinoWs.getProfileById(baseUrl(), 7);
        expect(profile.id).toBe(7);
        expect(profile.phases).toHaveLength(1);
        expect(profile.phases[0].target.end).toBeCloseTo(9);
    });

    it('createProfile sends the profile and resolves with the assigned id', async () => {
        const created = await gaggiuinoWs.createProfile(baseUrl(), {
            name: 'New One',
            phases: [{ name: 'P', type: 'PRESSURE', target: { start: 0, end: 9, curve: 'LINEAR', time: 1000 }, stopConditions: {} }],
        });
        expect(created).toEqual({ id: 42, name: 'New One' });
    });

    it('updateProfile requires an id', async () => {
        await expect(gaggiuinoWs.updateProfile(baseUrl(), { name: 'No Id' })).rejects.toThrow(/requires profile.id/);
    });

    it('updateProfile sends the update and resolves with the confirmed profile', async () => {
        const updated = await gaggiuinoWs.updateProfile(baseUrl(), { id: 5, name: 'Renamed', phases: [] });
        expect(updated).toEqual({ id: 5, name: 'Renamed' });
    });

    it('deleteProfile resolves when the id is confirmed gone', async () => {
        const remaining = await gaggiuinoWs.deleteProfile(baseUrl(), 1);
        expect(remaining).toEqual([]);
    });

    it('deleteProfile rejects if the machine still lists the id', async () => {
        await expect(gaggiuinoWs.deleteProfile(baseUrl(), 999)).rejects.toThrow(/did not confirm deletion/);
    });

    it('times out cleanly when the machine never responds', async () => {
        await expect(gaggiuinoWs.getProfileById(baseUrl(), 999, )).rejects.toThrow(/Timed out/);
    }, 12000);

    it('toWireProfile accepts string enum names and converts them to wire ints', () => {
        const wire = gaggiuinoWs.toWireProfile({
            name: 'X',
            phases: [{ type: 'PRESSURE', target: { curve: 'LINEAR' }, stopConditions: {} }],
        });
        expect(wire.phases[0].type).toBe(1);
        expect(wire.phases[0].target.curve).toBe(3);
    });
});
