#!/usr/bin/env node
// Measures one running GLP instance for the perf-compare workflow (#1558).
//
// Times the endpoints the SPA leans on (shot list, a shot detail with its curve,
// the full /shots.json history the statistics page loads, library, maintenance,
// achievements and status) over repeated runs and records the frontend bundle
// size. The output is one flat metric per number:
//
//   { "meta": { baseUrl, ref, timestamp, runs },
//     "metrics": { "<name>": { "value": number,
//                              "unit": "ms" | "bytes" | "%",
//                              "better": "lower" | "higher" } } }
//
// The workflow merges its own container metrics (startup time, idle RSS/CPU,
// peak RSS, image size), measured outside Node, into `metrics` with jq using the
// same {value, unit, better} shape — that is why that shape is fixed here.
//
// Auth: the token comes from --token, else GLP_PERF_TOKEN, else GET /api/token,
// and is sent as x-glp-token on every request (including POST /api/restore).
// GET /api/token is refused when the app runs as a plain Docker container
// outside Home Assistant (expose_api_port), so the workflow passes a token.
//
// Works against any running GLP instance, including the released v3.4.0: only
// endpoints that already existed there are used.

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { restoreBackup } from './e2e-harness.mts';

type Unit = 'ms' | 'bytes' | '%';
type Direction = 'lower' | 'higher';

interface Metric {
    value: number;
    unit: Unit;
    better: Direction;
}

interface MeasureOutput {
    meta: { baseUrl: string; ref: string | null; timestamp: string; runs: number };
    metrics: Record<string, Metric>;
}

interface ShotsPage {
    shots?: { id?: number }[];
}

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([\w-]+)\s*=\s*"([^"]*)"/g;

function authHeaders(token: string): Record<string, string> {
    return { 'x-glp-token': token };
}

function argValue(argv: readonly string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index !== -1 ? argv[index + 1] : undefined;
}

function isMain(): boolean {
    const entry = process.argv[1];
    return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) return sorted[mid] ?? 0;
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// Nearest-rank percentile, matching how the workflow reads p95.
function percentile(values: readonly number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
    return sorted[index] ?? 0;
}

async function resolveToken(baseUrl: string, fromArg: string | undefined): Promise<string> {
    const provided = fromArg ?? process.env.GLP_PERF_TOKEN;
    if (provided !== undefined && provided !== '') return provided;
    const res = (await fetch(`${baseUrl}/api/token`).then((r) => r.json())) as { apiToken?: string };
    if (res.apiToken === undefined || res.apiToken === '') {
        throw new Error('GET /api/token returned no token; pass --token or GLP_PERF_TOKEN when the app runs as a plain container');
    }
    return res.apiToken;
}

async function fetchText(url: string, token: string): Promise<string> {
    const response = await fetch(url, { headers: authHeaders(token) });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    return text;
}

async function timeOnce(url: string, token: string): Promise<number> {
    const start = performance.now();
    const response = await fetch(url, { headers: authHeaders(token) });
    await response.arrayBuffer();
    const elapsed = performance.now() - start;
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    return elapsed;
}

async function measureEndpoint(url: string, token: string, runs: number, warmup: number): Promise<number[]> {
    for (let i = 0; i < warmup; i++) await timeOnce(url, token);
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) samples.push(await timeOnce(url, token));
    return samples;
}

function attribute(tag: string, name: string): string | undefined {
    ATTRIBUTE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTRIBUTE.exec(tag)) !== null) {
        if ((match[1] ?? '').toLowerCase() === name) return match[2];
    }
    return undefined;
}

