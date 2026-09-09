// This file adds the HA-ingress self-diagnostic (#901, Phase 3):
//
//   - GET /api/debug/ingress            — a verdict on how THIS request
//     reached the app through (or not through) the HA Supervisor ingress
//     proxy. JSON for programmatic callers, a self-contained HTML page for
//     the HA sidebar panel.
//   - GET /api/debug/ingress/sse-probe  — a 5-tick, 200ms-staggered SSE
//     stream the HTML page consumes with EventSource to measure whether the
//     real ingress proxy buffers Server-Sent Events (it historically did —
//     see internal/sse/doc.go's #740 history).
//
// cmd/server/smoke_test.go already covers the app side of the three ingress
// traps from a dev machine. What it cannot exercise is the actual HA
// Supervisor proxy in front of a real install — this endpoint lets Max hit
// ONE URL through the real HA panel and read back a green/red verdict.
//
// Gating matches GET /api/debug/machine exactly: registered only when
// NODE_ENV !== 'production' (h.nonProd), and — like every /api/debug/*
// route — it sits behind auth.RequireToken, so a genuine ingress request
// (Supervisor-network source IP + X-Ingress-Path) bypasses the token and a
// bare-port request needs one. No new gating is invented here.
package debug

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// ingressPathRE is the shape HA Core sets X-Ingress-Path to:
// /api/hassio_ingress/<per-session token>, the token being
// secrets.token_hex(...) output (hex, install- and session-specific — see
// auth.HAIngressPrefix's doc comment).
var ingressPathRE = regexp.MustCompile(`^/api/hassio_ingress/[0-9a-fA-F]+$`)

// sseProbeTicks / sseProbeInterval / sseProbeDeadline define the probe
// stream: 5 ticks, 200ms apart (t=0,200,…,800ms), under a hard 3s
// server-side deadline that also bounds a wedged proxy holding the
// connection open.
const (
	sseProbeTicks    = 5
	sseProbeInterval = 200 * time.Millisecond
	sseProbeDeadline = 3 * time.Second
)

type ingressVerdict struct {
	Status  string `json:"status"`
	Message string `json:"message"`
}

type ingressVerdicts struct {
	PathPrefix   ingressVerdict `json:"path_prefix"`
	TokenFlow    ingressVerdict `json:"token_flow"`
	SSEBuffering ingressVerdict `json:"sse_buffering"`
}

type ingressReport struct {
	RemoteAddr           string          `json:"remote_addr"`
	IsSupervisorIP       bool            `json:"is_supervisor_ip"`
	XIngressPath         string          `json:"x_ingress_path"`
	XForwardedProto      string          `json:"x_forwarded_proto"`
	XForwardedHost       string          `json:"x_forwarded_host"`
	XForwardedFor        string          `json:"x_forwarded_for"`
	Host                 string          `json:"host"`
	TLS                  bool            `json:"tls"`
	RequestURI           string          `json:"request_uri"`
	URLPath              string          `json:"url_path"`
	IsIngressRequest     bool            `json:"is_ingress_request"`
	AuthResult           string          `json:"auth_result"`
	ComputedExternalBase string          `json:"computed_external_base"`
	Verdicts             ingressVerdicts `json:"verdicts"`
	SSEProbeHint         string          `json:"sse_probe_hint"`
}

