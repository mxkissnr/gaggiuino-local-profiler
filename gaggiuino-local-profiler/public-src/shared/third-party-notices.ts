// #2080: parses the shipped notices file for the settings sheet. The format is
// documented in THIRD_PARTY_NOTICES.md itself and guarded by the notices tests.

export const NOTICE_GROUPS = ['Libraries', 'Fonts', 'Models', 'Server'] as const;
export type NoticeGroup = typeof NOTICE_GROUPS[number];

export interface NoticeComponent {
    group: NoticeGroup;
    /** The ### heading verbatim: name and version, e.g. "echarts 6.1.0". */
    title: string;
    /** First sentence of the purpose paragraph. */
    purpose: string;
    /** Licence name(s) from "Licensed under the …", without the trailing note in brackets. */
    licence: string;
    /** First URL of the Source/Sources bullet. */
    source: string;
}

export interface NoticeLicence {
    /** Heading text before " — ", e.g. "MIT License". */
    name: string;
    /** Heading text after " — ". */
    covers: string;
    /** Full text, inner blank lines kept, leading/trailing blank lines dropped. */
    text: string;
}

export interface ParsedNotices {
    components: NoticeComponent[];
    licences: NoticeLicence[];
}

const LICENCE_SECTION = 'Full licence texts';
const LICENCE_DASH = ' — ';
const LICENSED_PREFIX = 'Licensed under ';
const ARTICLE = 'the ';
const SOURCE_PREFIXES = ['Source: ', 'Sources: '];
const URL = /https:\/\/\S+/;

function isNoticeGroup(section: string): section is NoticeGroup {
    return (NOTICE_GROUPS as readonly string[]).includes(section);
}

function isBlank(line: string): boolean {
    return line.trim() === '';
}

function firstSentence(text: string): string {
    for (let i = 0; i < text.length; i += 1) {
        if (text.charAt(i) !== '.') continue;
        const next = text.charAt(i + 1);
        if (next === '' || /\s/.test(next)) return text.slice(0, i + 1);
    }
    return text;
}

// The file is hard-wrapped: a continuation line is indented by two spaces and
// belongs to the bullet or paragraph above it.
function joinWrapped(lines: string[]): string {
    return lines.map((line) => line.trim()).join(' ');
}

function bulletsOf(lines: string[]): string[] {
    const bullets: string[] = [];
    for (const line of lines) {
        if (line.startsWith('- ')) {
            bullets.push(line.slice(2).trim());
        } else if (line.startsWith('  ') && bullets.length > 0) {
            const last = bullets.length - 1;
            bullets[last] = `${bullets[last] ?? ''} ${line.trim()}`;
        }
    }
    return bullets;
}

function purposeOf(lines: string[]): string {
    const paragraph: string[] = [];
    for (const line of lines) {
        if (line.startsWith('- ')) break;
        if (isBlank(line)) {
            if (paragraph.length > 0) break;
            continue;
        }
        paragraph.push(line);
    }
    return paragraph.length === 0 ? '' : firstSentence(joinWrapped(paragraph));
}

function licenceOf(bullets: string[]): string {
    for (const bullet of bullets) {
        if (!bullet.startsWith(LICENSED_PREFIX)) continue;
        let rest = bullet.slice(LICENSED_PREFIX.length).trim();
        if (rest.startsWith(ARTICLE)) rest = rest.slice(ARTICLE.length);
        if (rest.endsWith('.')) rest = rest.slice(0, -1);
        const note = rest.indexOf(' (');
        if (note !== -1) rest = rest.slice(0, note);
        return rest.trim();
    }
    return '';
}

function sourceOf(bullets: string[]): string {
    for (const bullet of bullets) {
        if (!SOURCE_PREFIXES.some((prefix) => bullet.startsWith(prefix))) continue;
        const url = URL.exec(bullet)?.[0];
        if (url !== undefined) return url;
    }
    return '';
}

function parseComponent(group: NoticeGroup, title: string, lines: string[]): NoticeComponent {
    const bullets = bulletsOf(lines);
    return {
        group,
        title,
        purpose: purposeOf(lines),
        licence: licenceOf(bullets),
        source: sourceOf(bullets),
    };
}

function parseLicence(title: string, lines: string[]): NoticeLicence {
    const dash = title.indexOf(LICENCE_DASH);
    let start = 0;
    let end = lines.length;
    while (start < end && isBlank(lines[start] ?? '')) start += 1;
    while (end > start && isBlank(lines[end - 1] ?? '')) end -= 1;
    return {
        name: dash === -1 ? title : title.slice(0, dash),
        covers: dash === -1 ? '' : title.slice(dash + LICENCE_DASH.length),
        text: lines.slice(start, end).join('\n'),
    };
}

export function parseNotices(md: string): ParsedNotices {
    const lines = md.split(/\r?\n/);
    const components: NoticeComponent[] = [];
    const licences: NoticeLicence[] = [];
    let section: string | null = null;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i] ?? '';
        if (line.startsWith('## ')) {
            section = line.slice(3).trim();
            i += 1;
            continue;
        }
        if (section === null || !line.startsWith('### ')) {
            i += 1;
            continue;
        }

        const title = line.slice(4).trim();
        let end = i + 1;
        while (end < lines.length) {
            const next = lines[end] ?? '';
            if (next.startsWith('### ') || next.startsWith('## ')) break;
            end += 1;
        }
        const body = lines.slice(i + 1, end);

        if (section === LICENCE_SECTION) {
            licences.push(parseLicence(title, body));
        } else if (isNoticeGroup(section)) {
            components.push(parseComponent(section, title, body));
        }
        i = end;
    }

    return { components, licences };
}