// Absolute, same-origin URLs of every script / stylesheet / modulepreload the
// index HTML references, in first-seen order.
function collectAssets(html: string, root: string): string[] {
    const origin = new URL(root).origin;
    const found = new Set<string>();
    const add = (href: string | undefined): void => {
        if (href === undefined) return;
        let resolved: URL;
        try {
            resolved = new URL(href, root);
        } catch {
            return;
        }
        if (resolved.origin !== origin) return;
        found.add(resolved.toString());
    };

    for (const match of html.matchAll(SCRIPT_TAG)) add(attribute(match[0] ?? '', 'src'));
    for (const match of html.matchAll(LINK_TAG)) {
        const rel = (attribute(match[0] ?? '', 'rel') ?? '').toLowerCase().split(/\s+/);
        if (rel.includes('stylesheet') || rel.includes('modulepreload')) add(attribute(match[0] ?? '', 'href'));
    }
    return [...found];
}

function assetMetricName(url: string): string {
    const clean = new URL(url).pathname
        .replace(/^\/+/, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return `bundle.${clean}.bytes`;
}

async function measureBundle(root: string, token: string, metrics: Record<string, Metric>): Promise<void> {
    const html = await fetchText(`${root}/`, token);
    const assets = collectAssets(html, root);
    let total = 0;
    for (const asset of assets) {
        const response = await fetch(asset, { headers: authHeaders(token) });
        const body = await response.arrayBuffer();
        if (!response.ok) throw new Error(`GET ${asset} -> ${response.status}`);
        total += body.byteLength;
        metrics[assetMetricName(asset)] = { value: body.byteLength, unit: 'bytes', better: 'lower' };
    }
    metrics['bundle.total_bytes'] = { value: total, unit: 'bytes', better: 'lower' };
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const baseUrl = argValue(argv, '--base-url');
    const out = argValue(argv, '--out');
    if (baseUrl === undefined || out === undefined) {
        console.error('usage: node scripts/perf-measure.mts --base-url <url> --out <file.json> [--runs <n>] [--warmup <n>] [--ref <ref>] [--restore <zip>] [--token <value>]');
        process.exit(1);
    }
    const root = baseUrl.replace(/\/+$/, '');
    const runs = Number(argValue(argv, '--runs') ?? '30');
    const warmup = Number(argValue(argv, '--warmup') ?? '3');
    const ref = argValue(argv, '--ref');
    const restore = argValue(argv, '--restore');
    const token = await resolveToken(root, argValue(argv, '--token'));

    if (restore !== undefined) {
        const result = await restoreBackup(root, restore, token);
        console.log(`restored ${basename(restore)}: ${JSON.stringify(result)}`);
    }

    const page = JSON.parse(await fetchText(`${root}/api/shots`, token)) as ShotsPage;
    const newest = page.shots?.[0]?.id;
    if (newest === undefined) throw new Error('no shots available to measure; restore a dataset first');

    const endpoints: { name: string; url: string }[] = [
        { name: 'shots_list', url: `${root}/api/shots` },
        { name: 'shot_detail', url: `${root}/api/shots/${newest}` },
        { name: 'shots_json', url: `${root}/shots.json` },
        { name: 'library', url: `${root}/api/library` },
        { name: 'maintenance', url: `${root}/api/maintenance` },
        { name: 'achievements', url: `${root}/api/achievements` },
        { name: 'status', url: `${root}/api/status` },
    ];

    const metrics: Record<string, Metric> = {};
    for (const endpoint of endpoints) {
        const samples = await measureEndpoint(endpoint.url, token, runs, warmup);
        metrics[`api.${endpoint.name}.median_ms`] = { value: round3(median(samples)), unit: 'ms', better: 'lower' };
        metrics[`api.${endpoint.name}.p95_ms`] = { value: round3(percentile(samples, 0.95)), unit: 'ms', better: 'lower' };
        console.log(`${endpoint.name}: median ${round3(median(samples))} ms, p95 ${round3(percentile(samples, 0.95))} ms`);
    }

    await measureBundle(root, token, metrics);

    const output: MeasureOutput = {
        meta: { baseUrl: root, ref: ref ?? null, timestamp: new Date().toISOString(), runs },
        metrics,
    };
    writeFileSync(out, JSON.stringify(output, null, 2) + '\n');
    console.log(`wrote ${out}: ${Object.keys(metrics).length} metrics`);
}

if (isMain()) {
    void main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