// buildIngressReport reports what the app actually received and computed for
// r — every field is read straight off the request or through the SAME
// auth helpers the rest of the app uses (auth.IsIngressRequest,
// auth.IsFromSupervisor), never a re-implementation.
func (h *Handlers) buildIngressReport(r *http.Request) ingressReport {
	xIngressPath := r.Header.Get("X-Ingress-Path")
	xForwardedProto := r.Header.Get("X-Forwarded-Proto")
	xForwardedHost := r.Header.Get("X-Forwarded-Host")

	isIngress := auth.IsIngressRequest(r)

	// The request reached this handler, so auth.RequireToken let it through.
	// For an /api/debug/* path the only two ways through are the ingress
	// bypass or a valid X-GLP-Token — report which.
	authResult := "token"
	if isIngress {
		authResult = "ingress-bypass"
	}

	// The app deliberately prefixes NOTHING onto generated URLs — every
	// href/src/action it emits is relative (internal/web/doc.go's
	// "Ingress-safe relative paths" invariant), so the browser resolves them
	// against whatever prefix it loaded the page under. The only meaningful
	// "external base" for this request is therefore the X-Ingress-Path the
	// browser is actually sitting behind, and only when this is a genuine
	// ingress request.
	computedExternalBase := ""
	if isIngress {
		computedExternalBase = strings.TrimRight(xIngressPath, "/")
	}

	scheme := "http"
	if r.TLS != nil || strings.EqualFold(xForwardedProto, "https") {
		scheme = "https"
	}
	host := xForwardedHost
	if host == "" {
		host = r.Host
	}
	probeURL := scheme + "://" + host + strings.TrimRight(xIngressPath, "/") + "/api/debug/ingress/sse-probe"

	return ingressReport{
		RemoteAddr:           r.RemoteAddr,
		IsSupervisorIP:       auth.IsFromSupervisor(r),
		XIngressPath:         xIngressPath,
		XForwardedProto:      xForwardedProto,
		XForwardedHost:       xForwardedHost,
		XForwardedFor:        r.Header.Get("X-Forwarded-For"),
		Host:                 r.Host,
		TLS:                  r.TLS != nil,
		RequestURI:           r.RequestURI,
		URLPath:              r.URL.Path,
		IsIngressRequest:     isIngress,
		AuthResult:           authResult,
		ComputedExternalBase: computedExternalBase,
		Verdicts: ingressVerdicts{
			PathPrefix:   pathPrefixVerdict(xIngressPath),
			TokenFlow:    tokenFlowVerdict(isIngress, authResult),
			SSEBuffering: ingressVerdict{"unknown", "run the probe — the HTML view does this automatically with EventSource; a curl user runs sse_probe_hint and watches whether the 5 ticks arrive staggered (~200ms apart) or batched."},
		},
		SSEProbeHint: fmt.Sprintf("curl -N --max-time 5 -H 'X-GLP-Token: <token>' '%s'  # 5 ticks ~200ms apart = OK; all at once = proxy buffering", probeURL),
	}
}

func pathPrefixVerdict(xIngressPath string) ingressVerdict {
	const invariant = " All internal references the app emits are relative (design invariant), so prefix handling happens entirely browser-side."
	switch {
	case xIngressPath == "":
		return ingressVerdict{"warn", "no X-Ingress-Path header on this request — either it did not arrive through HA ingress, or the Supervisor did not set the header." + invariant}
	case strings.HasPrefix(xIngressPath, auth.HAIngressPrefix):
		// Same check auth.IsIngressRequest makes — the per-session token
		// after the prefix is opaque (HA has used both hex and URL-safe
		// base64 tokens across versions), so its exact charset is not
		// something to warn about. ingressPathRE stays as the "textbook
		// shape" note only.
		msg := fmt.Sprintf("X-Ingress-Path %q has the expected %s… prefix.", xIngressPath, auth.HAIngressPrefix)
		if !ingressPathRE.MatchString(xIngressPath) {
			msg += " (token segment is not classic hex, which is fine — newer HA uses URL-safe tokens.)"
		}
		return ingressVerdict{"ok", msg + invariant}
	default:
		return ingressVerdict{"warn", fmt.Sprintf("X-Ingress-Path %q is present but does not start with %s — double-check the proxy chain.", xIngressPath, auth.HAIngressPrefix) + invariant}
	}
}

func tokenFlowVerdict(isIngress bool, authResult string) ingressVerdict {
	if isIngress == (authResult == "ingress-bypass") {
		return ingressVerdict{"ok", fmt.Sprintf("auth_result=%q is consistent with is_ingress_request=%v.", authResult, isIngress)}
	}
	return ingressVerdict{"warn", "auth path and ingress detection disagree — investigate auth.RequireToken / auth.IsIngressRequest."}
}

