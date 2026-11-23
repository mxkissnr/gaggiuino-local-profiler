#!/usr/bin/env node
// Syncs the version numbers of THIRD_PARTY_NOTICES.md with what the app really
// ships (#2183): the npm packages from package-lock.json and the Go modules that
// `go list -deps` reports for the three image architectures, plus the standard
// library of the Dockerfile's builder image.
//
// It rewrites only the version part of `### <name> <version>` headings that
// already exist, under `## Libraries` and `## Server`, and the pkg.go.dev
// licence link inside a Go entry it bumps. It never adds, removes or reorders a
// section and never writes licence text: a new or removed package/module stays a
// manual step on purpose, because a person must check the licence. Those cases
// are reported and make the run exit non-zero.
//
// The pure functions below take text and parsed data, so test/notices-sync.test.ts
// can exercise them without a filesystem, node_modules or the Go toolchain. The
// wrapper at the bottom is the only part that reads/writes files and runs `go`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_PACKAGES_PREFIX = 'node_modules/';
const NOT_PACKAGES = 'package-lock.json has no "packages" object';

export interface NpmLock {
    /** Version at the top-level install path "node_modules/<name>"; non-dev entries only. */
    top: Map<string, string>;
    /** Other non-dev versions of the same name installed deeper in the tree (distinct, sorted). */
    nested: Map<string, string[]>;
}

export interface Installed {
    /** Keys of "dependencies" in the package manifest: each needs a Libraries heading. */
    npmDirect: string[];
    npm: NpmLock;
    /** Module path -> version, merged over the three image architectures. */
    goModules: Map<string, string>;
    /** X.Y.Z of the golang:<X.Y.Z>-alpine builder tag in the Dockerfile. */
    goStdlib: string;
}

export interface SyncResult {
    text: string;
    changes: string[];
    problems: string[];
}

function packagesOf(lock: unknown): Record<string, unknown> {
    if (typeof lock !== 'object' || lock === null) throw new Error(NOT_PACKAGES);
    const packages = (lock as { packages?: unknown }).packages;
    if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) {
        throw new Error(NOT_PACKAGES);
    }
    return packages as Record<string, unknown>;
}

export function readNpmLock(lock: unknown): NpmLock {
    const packages = packagesOf(lock);
    const top = new Map<string, string>();
    const nested = new Map<string, string[]>();
    for (const [key, entry] of Object.entries(packages)) {
        if (key === '' || typeof entry !== 'object' || entry === null) continue;
        const { version, dev } = entry as { version?: unknown; dev?: unknown };
        if (typeof version !== 'string' || dev === true) continue;
        const at = key.lastIndexOf(NPM_PACKAGES_PREFIX);
        if (at === -1) continue;
        const name = key.slice(at + NPM_PACKAGES_PREFIX.length);
        if (name === '') continue;
        if (key === NPM_PACKAGES_PREFIX + name) {
            top.set(name, version);
            continue;
        }
        const versions = nested.get(name) ?? [];
        if (!versions.includes(version)) versions.push(version);
        nested.set(name, versions);
    }
    for (const [name, versions] of nested) {
        nested.set(name, [...versions].sort((a, b) => a.localeCompare(b)));
    }
    return { top, nested };
}

export function parseGoList(output: string): Map<string, string> {
    const modules = new Map<string, string>();
    for (const line of output.split('\n')) {
        const fields = line.split(/\s+/).filter((field) => field !== '');
        const [path] = fields;
        if (path === undefined) continue;
        const last = fields[fields.length - 1];
        if (last === 'REPLACED') {
            throw new Error(`${path} is a replaced module; a replacement needs a deliberate notice decision`);
        }
        if (fields.length !== 2) throw new Error(`unexpected go list line: ${JSON.stringify(line)}`);
        const version = fields[1];
        if (version === undefined) continue;
        modules.set(path, version);
    }
    return modules;
}

export function builderGoVersion(dockerfile: string): string {
    const versions = [...dockerfile.matchAll(/golang:(\d+\.\d+\.\d+)-alpine/g)]
        .map((match) => match[1])
        .filter((version): version is string => version !== undefined);
    const only = versions[0];
    if (versions.length !== 1 || only === undefined) {
        throw new Error(
            `the Dockerfile has ${versions.length} golang:<version>-alpine image tags, want exactly 1`,
        );
    }
    return only;
}

// Entry lines run from the heading to the next line that starts with '#'.
function replaceInEntry(lines: string[], headingIndex: number, from: string, to: string): boolean {
    let found = false;
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || line.startsWith('#')) break;
        if (line.includes(from)) {
            lines[index] = line.split(from).join(to);
            found = true;
        }
    }
    return found;
}

