// Shared E2E harness: builds and boots a throwaway instance of the real
// Go backend (`glp-server`) against its own tmp data dir and port — never
// touches /data or 8099 — seeds the built-in demo dataset plus a second
// machine so Library / Analytics / the multi-machine switcher aren't empty,
// and exposes the resulting baseUrl. Used by both scripts/screenshots.mjs
// (README/wiki screenshots) and test/e2e/smoke.test.mjs (Playwright smoke
// test, #798).
//
// The Node backend this used to boot in-process was removed in 3.0.0
// (#1028); the harness now compiles cmd/server from go/ with the freshly
// built Vite SPA staged into the //go:embed dist tree, exactly the way
// go/Makefile's `frontend` target and the Dockerfile's frontend stage do.
// Callers must run `npm run build` first so gaggiuino-local-profiler/public
// exists.
//
// Requires `npx playwright install chromium` once beforehand for consumers
// that drive Chromium (this module itself never touches Playwright).

import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, cpSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.join(__dirname, '..');
const goDir       = path.join(appRoot, 'go');
const distDir     = path.join(goDir, 'internal', 'webapp', 'dist');
const templatesDir = path.join(goDir, 'internal', 'web', 'templates');
// Pinned to the version go/go.mod already requires — keep in lockstep.
const TEMPL_VERSION = 'v0.3.1020';

export const PORT = 8199;

// Throwaway data dir — the Go server writes its SQLite DB and token file
// here via GLP_DB_PATH / GLP_TOKEN_FILE, never into the real /data.
export const tmpDataDir = mkdtempSync(path.join(tmpdir(), 'glp-e2e-'));

let serverProc = null;

async function waitForServer(url, timeoutMs = 30000) {
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

// Builds glp-server with the real SPA embedded. Stages public/ into the
// git-ignored dist tree, restores the committed placeholder index.html
// afterwards so the working tree is left clean.
function buildServerBinary() {
    const publicDir = path.join(appRoot, 'public');
    if (!existsSync(path.join(publicDir, 'index.html'))) {
        throw new Error(`${publicDir}/index.html is missing — run \`npm run build\` before the E2E harness`);
    }

    const placeholderIndex = readFileSync(path.join(distDir, 'index.html'));
    const binPath = path.join(tmpDataDir, 'glp-server');

    try {
        rmSync(distDir, { recursive: true, force: true });
        mkdirSync(distDir, { recursive: true });
        cpSync(publicDir, distDir, { recursive: true });

        // templ generate — internal/web/templates' .templ sources aren't
        // valid Go until this runs (git-ignored _templ.go output). `go run`
        // the pinned CLI so this works with no global install.
        execFileSync('go', ['run', `github.com/a-h/templ/cmd/templ@${TEMPL_VERSION}`, 'generate'],
            { cwd: templatesDir, stdio: 'inherit' });

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
export async function bootServer() {
    mkdirSync(tmpDataDir, { recursive: true });
    const binPath = buildServerBinary();

    serverProc = spawn(binPath, [], {
        cwd: tmpDataDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            GLP_PORT: String(PORT),
            GLP_DB_PATH: path.join(tmpDataDir, 'glp.db'),
            GLP_TOKEN_FILE: path.join(tmpDataDir, 'api_token.txt'),
            GLP_ENABLE_ORDERS: 'true',
        },
    });
    serverProc.on('exit', (code, signal) => {
        if (code && code !== 0) console.error(`glp-server exited with code ${code} (signal ${signal})`);
    });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    await waitForServer(`${baseUrl}/api/status`);
    return baseUrl;
}

export function stopServer() {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
    serverProc = null;
}

// Seeds the backend's built-in demo dataset (12 shots across 3 beans + a
// recipe — see go/internal/system/demo.go) and adds a second machine so
// the multi-machine switcher, per-machine analytics and the Settings
// machine list have more than the single default row to render.
export async function seed(baseUrl) {
    const { apiToken } = await fetch(`${baseUrl}/api/token`).then(r => r.json());
    const post = (p, body) => fetch(`${baseUrl}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-glp-token': apiToken },
        body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async r => {
        const text = await r.text();
        if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${text}`);
        return text ? JSON.parse(text) : {};
    });

    await post('/api/demo/seed');

    // A bare private-LAN IP literal — not a real reachable device — so host
    // validation short-circuits on net.isIP() instead of a DNS lookup.
    const machine2 = await post('/api/machines', { name: 'GaggiMate Sim', type: 'gaggimate', host: '192.168.1.50' });

    return { machine2 };
}