// ingress serves GET /api/debug/ingress. JSON when the caller asks for it
// (Accept: application/json or ?format=json); otherwise the self-contained
// HTML page for the HA panel.
func (h *Handlers) ingress(w http.ResponseWriter, r *http.Request) {
	report := h.buildIngressReport(r)

	if wantsJSON(r) {
		httputil.WriteJSON(w, http.StatusOK, report)
		return
	}

	// json.Marshal escapes <, >, & to < etc. by default, so the
	// compact payload is safe to drop straight into a <script
	// type="application/json"> block.
	payload, err := json.Marshal(report)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	// The app-wide CSP is script-src 'self' (no 'unsafe-inline'), which
	// would block the inline probe script. Narrow it to exactly this
	// script's SHA-256 for this one response — strictly tighter than
	// 'unsafe-inline', and it keeps the page a single self-contained
	// response rather than a second same-origin .js route.
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src '"+ingressProbeJSHash+"'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprintf(w, ingressPageHTML, payload, ingressProbeJS)
}

// wantsJSON reports whether the caller asked for JSON rather than the HTML
// page: an explicit ?format=json, or application/json in the Accept header.
// Anything else (a browser's text/html, curl's */*, no header) gets HTML.
func wantsJSON(r *http.Request) bool {
	switch r.URL.Query().Get("format") {
	case "json":
		return true
	case "html":
		return false
	}
	return strings.Contains(r.Header.Get("Accept"), "application/json")
}

// ingressSSEProbe serves GET /api/debug/ingress/sse-probe: 5 "tick" events
// 200ms apart, each flushed on its own, then a "done" event, then close —
// with the same anti-buffering headers the real /api/events sets. The whole
// handler is bounded by a hard sseProbeDeadline.
func (h *Handlers) ingressSSEProbe(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx, cancel := context.WithTimeout(r.Context(), sseProbeDeadline)
	defer cancel()

	for i := 0; i < sseProbeTicks; i++ {
		if i > 0 {
			select {
			case <-time.After(sseProbeInterval):
			case <-ctx.Done():
				return
			}
		}
		payload, _ := json.Marshal(map[string]any{"n": i + 1, "server_ms": h.clock().UnixMilli()})
		if _, err := fmt.Fprintf(w, "event: tick\ndata: %s\n\n", payload); err != nil {
			return
		}
		flusher.Flush()
	}

	if _, err := fmt.Fprint(w, "event: done\ndata: {}\n\n"); err != nil {
		return
	}
	flusher.Flush()
}