export function syncNotices(notices: string, installed: Installed): SyncResult {
    const lines = notices.split('\n');
    const changes: string[] = [];
    const problems: string[] = [];
    const seenNpm = new Set<string>();
    const seenGo = new Set<string>();
    let stdlibSeen = false;
    let group = '';

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (line.startsWith('## ')) {
            group = line.slice(3).trim();
            continue;
        }
        if (!line.startsWith('### ')) continue;
        if (group !== 'Libraries' && group !== 'Server') continue;
        const title = line.slice(4).trim();

        if (group === 'Libraries') {
            const space = title.indexOf(' ');
            if (space === -1) continue;
            const name = title.slice(0, space);
            const version = title.slice(space + 1);
            seenNpm.add(name);
            const top = installed.npm.top.get(name);
            if (top === undefined) {
                problems.push(
                    `gone package: remove the section "### ${title}" and its name in the licence texts; ${name} is not installed by package-lock.json`,
                );
                continue;
            }
            const others = (installed.npm.nested.get(name) ?? []).filter((other) => other !== top);
            if (!installed.npmDirect.includes(name) && others.length > 0) {
                problems.push(
                    `check by hand: "### ${title}": package-lock.json installs ${name} at ${[top, ...others].join(', ')}`,
                );
                continue;
            }
            if (version !== top) {
                lines[index] = `### ${name} ${top}`;
                changes.push(`### ${title} -> ### ${name} ${top}`);
            }
            continue;
        }

        if (title.startsWith('Go standard library ')) {
            stdlibSeen = true;
            const version = title.slice('Go standard library '.length);
            if (version !== installed.goStdlib) {
                lines[index] = `### Go standard library ${installed.goStdlib}`;
                changes.push(`### ${title} -> ### Go standard library ${installed.goStdlib}`);
            }
            continue;
        }

        const space = title.indexOf(' ');
        if (space === -1) continue;
        const path = title.slice(0, space);
        const version = title.slice(space + 1);
        seenGo.add(path);
        const linked = installed.goModules.get(path);
        if (linked === undefined) {
            problems.push(
                `gone module: remove the section "### ${title}" and its name in the licence texts; no package of ${path} is compiled into the server`,
            );
            continue;
        }
        if (linked === version) continue;
        lines[index] = `### ${path} ${linked}`;
        changes.push(`### ${title} -> ### ${path} ${linked}`);
        const oldLink = `https://pkg.go.dev/${path}@${version}?tab=licenses`;
        const newLink = `https://pkg.go.dev/${path}@${linked}?tab=licenses`;
        if (!replaceInEntry(lines, index, oldLink, newLink)) {
            problems.push(`check by hand: "### ${path} ${linked}" has no line "- Licence: ${newLink}"`);
        }
    }

    for (const name of [...installed.npmDirect].sort()) {
        if (seenNpm.has(name)) continue;
        const top = installed.npm.top.get(name);
        if (top === undefined) {
            problems.push(
                `${name} is a dependency in package.json but not in package-lock.json; run npm install first`,
            );
        } else {
            problems.push(
                `new package: check its licence, then add a section under "## Libraries" with the licence text, heading: ### ${name} ${top}`,
            );
        }
    }
    if (!stdlibSeen) {
        problems.push(
            `missing: add a section under "## Server", heading: ### Go standard library ${installed.goStdlib}`,
        );
    }
    for (const path of [...installed.goModules.keys()].sort()) {
        if (seenGo.has(path)) continue;
        const version = installed.goModules.get(path) ?? '';
        problems.push(
            `new module: check its licence, then add a section under "## Server" with the licence text, heading: ### ${path} ${version}`,
        );
    }

    return { text: lines.join('\n'), changes, problems };
}

// Same template the Go notices test uses, so both look at the same module set.
const GO_LIST_FORMAT =
    '{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}}{{if .Replace}} REPLACED{{end}}{{end}}{{end}}';

function goListServerModules(projectDir: string, arch: string): string {
    try {
        return execFileSync('go', ['list', '-deps', '-f', GO_LIST_FORMAT, '.'], {
            cwd: join(projectDir, 'go', 'cmd', 'server'),
            env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: arch, GOARM: '7' },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
            throw new Error(`linux/${arch}: the Go part of this script needs the Go toolchain on PATH`);
        }
        throw error;
    }
}

// CLI: npm run notices:sync
if (import.meta.main) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const projectDir = join(scriptDir, '..');
    const noticesPath = join(projectDir, 'public-src', 'public', 'THIRD_PARTY_NOTICES.md');

    try {
        const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
        };
        const npmDirect = Object.keys(manifest.dependencies ?? {}).sort();
        const npm = readNpmLock(
            JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8')) as unknown,
        );
        const goStdlib = builderGoVersion(readFileSync(join(projectDir, 'Dockerfile'), 'utf8'));

        const goModules = new Map<string, string>();
        for (const arch of ['amd64', 'arm64', 'arm']) {
            for (const [path, version] of parseGoList(goListServerModules(projectDir, arch))) {
                goModules.set(path, version);
            }
        }

        const notices = readFileSync(noticesPath, 'utf8');
        const result = syncNotices(notices, { npmDirect, npm, goModules, goStdlib });
        if (result.text !== notices) writeFileSync(noticesPath, result.text);

        for (const change of result.changes) console.log(change);
        if (result.changes.length === 0 && result.problems.length === 0) {
            console.log('THIRD_PARTY_NOTICES.md is up to date');
        }
        if (result.problems.length > 0) {
            for (const problem of result.problems) console.error(problem);
            console.error(
                'Version bumps above (if any) were written; the entries above need a person (licence check), the script never writes licence text.',
            );
            process.exit(1);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
