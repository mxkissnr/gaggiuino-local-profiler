// #1619: static form fields in index.html must be announced by a screen
// reader. A visual <label> next to a field is not enough — it has to be
// associated through `for`/`id`, wrap the control, or the control needs an
// explicit aria-label/aria-labelledby. This pins that invariant so a new
// unlabeled input cannot slip back in.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

function parseAttrs(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g)) {
        attrs[m[1].toLowerCase()] = m[2];
    }
    return attrs;
}

const controlRe = /<(input|select|textarea)\b[^>]*>/gi;
const labelRe = /<label\b[^>]*>[\s\S]*?<\/label>/gi;

const labels = [...html.matchAll(labelRe)].map(m => ({
    start: m.index!,
    end: m.index! + m[0].length,
    attrs: parseAttrs(m[0]),
}));
const forIds = new Set(labels.map(l => l.attrs.for).filter(Boolean));

function insideLabel(index: number): boolean {
    return labels.some(l => index >= l.start && index < l.end);
}

describe('index.html: every form field has an accessible name (#1619)', () => {
    it('has labels and form fields to check', () => {
        expect(labels.length).toBeGreaterThan(0);
        expect([...html.matchAll(controlRe)].length).toBeGreaterThan(0);
    });

    it('every input, select and textarea (except type=hidden) is labelled', () => {
        const unlabelled: string[] = [];
        for (const m of html.matchAll(controlRe)) {
            const attrs = parseAttrs(m[0]);
            if (attrs.type?.toLowerCase() === 'hidden') continue;
            const hasAria = Boolean(attrs['aria-label']?.trim() || attrs['aria-labelledby']?.trim());
            const hasFor = Boolean(attrs.id && forIds.has(attrs.id));
            if (!hasAria && !hasFor && !insideLabel(m.index!)) {
                unlabelled.push(`${m[1].toLowerCase()}#${attrs.id ?? '(no id)'}`);
            }
        }
        expect(unlabelled).toEqual([]);
    });

    it('every label points at an existing control id', () => {
        const ids = new Set(
            [...html.matchAll(controlRe)]
                .map(m => parseAttrs(m[0]).id)
                .filter(Boolean),
        );
        const dangling = [...forIds].filter(id => !ids.has(id));
        expect(dangling).toEqual([]);
    });
});
