#!/usr/bin/env node
// Local smoke test for the standalone Docker install path (#715/#764/#770).
// Builds the current working tree into an image and runs it through the
// real docker-compose.standalone.yml (via GLP_STANDALONE_* env overrides for
// image/port/data-dir, so it never collides with a real deployment), then
// verifies the env-var fallbacks (GLP_SYNC_INTERVAL, GLP_HA_URL+GLP_HA_TOKEN)
// took effect by grepping server.js's own startup log lines -- no server
// code changes needed to make this checkable from outside the container.
//
// Local-only (`npm run test:docker`), not wired into CI. Requires Docker
// with the `compose` plugin.

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

const IMAGE_TAG = 'glp-standalone-test:local';
const PROJECT   = 'glp-standalone-test';
const PORT      = 18099;
const STATUS_URL = `http://localhost:${PORT}/api/status`;

let dataDir;
let failed = false;

function log(msg) { console.log(`[docker-standalone-test] ${msg}`); }
function fail(msg) { failed = true; console.error(`[docker-standalone-test] FAIL: ${msg}`); }

function compose(args, env) {
    return spawnSync('docker', ['compose', '-f', 'docker-compose.standalone.yml', '-p', PROJECT, ...args], {
        cwd: packageRoot,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
}

async function waitForStatus(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(STATUS_URL);
            if (res.ok) return res.json();
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

function getLogs() {
    return compose(['logs', 'glp']).stdout || '';
}

function assertLogContains(logs, needle, label) {
    if (logs.includes(needle)) {
        log(`OK: ${label}`);
    } else {
        fail(`${label} -- expected log line containing "${needle}" not found`);
    }
}

function cleanup() {
    log('cleaning up...');
    compose(['down', '-v']);
    spawnSync('docker', ['rmi', '-f', IMAGE_TAG]);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
    log(`building ${IMAGE_TAG}...`);
    execFileSync('docker', ['build', '-t', IMAGE_TAG, '.'], { cwd: packageRoot, stdio: 'inherit' });

    dataDir = mkdtempSync(path.join(tmpdir(), 'glp-standalone-test-'));

    const baseEnv = {
        GLP_STANDALONE_IMAGE: IMAGE_TAG,
        GLP_STANDALONE_PORT: String(PORT),
        GLP_STANDALONE_DATA_DIR: dataDir,
        GLP_SYNC_INTERVAL: '7',
        GLP_ENABLE_ORDERS: 'true',
        GLP_DEBUG_LOGGING: 'true',
    };

    log('starting container via docker-compose.standalone.yml (no SUPERVISOR_TOKEN)...');
    const up = compose(['up', '-d'], baseEnv);
    if (up.status !== 0) throw new Error(`docker compose up failed: ${up.stderr}`);

    log(`polling ${STATUS_URL}...`);
    const status = await waitForStatus(20000);
    if (!status || typeof status.shotCount !== 'number') {
        fail(`/api/status did not respond with valid JSON within 20s (got: ${JSON.stringify(status)})`);
    } else {
        log('OK: /api/status responded');
    }

    let logs = getLogs();
    assertLogContains(logs, 'sync every 7 min', 'GLP_SYNC_INTERVAL fallback');
    assertLogContains(logs, 'HA integration: unavailable', 'HA integration unavailable without GLP_HA_URL/GLP_HA_TOKEN');

    log('restarting with GLP_HA_URL/GLP_HA_TOKEN set...');
    const up2 = compose(['up', '-d', '--force-recreate'], {
        ...baseEnv,
        GLP_HA_URL: 'http://198.51.100.1:8123',
        GLP_HA_TOKEN: 'dummy',
    });
    if (up2.status !== 0) throw new Error(`docker compose up (recreate) failed: ${up2.stderr}`);

    const status2 = await waitForStatus(20000);
    if (!status2) fail('/api/status did not respond after recreate within 20s');

    logs = getLogs();
    assertLogContains(logs, 'HA integration: active', 'HA integration active with GLP_HA_URL+GLP_HA_TOKEN paired');

    if (failed) {
        console.error('\n[docker-standalone-test] one or more checks failed, see FAIL lines above.');
        process.exitCode = 1;
    } else {
        log('all checks passed.');
    }
}

main()
    .catch(err => {
        console.error(`[docker-standalone-test] error: ${err.message}`);
        process.exitCode = 1;
    })
    .finally(cleanup);
