// Fixture for test/html-sink-lint.test.ts (#1104 L1). ESLint ignores this file
// as project code (see eslint.config.mts) but tsc still type-checks it, and the
// test lints it through ESLint with ignore disabled so the typed `html-sink`
// rule can see the Html brand. Lines ending in "// rejected" must be reported by
// the rule; lines ending in "// accepted" must not.
import { esc, html, joinHtml } from '../../public-src/utils.js';
import type { Html } from '../../public-src/utils.js';
import { tHtml } from '../../public-src/i18n.js';

declare const el: HTMLElement;
declare const other: Element;
declare const someString: string;
declare const parts: string[];
declare const cond: boolean;
declare const obj: { value: string };

// Non-Html value shapes the typed rule must reject: identifiers, literals,
// untagged templates, nested ternaries, string-producing calls, member reads,
// computed sinks and `+=`.
el.innerHTML = someString; // rejected
el.innerHTML = 'raw'; // rejected
el.innerHTML += `rawness ${someString}`; // rejected
el.innerHTML += someString; // rejected
el.innerHTML = cond ? 'a' : 'b'; // rejected
el.innerHTML = cond ? (cond ? 'a' : 'b') : 'c'; // rejected
el.innerHTML = String(someString); // rejected
el.innerHTML = parts.join(''); // rejected
el.innerHTML = someString.toString(); // rejected
el.innerHTML = obj.value; // rejected
el['innerHTML'] = someString; // rejected
el.outerHTML = someString; // rejected
el.insertAdjacentHTML('beforeend', 'raw'); // rejected
other.insertAdjacentHTML('afterend', cond ? 'a' : 'b'); // rejected

// Html producers the rule must accept, including through a computed sink.
el.innerHTML = html`<b>${esc(someString)}</b>`; // accepted
el.innerHTML = esc(someString); // accepted
el.innerHTML = joinHtml([esc('a'), tHtml('key')]); // accepted
el.innerHTML = cond ? esc('a') : esc('b'); // accepted
el.innerHTML = html``; // accepted
el['innerHTML'] = html`<u>${esc(someString)}</u>`; // accepted
el.insertAdjacentHTML('beforeend', html`<i>${esc(someString)}</i>`); // accepted

// #1626: the further markup sinks. write/writeln only count on a Document.
declare const parser: DOMParser;
declare const range: Range;
declare const frame: HTMLIFrameElement;
declare const stream: { write(s: string): void };
document.write(someString); // rejected
document.writeln('raw'); // rejected
parser.parseFromString(someString, 'text/html'); // rejected
range.createContextualFragment(someString); // rejected
el.setHTMLUnsafe(someString); // rejected
frame.srcdoc = someString; // rejected
document.write(html`<p>${esc(someString)}</p>`); // accepted
parser.parseFromString(esc(someString), 'text/html'); // accepted
range.createContextualFragment(html`<b></b>`); // accepted
el.setHTMLUnsafe(esc(someString)); // accepted
frame.srcdoc = html`<p>${esc(someString)}</p>`; // accepted
stream.write(someString); // accepted

// #1626: casting a computed string to Html mints the brand without escaping;
// only a static string may be cast.
export const castInterpolated = `<b>${someString}</b>` as Html; // rejected
export const castIdentifier = someString as Html; // rejected
export const castCall = parts.join('') as Html; // rejected
export const castLiteral = '<b>static</b>' as Html; // accepted
export const castStaticTemplate = `<svg viewBox="0 0 1 1"></svg>` as Html; // accepted
