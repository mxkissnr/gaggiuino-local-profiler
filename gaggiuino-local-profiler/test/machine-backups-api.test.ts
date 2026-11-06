import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  MachineBackup, MachineBackupDetail, MachineBackupDocument, MachineBackupSecrets, MachineBackupSettings,
} from '../public-src/api/types.js';
import type { MachineBackupFailure } from '../public-src/api/machine-backups.js';

// The backups client must stay inside GLP: relative URLs only, every id through
// pathSeg, every failure typed (#1878). No real machine is ever contacted - every
// request is answered by the fetch stub below.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const api = await import('../public-src/api/machine-backups.js');
const { diffMachineBackups } = await import('../public-src/shared/machine-backup-diff.js');

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const SERVER_TEXT = 'brew is running, nothing was sent';
const NO_BODY = Symbol('no body');
const DEFAULT_NAME = 'gaggiuino-backup.json';
const GOOD_NAME = 'gaggiuino-backup-m3-2026-11-05_0930.json';

const entry: MachineBackup = {
  id: 5,
  machineId: 3,
  createdAt: 1762336200000,
  kind: 'manual',
  firmwareCore: '8aaf6f0',
  firmwareFrontend: '8aaf6f0',
  profileCount: 2,
  sizeBytes: 1200,
  contentHash: 'abc',
  note: '',
};

const doc: MachineBackupDocument = { format: 'gaggiuino-settings' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function raw(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

function page(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/html' } });
}

function generic(status: number): MachineBackupFailure {
  return { ok: false, status, code: null, reason: null, machineError: null };
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

// Headers normalises names to lower case, so the assertions below name them that way.
function headerRecord(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function call(i = 0): Sent {
  const entryCall = fetchMock.mock.calls[i];
  if (entryCall === undefined) throw new Error(`no fetch call at index ${i}`);
  const [url, init] = entryCall;
  const body = init?.body;
  return {
    url,
    method: init?.method ?? 'GET',
    headers: headerRecord(init),
    body: typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  g.fetch = fetchMock;
});

afterEach(() => {
  for (const [url] of fetchMock.mock.calls) {
    expect(url).toMatch(/^api\/machine\/backups(\/|\?|$)/);
  }
});

describe('routes', () => {
  it('sends each route with its method, relative URL and body', async () => {
    const settings: MachineBackupSettings = { machineId: 3, schedule: 'weekly', keepAutomatic: 5 };
    const rows: {
      readonly run: () => Promise<unknown>;
      readonly response: () => Response;
      readonly method: string;
      readonly url: string;
      readonly body: unknown;
    }[] = [
      { run: () => api.listMachineBackups(3), response: () => json(200, []), method: 'GET', url: 'api/machine/backups?machineId=3', body: NO_BODY },
      { run: () => api.listMachineBackups(null), response: () => json(200, []), method: 'GET', url: 'api/machine/backups', body: NO_BODY },
      {
        run: () => api.backUpMachineNow(3, 'before descaling'), response: () => json(201, entry), method: 'POST',
        url: 'api/machine/backups', body: { machineId: 3, note: 'before descaling' },
      },
      {
        run: () => api.backUpMachineNow(3), response: () => json(201, entry), method: 'POST',
        url: 'api/machine/backups', body: { machineId: 3 },
      },
      { run: () => api.deleteMachineBackup(5), response: () => json(200, { ok: true }), method: 'DELETE', url: 'api/machine/backups/5', body: NO_BODY },
      {
        run: () => api.getMachineBackup(5), response: () => json(200, { ...entry, document: {} }), method: 'GET',
        url: 'api/machine/backups/5', body: NO_BODY,
      },
      {
        run: () => api.downloadMachineBackup(5), response: () => new Response('{}', { status: 200 }), method: 'GET',
        url: 'api/machine/backups/5/download', body: NO_BODY,
      },
      {
        run: () => api.uploadMachineBackup(3, doc, 'from file'), response: () => json(201, entry), method: 'POST',
        url: 'api/machine/backups/upload', body: { machineId: 3, document: doc, note: 'from file' },
      },
      {
        run: () => api.uploadMachineBackup(3, doc), response: () => json(201, entry), method: 'POST',
        url: 'api/machine/backups/upload', body: { machineId: 3, document: doc },
      },
      {
        run: () => api.getMachineBackupSettings(3), response: () => json(200, settings), method: 'GET',
        url: 'api/machine/backups/settings?machineId=3', body: NO_BODY,
      },
      {
        run: () => api.saveMachineBackupSettings({ machineId: 3, schedule: 'weekly', keepAutomatic: 5 }),
        response: () => json(200, settings), method: 'PUT', url: 'api/machine/backups/settings', body: settings,
      },
      {
        run: () => api.restoreMachineBackup(5, 3), response: () => json(200, { ok: true, restarting: true }), method: 'POST',
        url: 'api/machine/backups/5/restore', body: { machineId: 3 },
      },
    ];

    for (const [i, row] of rows.entries()) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(row.response()));
      await row.run();
      const sent = call(i);
      expect({ url: sent.url, method: sent.method }).toStrictEqual({ url: row.url, method: row.method });
      if (row.body === NO_BODY) {
        expect(sent.body).toBeUndefined();
        expect(sent.headers['content-type']).toBeUndefined();
      } else {
        expect(sent.body).toStrictEqual(row.body);
        expect(sent.headers['content-type']).toBe('application/json');
      }
      if (row.method === 'GET') {
        expect(sent.headers['x-glp-client']).toBeUndefined();
      } else {
        expect(typeof sent.headers['x-glp-client']).toBe('string');
      }
    }
  });

  it('returns the parsed value on success', async () => {
    const detail: MachineBackupDetail = { ...entry, document: { format: 'gaggiuino-settings', version: 1 } };

    fetchMock.mockImplementationOnce(() => Promise.resolve(json(200, [entry])));
    expect(await api.listMachineBackups(3)).toStrictEqual({ ok: true, value: [entry] });

    fetchMock.mockImplementationOnce(() => Promise.resolve(json(200, [])));
    expect(await api.listMachineBackups(null)).toStrictEqual({ ok: true, value: [] });

    fetchMock.mockImplementationOnce(() => Promise.resolve(json(200, detail)));
    expect(await api.getMachineBackup(5)).toStrictEqual({ ok: true, value: detail });

    fetchMock.mockImplementationOnce(() => Promise.resolve(json(200, { ok: true, restarting: true })));
    expect(await api.restoreMachineBackup(5, 3)).toStrictEqual({ ok: true, value: { ok: true, restarting: true } });
  });

  it('encodes ids into one path segment', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, [])));

    await api.getMachineBackup('../1?x=' as unknown as number);
    expect(call(0).url).toBe('api/machine/backups/..%2F1%3Fx%3D');

    await api.listMachineBackups('1&machineId=2' as unknown as number);
    expect(call(1).url).toBe('api/machine/backups?machineId=1%26machineId%3D2');

    await api.restoreMachineBackup('../9' as unknown as number, 3);
    expect(call(2).url).toBe('api/machine/backups/..%2F9/restore');
  });
});

