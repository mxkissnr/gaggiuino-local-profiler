// The packages this repo installs carry no @types/node (`npm ci` produces no
// such directory — any copy under node_modules is npm-hoisted leftover marked
// "extraneous"), so `tsc --noEmit` has no declarations for Node's builtin
// modules and a test importing `node:fs` fails to resolve it. vitest runs these
// files on Node, so the specifiers are real at runtime; only the types are
// missing. Declare the members the tests actually use — add to this file when a
// later test migration needs more of the API rather than reaching for a
// file-level ts-expect-error.
declare module 'node:child_process' {
    export function execFileSync(
        file: string,
        args: readonly string[],
        options: { cwd: string; encoding: string },
    ): string;
}

declare module 'node:fs' {
    export function readFileSync(path: string, encoding: string): string;
    export function mkdtempSync(prefix: string): string;
    export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:os' {
    export function tmpdir(): string;
}

declare module 'node:path' {
    export function join(...parts: string[]): string;
    export function dirname(path: string): string;
    export function resolve(...parts: string[]): string;
}

declare module 'node:url' {
    export function fileURLToPath(url: string | URL): string;
}

interface ImportMeta {
    /** Node's import.meta.dirname: the directory of the current module. */
    dirname: string;
}
