// Shared E2E harness: builds and boots a throwaway instance of the real
// Go backend (`glp-server`) against its own tmp data dir, image dir and
// port — never touches /data or 8099 — seeds the built-in demo dataset plus a second
// machine so Library / Analytics / the multi-machine switcher aren't empty,
// and exposes the resulting baseUrl. Used by both scripts/screenshots.mts
// (README/wiki screenshots) and test/e2e/smoke.test.mts (Playwright smoke
// test, #798).
//
// The Node backend this used to boot in-process was removed in 3.0.0
// (#1028); the harness now compiles cmd/server from go/ with the SPA built
// into the //go:embed dist tree by go/cmd/frontend-build (esbuild's Go API,
// #1033) — the same command go/Makefile's `frontend` target and the
// Dockerfile's builder stage run. No npm step is needed by callers.
//
// Requires `npx playwright install chromium` once beforehand for consumers
// that drive Chromium (this module itself never touches Playwright).

import { spawn, execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.join(__dirname, '..');
const goDir       = path.join(appRoot, 'go');
const distDir     = path.join(goDir, 'internal', 'webapp', 'dist');

export const PORT = 8199;

// Throwaway data dir — the Go server writes its SQLite DB and token file
// here via GLP_DB_PATH / GLP_TOKEN_FILE, never into the real /data.
export const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'glp-e2e-'));

// Throwaway image dir — the Go server reads and writes every entity photo
// here via GLP_IMAGE_DIR, never into the real /data/bean-images.
export const tmpImageDir = path.join(tmpDataDir, 'bean-images');

let serverProc: ChildProcess | null = null;

interface RestoreResult {
    ok: boolean;
    images: number;
    shots?: number;
}

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

// Builds glp-server with the real SPA embedded. The bundle itself is
// produced by go/cmd/frontend-build (esbuild's Go API, #1033), which owns
// the git-ignored dist tree and wipes it first; the committed placeholder
// index.html is restored afterwards so the working tree is left clean.
function buildServerBinary(): string {
    const placeholderIndex = readFileSync(path.join(distDir, 'index.html'));
    const binPath = path.join(tmpDataDir, 'glp-server');

    try {
        // Frontend bundle → internal/webapp/dist (the //go:embed tree), then
        // the server binary that embeds it.
        execFileSync('go', ['run', './cmd/frontend-build'], { cwd: goDir, stdio: 'inherit' });

        execFileSync('go', ['build', '-o', binPath, './cmd/server'], { cwd: goDir, stdio: 'inherit' });
    } finally {
        // Always restore the committed placeholder so a failed build never
        // leaves the full SPA staged in the git-ignored-except-index.html
        // dist tree (which would dirty the tree and poison a bare go build).
        rmSync(distDir, { recursive: true, force: true });
        mkdirSync(distDir, { recursive: true });
        writeFileSync(path.join(distDir, 'index.html'), placeholderIndex);
    }

    return binPath;
}

// Boots the built glp-server against tmpDataDir/PORT and waits for it to
// answer. GLP_ENABLE_ORDERS=true because options.json (the normal source
// of enable_orders) never exists in this throwaway environment and the
// server falls back to this env var — gives the Orders view something to
// show instead of the tab not existing at all.
export async function bootServer(): Promise<string> {
    mkdirSync(tmpDataDir, { recursive: true });
    mkdirSync(tmpImageDir, { recursive: true });
    const binPath = buildServerBinary();

    serverProc = spawn(binPath, [], {
        cwd: tmpDataDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            GLP_PORT: String(PORT),
            GLP_DB_PATH: path.join(tmpDataDir, 'glp.db'),
            GLP_TOKEN_FILE: path.join(tmpDataDir, 'api_token.txt'),
            GLP_IMAGE_DIR: tmpImageDir,
            GLP_ENABLE_ORDERS: 'true',
        },
    });
    serverProc.on('exit', (code, signal) => {
        if (code && code !== 0) console.error(`glp-server exited with code ${code} (signal ${String(signal)})`);
    });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    await waitForServer(`${baseUrl}/api/status`);
    return baseUrl;
}

export function stopServer(): void {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
    serverProc = null;
}