describe('restore errors are typed', () => {
  it('keeps only documented codes, reasons and a bounded machineError', async () => {
    const cases: { readonly status: number; readonly body: unknown; readonly expected: MachineBackupFailure }[] = [
      { status: 409, body: { error: SERVER_TEXT, code: 'machine_busy', reason: 'brew' }, expected: { ok: false, status: 409, code: 'machine_busy', reason: 'brew', machineError: null } },
      { status: 409, body: { error: SERVER_TEXT, code: 'machine_busy', reason: 'steam' }, expected: { ok: false, status: 409, code: 'machine_busy', reason: 'steam', machineError: null } },
      { status: 409, body: { error: SERVER_TEXT, code: 'machine_busy', reason: 'descale' }, expected: { ok: false, status: 409, code: 'machine_busy', reason: 'descale', machineError: null } },
      { status: 409, body: { error: SERVER_TEXT, code: 'machine_busy', reason: 'firmware_update' }, expected: { ok: false, status: 409, code: 'machine_busy', reason: 'firmware_update', machineError: null } },
      { status: 409, body: { error: SERVER_TEXT, code: 'pending_profile_changes' }, expected: { ok: false, status: 409, code: 'pending_profile_changes', reason: null, machineError: null } },
      { status: 409, body: { error: SERVER_TEXT, code: 'operation_running' }, expected: { ok: false, status: 409, code: 'operation_running', reason: null, machineError: null } },
      { status: 409, body: { error: SERVER_TEXT, code: 'invalid_backup' }, expected: { ok: false, status: 409, code: 'invalid_backup', reason: null, machineError: null } },
      { status: 500, body: { error: SERVER_TEXT, code: 'pre_restore_backup_failed' }, expected: { ok: false, status: 500, code: 'pre_restore_backup_failed', reason: null, machineError: null } },
      { status: 502, body: { error: SERVER_TEXT, code: 'invalid_backup' }, expected: { ok: false, status: 502, code: 'invalid_backup', reason: null, machineError: null } },
      { status: 502, body: { error: SERVER_TEXT, code: 'machine_unreachable' }, expected: { ok: false, status: 502, code: 'machine_unreachable', reason: null, machineError: null } },
      { status: 502, body: { error: SERVER_TEXT, code: 'no_confirmation' }, expected: { ok: false, status: 502, code: 'no_confirmation', reason: null, machineError: null } },
      { status: 501, body: { error: SERVER_TEXT, code: 'unsupported_machine' }, expected: { ok: false, status: 501, code: 'unsupported_machine', reason: null, machineError: null } },
      { status: 501, body: { error: SERVER_TEXT, code: 'unsupported_firmware' }, expected: { ok: false, status: 501, code: 'unsupported_firmware', reason: null, machineError: null } },
      {
        status: 502, body: { error: SERVER_TEXT, code: 'restore_rejected', machineError: 'Invalid backup' },
        expected: { ok: false, status: 502, code: 'restore_rejected', reason: null, machineError: 'Invalid backup' },
      },
      {
        status: 502, body: { error: SERVER_TEXT, code: 'restore_rejected', machineError: 'x'.repeat(300) },
        expected: { ok: false, status: 502, code: 'restore_rejected', reason: null, machineError: 'x'.repeat(200) },
      },
    ];

    for (const row of cases) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(json(row.status, row.body)));
      const result = await api.restoreMachineBackup(5, 3);
      expect(result).toStrictEqual(row.expected);
      expect(JSON.stringify(result)).not.toContain(SERVER_TEXT);
    }
  });
});

