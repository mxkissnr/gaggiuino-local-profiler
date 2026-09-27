// Demo entry point (#1193). The GitHub Pages demo ships the real SPA but no
// server, so a service worker answers every API request from recorded
// fixtures. Register it, wait until it controls this page, then start the app
// unchanged — the normal build still boots straight into main.ts.
//
// main.ts is intentionally left alone: it only unregisters/registers a worker
// named exactly sw.js, so the demo worker (demo-sw.js) never collides with it.

const SW_URL = './demo-sw.js';
const RELOAD_FLAG = 'glp-demo-reloaded';

function showUnsupported(): void {
    document.body.textContent = 'This demo needs a browser with service workers';
}

function waitForController(): Promise<void> {
    return new Promise<void>(resolve => {
        const onChange = (): void => {
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.removeEventListener('controllerchange', onChange);
                resolve();
            }
        };
        navigator.serviceWorker.addEventListener('controllerchange', onChange);
    });
}

/**
 * Ensures the worker controls this page before the app starts loading data.
 * Returns false when the page is about to reload (caller must stop).
 */
async function ensureController(): Promise<boolean> {
    if (navigator.serviceWorker.controller) return true;

    // First load: the worker is installing/activating. It claims the page in
    // its activate handler, which fires controllerchange — but if the worker
    // was already active and this page loaded from cache, that event may never
    // come, so the container's `ready` is the fallback.
    await Promise.race([waitForController(), navigator.serviceWorker.ready]);
    if (navigator.serviceWorker.controller) return true;

    // Still uncontrolled: reload once so the worker sits in front of every
    // request. The session flag stops a reload loop if it never takes over.
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, '1');
    location.reload();
    return false;
}

async function start(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
        showUnsupported();
        return;
    }
    await navigator.serviceWorker.register(SW_URL, { scope: './' });
    if (!await ensureController()) return;
    await import('../main.ts');
}

void start().catch(error => {
    console.error('[glp-demo] failed to start', error);
    showUnsupported();
});
