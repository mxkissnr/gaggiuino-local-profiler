// The packages this repo installs carry no @types/node (`npm ci` produces no
// such directory — any copy under node_modules is npm-hoisted leftover marked
// "extraneous"), so `tsc --noEmit` has no declarations for Node's builtin
// modules and a test importing `node:fs` fails to resolve it. vitest runs these
// files on Node, so the specifiers are real at runtime; only the types are
// missing. Declare the members the tests and the root vite/vitest TypeScript
// configs (compiled by the same tsc program) actually use — add to this file
// when a later migration needs more of the API rather than reaching for a
// file-level ts-expect-error.
declare module 'node:child_process' {
    export function execFileSync(
        file: string,
        args: readonly string[],
        options: {
            cwd: string;
            encoding?: string;
            env?: Record<string, string | undefined>;
        },
    ): string;
}

declare module 'node:fs' {
    export function readFileSync(path: string, encoding: string): string;
    export function readFileSync(path: string): Buffer;
    export function writeFileSync(path: string, data: string | Uint8Array): void;
    export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
    export function mkdtempSync(prefix: string): string;
    export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
    export function existsSync(path: string): boolean;
    export function readdirSync(path: string): string[];
    export function unlinkSync(path: string): void;
    export function cpSync(
        source: string,
        destination: string,
        options?: { recursive?: boolean },
    ): void;
}

declare module 'node:os' {
    export function tmpdir(): string;
}

declare module 'node:path' {
    export function join(...parts: string[]): string;
    export function dirname(path: string): string;
    export function resolve(...parts: string[]): string;
    export function basename(path: string, suffix?: string): string;
}

// node:zlib is used by scripts/perf-dataset.mts to (de)compress ZIP entries.
declare module 'node:zlib' {
    export function deflateRawSync(data: Uint8Array): Buffer;
    export function inflateRawSync(data: Uint8Array): Buffer;
}

declare module 'node:url' {
    export function fileURLToPath(url: string | URL): string;
}

declare module 'node:vm' {
    export function runInNewContext(code: string, contextObject?: object): unknown;
}

// Node globals the tests read directly (vitest runs them on Node, where both
// exist; only their declarations are missing from this browser-oriented lib).
declare const process: {
    env: Record<string, string | undefined>;
    argv: string[];
    exit(code?: number): never;
    cwd(): string;
};
declare class Buffer extends Uint8Array {
    static from(data: readonly number[] | ArrayBuffer | Uint8Array | string, encoding?: string): Buffer;
    static alloc(size: number): Buffer;
    static concat(list: readonly Uint8Array[]): Buffer;
    readUInt16LE(offset: number): number;
    readUInt32LE(offset: number): number;
    writeUInt16LE(value: number, offset: number): number;
    writeUInt32LE(value: number, offset: number): number;
    toString(encoding?: string, start?: number, end?: number): string;
}

interface ImportMeta {
    /** Node's import.meta.dirname: the directory of the current module. */
    dirname: string;
}