interface FailureRow {
  readonly response: () => Response;
  readonly run: () => Promise<unknown>;
  readonly expected: MachineBackupFailure;
}

describe('anything else falls through to a generic failure', () => {
  it('maps undocumented bodies, prototypes and malformed answers to code null', async () => {
    const rows: FailureRow[] = [
      { response: () => page(502, '<html><body>502 Bad Gateway</body></html>'), run: () => api.restoreMachineBackup(5, 3), expected: generic(502) },
      { response: () => page(502, '<html><body>502 Bad Gateway</body></html>'), run: () => api.listMachineBackups(3), expected: generic(502) },
      { response: () => page(502, '<html><body>502 Bad Gateway</body></html>'), run: () => api.backUpMachineNow(3), expected: generic(502) },
      { response: () => page(502, '<html><body>502 Bad Gateway</body></html>'), run: () => api.downloadMachineBackup(5), expected: generic(502) },
      { response: () => json(404, { error: 'Backup not found' }), run: () => api.deleteMachineBackup(5), expected: generic(404) },
      { response: () => json(429, { error: 'Rate limit exceeded' }), run: () => api.listMachineBackups(null), expected: generic(429) },
      { response: () => new Response(null, { status: 413 }), run: () => api.uploadMachineBackup(3, {}), expected: generic(413) },
      { response: () => json(409, { error: 'x', code: 'reboot_now' }), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      { response: () => json(409, { error: 'x', code: 5 }), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      { response: () => json(409, null), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      { response: () => json(409, []), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      { response: () => raw(409, '{"error":"x","code":"toString"}'), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      { response: () => raw(409, '{"error":"x","code":"constructor"}'), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      { response: () => raw(409, '{"error":"x","code":"__proto__"}'), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      { response: () => raw(409, '{"__proto__":{"code":"machine_busy"}}'), run: () => api.restoreMachineBackup(5, 3), expected: generic(409) },
      {
        response: () => json(409, { error: 'x', code: 'machine_busy', reason: 'nap' }), run: () => api.restoreMachineBackup(5, 3),
        expected: { ok: false, status: 409, code: 'machine_busy', reason: null, machineError: null },
      },
      {
        response: () => json(409, { error: 'x', code: 'pending_profile_changes', reason: 'brew', machineError: 'x' }),
        run: () => api.restoreMachineBackup(5, 3),
        expected: { ok: false, status: 409, code: 'pending_profile_changes', reason: null, machineError: null },
      },
      {
        response: () => json(502, { error: 'x', code: 'restore_rejected', machineError: 5 }), run: () => api.restoreMachineBackup(5, 3),
        expected: { ok: false, status: 502, code: 'restore_rejected', reason: null, machineError: null },
      },
      { response: () => page(200, '<html>'), run: () => api.getMachineBackup(5), expected: generic(200) },
      { response: () => json(200, {}), run: () => api.listMachineBackups(3), expected: generic(200) },
      { response: () => json(200, []), run: () => api.getMachineBackupSettings(3), expected: generic(200) },
    ];

    for (const row of rows) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(row.response()));
      await expect(row.run()).resolves.toStrictEqual(row.expected);
    }
  });

  it('reports an unreachable GLP as status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.restoreMachineBackup(5, 3)).resolves.toStrictEqual(generic(0));

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.downloadMachineBackup(5)).resolves.toStrictEqual(generic(0));
  });
});

describe('download', () => {
  const BODY = '{"format":"gaggiuino-settings"}';

  function answer(secrets: string | undefined, disposition: string | undefined): Response {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secrets !== undefined) headers['X-GLP-Secrets'] = secrets;
    if (disposition !== undefined) headers['Content-Disposition'] = disposition;
    return new Response(BODY, { status: 200, headers });
  }

  it('returns the Blob, the documented file name and the secrets flag', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(answer('merged', `attachment; filename="${GOOD_NAME}"`)));
    const result = await api.downloadMachineBackup(5);
    if (!result.ok) throw new Error('expected a download');
    expect(result.value.filename).toBe(GOOD_NAME);
    expect(result.value.secrets).toBe('merged');
    expect(result.value.blob).toBeInstanceOf(Blob);
    expect(await result.value.blob.text()).toBe(BODY);
  });

  it('counts anything but the exact missing flag as merged', async () => {
    const rows: { readonly header: string | undefined; readonly expected: MachineBackupSecrets }[] = [
      { header: 'missing', expected: 'missing' },
      { header: undefined, expected: 'merged' },
      { header: 'MISSING', expected: 'merged' },
      { header: 'none', expected: 'merged' },
      { header: '', expected: 'merged' },
    ];
    for (const [i, row] of rows.entries()) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(answer(row.header, undefined)));
      const result = await api.downloadMachineBackup(5);
      if (!result.ok) throw new Error(`expected a download for row ${i}`);
      expect(result.value.secrets).toBe(row.expected);
    }
  });

  it('only keeps a file name of the documented form', async () => {
    const rows: { readonly header: string | undefined; readonly expected: string }[] = [
      { header: `attachment; filename="${GOOD_NAME}"`, expected: GOOD_NAME },
      { header: undefined, expected: DEFAULT_NAME },
      { header: 'attachment; filename="../../evil.json"', expected: DEFAULT_NAME },
      { header: `attachment; filename="${GOOD_NAME}.html"`, expected: DEFAULT_NAME },
      { header: `attachment; filename="${GOOD_NAME}"; filename*=UTF-8''evil.html`, expected: DEFAULT_NAME },
      { header: `inline; filename="${GOOD_NAME}"`, expected: DEFAULT_NAME },
      { header: 'attachment; filename="javascript:alert(1)"', expected: DEFAULT_NAME },
      { header: `attachment; filename=${GOOD_NAME}`, expected: DEFAULT_NAME },
    ];
    for (const [i, row] of rows.entries()) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(answer('merged', row.header)));
      const result = await api.downloadMachineBackup(5);
      if (!result.ok) throw new Error(`expected a download for row ${i}`);
      expect(result.value.filename).toBe(row.expected);
    }
  });

  it('returns typed failures instead of a file', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(json(409, { error: 'x', code: 'operation_running' })));
    expect(await api.downloadMachineBackup(5)).toStrictEqual({
      ok: false, status: 409, code: 'operation_running', reason: null, machineError: null,
    });

    fetchMock.mockImplementationOnce(() => Promise.resolve(json(409, { error: 'x', code: 'machine_busy' })));
    expect(await api.downloadMachineBackup(5)).toStrictEqual({
      ok: false, status: 409, code: 'machine_busy', reason: null, machineError: null,
    });
  });
});

