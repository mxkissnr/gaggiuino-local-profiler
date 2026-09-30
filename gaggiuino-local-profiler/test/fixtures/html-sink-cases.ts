// Fixture for test/html-sink-lint.test.ts (#1104 L1). ESLint ignores this file
// as project code (see eslint.config.js) but tsc still type-checks it, and the
// test lints it through ESLint with ignore disabled so the typed `html-sink`
// rule can see the Html brand. Lines ending in "// rejected" must be reported by
// the rule; lines ending in "// accepted" must not.
import { esc, html, joinHtml } from '../../public-src/utils.js';
import { tHtml } from '../../public-src/i18n.js';

declare const el: HTMLElement;
declare const other: Element;
declare const someString: string;
declare const parts: string[];
declare const cond: boolean;

el.innerHTML = someString; // rejected
el.innerHTML = 'raw'; // rejected
el.innerHTML += `rawness ${someString}`; // rejected
el.innerHTML = cond ? 'a' : 'b'; // rejected
el.innerHTML = String(someString); // rejected
el.innerHTML = parts.join(''); // rejected
el.innerHTML = someString.toString(); // rejected
el.innerHTML = 'a'.concat(someString); // rejected
el.outerHTML = someString; // rejected
el.insertAdjacentHTML('beforeend', 'raw'); // rejected
other.insertAdjacentHTML('afterend', cond ? 'a' : 'b'); // rejected

el.innerHTML = html`<b>${esc(someString)}</b>`; // accepted
el.innerHTML = esc(someString); // accepted
el.innerHTML = joinHtml([esc('a'), tHtml('key')]); // accepted
el.innerHTML = cond ? esc('a') : esc('b'); // accepted
el.innerHTML = html``; // accepted
el.insertAdjacentHTML('beforeend', html`<i>${esc(someString)}</i>`); // accepted