// ingressProbeJS is the browser-side probe embedded in ingressPageHTML: it
// renders the report, prints the path/token verdicts, then opens the
// sse-probe stream with EventSource and times the ticks on the client to
// decide whether the proxy in front of this app buffers SSE. No template
// literals (backticks) — this stays a Go raw string.
const ingressProbeJS = `(function () {
  var report = JSON.parse(document.getElementById('report').textContent);
  document.getElementById('json').textContent = JSON.stringify(report, null, 2);

  function setVerdict(id, status, msg) {
    var el = document.getElementById(id);
    el.className = 'verdict ' + status;
    el.textContent = msg;
  }
  var pp = report.verdicts.path_prefix;
  var tf = report.verdicts.token_flow;
  setVerdict('v-path', pp.status, pp.status.toUpperCase() + ' — ' + pp.message);
  setVerdict('v-token', tf.status, tf.status.toUpperCase() + ' — ' + tf.message);
  setVerdict('v-sse', 'unknown', 'RUNNING — probing SSE timing through this proxy...');

  var times = [];
  var es;
  try {
    es = new EventSource('ingress/sse-probe');
  } catch (e) {
    setVerdict('v-sse', 'warn', 'WARN — could not open EventSource: ' + e);
    return;
  }
  var settled = false;
  function finish() {
    if (settled) return;
    settled = true;
    try { es.close(); } catch (e) {}
    if (times.length < 2) {
      setVerdict('v-sse', 'warn', 'WARN — only ' + times.length + ' tick(s) received; probe inconclusive. On a bare port without ingress, run the sse_probe_hint command instead.');
      return;
    }
    var gaps = [];
    for (var i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    var maxGap = Math.max.apply(null, gaps);
    var span = times[times.length - 1] - times[0];
    var detail = ' (' + times.length + ' ticks over ' + Math.round(span) + 'ms, largest client gap ' + Math.round(maxGap) + 'ms)';
    if (times.length >= 5 && span >= 300 && maxGap < 400) {
      setVerdict('v-sse', 'ok', 'OK — proxy is NOT buffering SSE' + detail);
    } else if (times.length >= 5 && span <= 60) {
      setVerdict('v-sse', 'fail', 'FAIL — proxy BUFFERED the stream; SSE will be broken behind this proxy' + detail);
    } else {
      setVerdict('v-sse', 'warn', 'WARN — inconclusive' + detail + '; retry');
    }
  }
  es.addEventListener('tick', function () { times.push(performance.now()); });
  es.addEventListener('done', function () { finish(); });
  es.onerror = function () { finish(); };
  setTimeout(finish, 4000);
})();`

// ingressProbeJSHash is ingressProbeJS's base64 SHA-256, for the
// per-response script-src CSP (see ingress()).
var ingressProbeJSHash = func() string {
	sum := sha256.Sum256([]byte(ingressProbeJS))
	return "sha256-" + base64.StdEncoding.EncodeToString(sum[:])
}()

// ingressPageHTML is the self-contained diagnostic page. Two %s: the
// compact JSON report, then ingressProbeJS. No external assets; the inline
// <style> is covered by style-src 'unsafe-inline', the inline <script> by
// its SHA-256 in the per-response CSP.
const ingressPageHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GLP — HA Ingress Self-Check</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.55 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1.5rem; max-width: 62rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  p { margin: .5rem 0; }
  .verdict { padding: .6rem .8rem; border-radius: 6px; margin: .4rem 0; border: 1px solid transparent; }
  .verdict.ok { background: #e6f4ea; border-color: #1e7e34; color: #0f5132; }
  .verdict.fail { background: #fdecea; border-color: #b02a37; color: #842029; }
  .verdict.warn { background: #fff8e1; border-color: #b8860b; color: #664d03; }
  .verdict.unknown { background: #eeeef7; border-color: #6666cc; color: #333355; }
  pre { background: rgba(127,127,127,.12); padding: 1rem; border-radius: 6px; overflow-x: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: rgba(127,127,127,.15); padding: .1rem .3rem; border-radius: 3px; }
  @media (prefers-color-scheme: dark) {
    .verdict.ok { background: #10251a; color: #a3d9b1; }
    .verdict.fail { background: #2a1416; color: #f1aeb5; }
    .verdict.warn { background: #2a2410; color: #ffe69c; }
    .verdict.unknown { background: #1a1a2a; color: #b9b9e6; }
  }
</style>
</head>
<body>
<h1>GLP — HA Ingress Self-Check</h1>
<p>Open this through the Home Assistant sidebar panel. It reports what the add-on received from the HA Ingress proxy and live-probes whether that proxy buffers Server-Sent Events.</p>
<h2>Verdicts</h2>
<div id="v-path" class="verdict unknown">path prefix: waiting for script…</div>
<div id="v-token" class="verdict unknown">token flow: waiting for script…</div>
<div id="v-sse" class="verdict unknown">SSE buffering: waiting for script…</div>
<p>If the SSE probe stays inconclusive, you are probably not behind ingress — run the <code>sse_probe_hint</code> command from the report below.</p>
<h2>Raw report</h2>
<pre id="json">loading…</pre>
<script type="application/json" id="report">%s</script>
<script>%s</script>
</body>
</html>`
