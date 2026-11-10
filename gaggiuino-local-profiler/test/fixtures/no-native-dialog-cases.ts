// Fixture for test/no-native-dialog-lint.test.ts (#1962). ESLint ignores this
// file as project code (see eslint.config.mts) but tsc still type-checks it, and
// the test lints it through ESLint with ignore disabled. Lines ending in
// "// rejected" must be reported by the rule; lines ending in "// accepted" must
// not.
declare const el: Document;
declare const cond: boolean;

alert('a'); // rejected
confirm('a'); // rejected
window.alert('a'); // rejected
window.confirm('a'); // rejected
globalThis.confirm('a'); // rejected
self.alert('a'); // rejected
window['confirm']('a'); // rejected
export const aliased = alert; // rejected
export const markup = '<datalist id="x"></datalist>'; // rejected
export const template = `<datalist id="${String(cond)}">`; // rejected
el.createElement('datalist'); // rejected

export function shadowed(confirm: (m: string) => boolean): boolean { return confirm('a'); } // accepted
export const other = { alert: (): number => 1 }.alert(); // accepted
export const word = 'datalist'; // accepted
el.createElement('div'); // accepted
