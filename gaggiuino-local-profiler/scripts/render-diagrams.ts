// Renders docs/diagrams/*.mmd to light/dark SVGs through the public
// mermaid.ink service, so the README can embed images the GitHub mobile app
// can actually render (it does not render Mermaid source). Run it after
// editing any .mmd file: npm run diagrams:render
//
// The rendered SVGs carry a source-sha256 comment, checked by
// test/diagrams-fresh.test.ts, so a stale SVG fails the suite.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const diagramsDir = path.join(__dirname, '..', '..', 'docs', 'diagrams');

// Markers that only appear with HTML labels or leftover HTML padding; a
// native SVG viewer like the GitHub mobile app renders none of them.
const HTML_MARKERS: readonly string[] = ['<foreignObject>', '&amp;nbsp;', '&lt;b&gt;'];

function prepare(text: string): string {
  // mermaid.ink renders HTML labels poorly: drop the HTML the README used for
  // width padding, then tidy the whitespace it leaves inside labels.
  return text
    .replace(/<\/?b>/g, '')
    .replace(/&nbsp;/g, '')
    .replace(/(["'])\s+/g, '$1')
    .replace(/\s+(["'])/g, '$1')
    .replace(/\s*<br\/>\s*/g, '<br/>');
}

function encodePayload(code: string, theme: string): string {
  const body = {
    code,
    mermaid: {
      theme,
      // htmlLabels must stay at the top level: it is ignored under flowchart.
      htmlLabels: false,
      markdownAutoWrap: false,
      flowchart: { wrappingWidth: 400 },
    },
  };
  return 'pako:' + deflateSync(JSON.stringify(body)).toString('base64url');
}

async function render(
  name: string,
  text: string,
  sha: string,
  theme: string,
  bg: string,
): Promise<string> {
  const url = `https://mermaid.ink/svg/${encodePayload(prepare(text), theme)}?bgColor=${bg}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mermaid.ink returned ${res.status} for ${name} (${theme})`);
  const svg = await res.text();
  const marker = HTML_MARKERS.find((m) => svg.includes(m));
  if (marker) throw new Error(`${name} (${theme}) still contains ${marker}`);
  return svg.replace(/<svg\b[^>]*>/, (tag) => `${tag}\n<!-- source-sha256: ${sha} -->`);
}

const variants: ReadonlyArray<readonly [string, string, string]> = [
  ['default', 'ffffff', ''],
  ['dark', '0d1117', '-dark'],
];

const files: string[] = readdirSync(diagramsDir).filter((f: string) => f.endsWith('.mmd'));
if (files.length === 0) throw new Error(`no .mmd files found in ${diagramsDir}`);

for (const file of files) {
  const filePath = path.join(diagramsDir, file);
  const bytes = readFileSync(filePath);
  const text = bytes.toString('utf8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const name = file.slice(0, -'.mmd'.length);
  for (const [theme, bg, suffix] of variants) {
    const out = path.join(diagramsDir, `${name}${suffix}.svg`);
    writeFileSync(out, await render(name, text, sha, theme, bg));
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
}