describe('compare view input', () => {
  it('feeds the compare engine without a cast', async () => {
    const detail = (steamSetPoint: number): MachineBackupDetail => ({
      ...entry,
      document: { format: 'gaggiuino-settings', version: 1, settings: { boiler: { steamSetPoint } } },
    });

    fetchMock.mockImplementationOnce(() => Promise.resolve(json(200, detail(155))));
    fetchMock.mockImplementationOnce(() => Promise.resolve(json(200, detail(156))));
    const before = await api.getMachineBackup(5);
    const after = await api.getMachineBackup(6);
    if (!before.ok || !after.ok) throw new Error('expected two stored backups');

    expect(diffMachineBackups(before.value.document, after.value.document)).toStrictEqual([
      { kind: 'setting', path: ['boiler', 'steamSetPoint'], change: 'changed', from: 155, to: 156 },
    ]);
  });
});

describe('source guard', () => {
  it('stays a thin ingress-safe client', () => {
    const source = readFileSync(fileURLToPath(new URL('../public-src/api/machine-backups.ts', import.meta.url)), 'utf8');

    expect(source).not.toContain("'/api");
    expect(source).not.toContain('"/api');
    expect(source).not.toContain('`/api');
    expect(source).not.toMatch(/(?<![\w.])fetch\(/);
    expect(source).not.toMatch(/createObjectURL|location\.|window\.open|\.href\b/);

    const imports = [...source.matchAll(/^import\b[^;]*?from '([^']+)';/gms)].map((m) => m[1] ?? '');
    expect(imports).toStrictEqual(['./fetch.js', './types.js']);
  });
});
