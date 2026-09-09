// glp-token.js wires the API token into every htmx write request this and
// future Phase-2 pages issue (#901 follow-up). Loaded once, globally, from
// templates/layout.templ's <head> — no per-page/per-button wiring needed.
//
// Mechanism (mirrors public-src/api.js's initToken()/apiFetch() pattern
// for the existing SPA, deliberately, rather than inventing a second
// scheme): fetch the token from the already-public GET /api/token (see
// go/internal/system/handlers.go's getToken) once this script runs, then
// attach it as the X-GLP-Token header — the same header
// internal/auth.RequireToken checks for the JSON API — to every htmx
// request via htmx's htmx:configRequest event, which any script may
// listen for without htmx itself needing to know about auth.
//
// Why fetch-and-attach instead of an SSR meta tag baked into the page:
// GET /shots (this script's own host page) is deliberately unauthenticated
// per internal/web/doc.go's "Auth model" section (Ingress-trust / static-
// asset carve-out) — anyone who can load that page can load this script
// too. But GET /api/token is *already* exactly as reachable to that same
// caller: also public by default, rate-limited, and gated only by
// expose_api_port for a non-Ingress direct-port caller (see getToken's own
// doc comment) — the identical trust boundary GET /shots itself sits
// behind. Fetching client-side therefore introduces no exposure beyond
// what api.js's initToken() already grants the SPA today; it just reuses
// that existing public endpoint instead of a second, redundant channel.
// Whatever expose_api_port/Ingress denies to GET /api/token it equally
// denies here: fetchToken() below then leaves token null, the
// htmx:configRequest listener attaches nothing, and the write request
// 401s exactly like a standalone-mode session with no token today — not a
// new failure mode, the same one GET /api/token's own doc comment
// describes for the SPA.
//
// #901 code review (2 findings): the fetch path below is relative
// ("api/token", no leading slash), not root-absolute — deliberately
// mirroring public-src/api.js's initToken(), which fetches 'api/token' the
// same way. GET /shots (this script's host page) is reachable through HA
// Ingress at a per-session prefix (/api/hassio_ingress/<token>/...), and
// every route this package registers (GET /shots, GET /api/token, POST
// /shots/{id}/trash, ...) is a flat, single-segment-deep sibling under
// that prefix — so a *relative* fetch from /shots resolves against
// ".../<prefix>/" and lands on ".../<prefix>/api/token", the add-on's own
// handler. A root-absolute path with a leading slash instead resolves
// against the origin root, skipping the Ingress prefix entirely and
// missing the add-on — landing on HA Core's own root, not this app, and
// 404ing there.
// That failure was silent (swallowed by the .catch() below), leaving
// token permanently null on Ingress, the primary access path — not just
// the non-Ingress/expose_api_port=false case the rest of this comment
// block and go/README.md's "Auth model" section describe; both are now
// updated to stop implying only the non-Ingress path was affected.
//
// The second finding was a race: fetchToken() below used to run once,
// fire-and-forget, with nothing to make a click land after it settled. A
// Trash/Restore click during that window fired with no X-GLP-Token header
// and 401'd even though the fetch would have succeeded moments later.
// tokenPromise plus the htmx:confirm listener below close that: htmx
// fires htmx:confirm for every request it issues (hx-confirm attribute or
// not — see the vendored htmx-2.0.10.min.js's issueRequest()/confirm
// dispatch), before the request actually goes out, so intercepting it
// here and deferring evt.detail.issueRequest() until tokenPromise settles
// makes every htmx request wait for the token fetch's outcome (success,
// failure, or an already-settled promise on a later click) instead of
// racing it.
(function () {
	var token = null;

	function fetchToken() {
		var headers = token ? { "X-GLP-Token": token } : {};
		return fetch("api/token", { headers: headers })
			.then(function (r) {
				return r.ok ? r.json() : null;
			})
			.then(function (body) {
				if (body && body.apiToken) token = body.apiToken;
			})
			.catch(function () {
				// Network error, or expose_api_port=false with no Ingress
				// (getToken's 403): token stays null, matching
				// api.js's initToken() leaving S.glpToken empty in the
				// same situation. tokenPromise still resolves (not
				// rejects) so requests waiting on it below aren't stuck
				// forever — they just proceed with no token, same as
				// before this fix, and 401 the same way.
			});
	}

	document.body.addEventListener("htmx:configRequest", function (evt) {
		if (token) evt.detail.headers["X-GLP-Token"] = token;
	});

	document.body.addEventListener("htmx:confirm", function (evt) {
		evt.preventDefault();
		tokenPromise.then(function () {
			evt.detail.issueRequest(true);
		});
	});

	var tokenPromise = fetchToken();
})();