// Seeds the backend's built-in demo dataset (12 shots across 3 beans + a
// recipe — see go/internal/system/demo.go) and adds a second machine so
// the multi-machine switcher, per-machine analytics and the Settings
// machine list have more than the single default row to render.
export async function seed(baseUrl: string): Promise<{ machine2: unknown }> {
    const { apiToken } = (await fetch(`${baseUrl}/api/token`).then(r => r.json())) as { apiToken: string };
    const post = (p: string, body?: unknown): Promise<unknown> => fetch(`${baseUrl}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-glp-token': apiToken },
        body: body === undefined ? null : JSON.stringify(body),
    }).then(async r => {
        const text = await r.text();
        if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${text}`);
        return text ? (JSON.parse(text) as unknown) : {};
    });

    await post('/api/demo/seed');

    // A bare private-LAN IP literal — not a real reachable device — so host
    // validation short-circuits on net.isIP() instead of a DNS lookup.
    const machine2 = await post('/api/machines', { name: 'GaggiMate Sim', type: 'gaggimate', host: '192.168.1.50' });

    return { machine2 };
}

// Restores a GLP backup zip into the throwaway instance through the app's own
// POST /api/restore endpoint (#1181), in place of seed(). screenshots.mts
// calls this only when GLP_SCREENSHOT_BACKUP is set. The zip is sent raw with
// Content-Type: application/zip; GLP_SCREENSHOT_BACKUP_PASSPHRASE supplies the
// passphrase for an encrypted backup. Real backups sit well under the
// endpoint's 50 MB body cap. Any non-2xx, non-JSON or `ok !== true` response
// throws, so a failed restore aborts the caller instead of screenshotting an
// un-restored instance. The restored token is written to disk but the running
// process keeps the one it started with (see go/internal/backup/doc.go), so
// fetching the token before the restore is fine.
//
// `token` lets a caller that already holds a token (perf-measure.mts's --token /
// GLP_PERF_TOKEN) skip GET /api/token, which is refused when the app runs as a
// plain Docker container outside Home Assistant. Absent, the token is fetched
// from the already-public GET /api/token as before.
export async function restoreBackup(baseUrl: string, zipPath: string, token?: string): Promise<RestoreResult> {
    let zip: Buffer;
    try {
        zip = readFileSync(zipPath);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot read GLP_SCREENSHOT_BACKUP file ${zipPath}: ${message}`, { cause: err });
    }

    // Same auth the SPA and seed() use, sent back as the x-glp-token header.
    let apiToken = token;
    if (apiToken === undefined) {
        const res = (await fetch(`${baseUrl}/api/token`).then(r => r.json())) as { apiToken?: string };
        apiToken = res.apiToken ?? '';
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/zip', 'x-glp-token': apiToken };
    if (process.env.GLP_SCREENSHOT_BACKUP_PASSPHRASE) {
        headers['X-GLP-Passphrase'] = process.env.GLP_SCREENSHOT_BACKUP_PASSPHRASE;
    }

    const r = await fetch(`${baseUrl}/api/restore`, { method: 'POST', headers, body: zip });
    const text = await r.text();
    if (!r.ok) throw new Error(`POST /api/restore -> ${r.status}: ${text}`);

    let parsed: RestoreResult;
    try {
        parsed = text ? (JSON.parse(text) as RestoreResult) : { ok: false, images: 0 };
    } catch {
        throw new Error(`POST /api/restore -> ${r.status}: invalid JSON: ${text}`);
    }
    if (parsed.ok !== true) throw new Error(`POST /api/restore -> ${r.status}: ${text}`);

    // parsed.images is how many images the restore queued to write. If it
    // queued any, the server must have written them under GLP_IMAGE_DIR: a
    // silently skipped MkdirAll (the /data permission failure this harness
    // used to hit) would otherwise leave the DB rows pointing at files that
    // 404, producing blank-photo screenshots with no error at all. Fail
    // loudly instead.
    if (parsed.images > 0) {
        const files = readdirSync(tmpImageDir);
        const written = files.filter(f => !f.includes('.thumb.')).length;
        if (written < parsed.images) {
            throw new Error(`POST /api/restore reported ${parsed.images} image(s) but only ${written} were written to ${tmpImageDir}`);
        }
    }
    return parsed;
}
