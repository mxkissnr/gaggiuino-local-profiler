#!/usr/bin/env node
// perf-compare: read two perf-measure JSON files and print a Markdown table
// (Metric | Base | Head | Change (%)). Part of the perf-compare workflow
// (#1558); see CONTRIBUTING.md's "Performance comparison".
//
// A row whose change is worse than --threshold percent (default 15) in the
// metric's `better` direction is marked `review`. A metric present in only one
// file is a row with "n/a". The command always exits 0 — a regression is a
// review item for the release acceptance pass, never a failing gate.
//
// compareMetrics / formatReport are pure and exported for
// test/perf-compare.test.ts; the CLI only reads two files.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Metric {
    value: number;
    unit: string;
    better: 'lower' | 'higher';
}

export interface MeasureFile {
    meta?: unknown;
    metrics?: Record<string, Metric>;
}

export interface ComparisonRow {
    metric: string;
    base: number | null;
    head: number | null;
    unit: string;
    changePct: number | null;
    review: boolean;
}

export function compareMetrics(
    base: Readonly<Record<string, Metric>>,
    head: Readonly<Record<string, Metric>>,
    thresholdPct: number,
): ComparisonRow[] {
    const names = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
    return names.map((metric): ComparisonRow => {
        const baseMetric = base[metric];
        const headMetric = head[metric];
        const unit = headMetric?.unit ?? baseMetric?.unit ?? '';
        if (!baseMetric || !headMetric) {
            return {
                metric,
                base: baseMetric?.value ?? null,
                head: headMetric?.value ?? null,
                unit,
                changePct: null,
                review: false,
            };
        }
        // Signed percent change; a zero base has no meaningful percentage.
        const changePct = baseMetric.value === 0 ? null : ((headMetric.value - baseMetric.value) / baseMetric.value) * 100;
        const better = headMetric.better ?? 'lower';
        const worseBy = better === 'higher' ? -(changePct ?? 0) : (changePct ?? 0);
        return {
            metric,
            base: baseMetric.value,
            head: headMetric.value,
            unit,
            changePct,
            review: changePct !== null && worseBy > thresholdPct,
        };
    });
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

export function formatReport(rows: readonly ComparisonRow[]): string {
    const lines = ['| Metric | Base | Head | Change (%) |', '|---|---|---|---|'];
    for (const row of rows) {
        const base = row.base === null ? 'n/a' : formatNumber(row.base);
        const head = row.head === null ? 'n/a' : formatNumber(row.head);
        const change = row.changePct === null ? 'n/a' : `${row.changePct >= 0 ? '+' : ''}${row.changePct.toFixed(1)}%`;
        const marker = row.review ? ' `review`' : '';
        lines.push(`| ${row.metric} | ${base} | ${head} | ${change}${marker} |`);
    }
    return lines.join('\n') + '\n';
}

function argValue(argv: readonly string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index !== -1 ? argv[index + 1] : undefined;
}

function isMain(): boolean {
    const entry = process.argv[1];
    return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
    const argv = process.argv.slice(2);
    const positional = argv.filter((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--threshold');
    const basePath = positional[0];
    const headPath = positional[1];
    if (basePath === undefined || headPath === undefined) {
        console.error('usage: node scripts/perf-compare.mts <base.json> <head.json> [--threshold <pct>]');
        process.exit(1);
    }
    const threshold = Number(argValue(argv, '--threshold') ?? '15');
    const base = JSON.parse(readFileSync(basePath, 'utf8')) as MeasureFile;
    const head = JSON.parse(readFileSync(headPath, 'utf8')) as MeasureFile;
    process.stdout.write(formatReport(compareMetrics(base.metrics ?? {}, head.metrics ?? {}, threshold)));
}
