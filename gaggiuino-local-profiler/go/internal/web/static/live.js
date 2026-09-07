// live.js is Phase 2c's (#901) deliberate exception to this frontend's
// templ+htmx+Alpine page pattern: a standalone vanilla-JS module that
// consumes the /api/events SSE stream directly and draws the live shot
// chart onto <canvas id="liveChart"> (templates/live.templ), instead of a
// server-rendered fragment swap — see that template's own header comment
// and go/README.md's Frontend section for the "why" (several SSE pushes a
// second during a pull; a server round trip per frame is the wrong tool).
//
// This is a port, not a rewrite, of public-src/views/live.js — same
// Chart.js line chart (pressure/flow on the left axis, weight/temp on the
// right, dual y-axes), same GET /api/live/data + GET /api/preheat initial
// fetch, same live-snapshot/preheat-update SSE event handling, same #655
// machineReachable-wins-over-isLive precedence (a powered-off machine must
// never render identically to an idle-but-reachable one). Chart.js itself
// is vendored unmodified at static/vendor/chart-4.5.1.umd.min.js (see that
// directory's NOTICE.md) and loaded before this file by
// templates/live.templ.
//
// Deliberately NOT ported from the Node original — later-phase polish, not
// this page's core correctness, and each would have pulled in its own
// sizeable chunk of app state this standalone module doesn't have:
//   - the reference-shot overlay (public-src/views/live.js's datasets 4-7,
//     populateRefSelector/onRefShotChange/autoApplyRefShot) — needs a
//     loaded shot list this page doesn't fetch
//   - the animated per-machine SVG icon (public-src/machine-icon.js) — a
//     separate, sizeable module of its own, with no Go-side equivalent yet
//   - the multi-machine live-capability gating banner
//     (_isActiveMachineLiveCapable) — this Go server's background poller
//     (internal/system.Poller) is, same as lib/poll.js's own
//     pollViaGaggiuinoStatus, still hardcoded to the default machine only,
//     so there is currently only ever one machine this page could show
//     live data for regardless
//   - i18n (public-src/i18n.js's t()) — this Go frontend has no i18n
//     system yet (every other templates/*.templ page is English-only
//     too), so labels here are plain English text, not translation keys
//
// Auth note: GET /api/live/data and GET /api/preheat sit under /api/, so
// (unlike GET /api/events, GET /api/status, and GET /api/token —
// internal/auth.RequireToken's three explicit exceptions) they need a
// valid X-GLP-Token. This module fetches its own token the same way
// static/glp-token.js does for htmx requests (GET /api/token, a relative
// fetch — see that file's own doc comment for why root-absolute would
// break under HA Ingress's session-prefixed URLs) rather than reaching into
// glp-token.js's own module-private state, keeping this file a genuinely
// standalone module as the dispatch brief asks.
/* global Chart */
(function () {
	'use strict';

	var glpToken = null;

	function fetchToken() {
		return fetch('api/token')
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (body) { if (body && body.apiToken) glpToken = body.apiToken; })
			.catch(function () { /* network error, or expose_api_port=false with no Ingress: stay tokenless */ });
	}

	function authedFetch(url) {
		var headers = glpToken ? { 'X-GLP-Token': glpToken } : {};
		return fetch(url, { headers: headers });
	}

	// ── Chart ────────────────────────────────────────────────────────────

	var chart = null;

	function mapToXY(times, values) {
		var out = [];
		if (!times || !values) return out;
		for (var i = 0; i < times.length; i++) {
			if (values[i] == null) continue;
			out.push({ x: times[i] / 10, y: values[i] / 10 });
		}
		return out;
	}

	function initChart() {
		var canvas = document.getElementById('liveChart');
		if (!canvas || typeof Chart === 'undefined') return null;
		return new Chart(canvas, {
			type: 'line',
			data: {
				datasets: [
					{ label: 'Pressure', data: [], yAxisID: 'y', borderWidth: 2.5, tension: 0.1, borderColor: '#3498db', backgroundColor: 'transparent', pointStyle: false },
					{ label: 'Flow', data: [], yAxisID: 'y', borderWidth: 2, tension: 0.1, borderColor: '#f39c12', backgroundColor: 'transparent', pointStyle: false },
					{ label: 'Weight', data: [], yAxisID: 'y1', borderWidth: 2, tension: 0.1, borderColor: '#2ecc71', backgroundColor: 'transparent', pointStyle: false },
					{ label: 'Temp', data: [], yAxisID: 'y1', borderWidth: 2.5, tension: 0.1, borderColor: '#e74c3c', backgroundColor: 'transparent', pointStyle: false }
				]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: 'index', intersect: false },
				plugins: { legend: { labels: { color: '#a4a9ad' } } },
				scales: {
					x: { type: 'linear', min: 0, max: 60, ticks: { color: '#93989c' }, grid: { color: '#2b2f33' } },
					y: { type: 'linear', position: 'left', min: 0, max: 12, ticks: { color: '#93989c' }, grid: { color: '#2b2f33' } },
					y1: { type: 'linear', position: 'right', min: 0, max: 100, ticks: { color: '#93989c' }, grid: { drawOnChartArea: false } }
				}
			}
		});
	}

	// ── Status badge ─────────────────────────────────────────────────────

	var LABELS = {
		connecting: 'Connecting…',
		ready: 'Ready',
		brewing: 'Brewing',
		idle: 'Ready',
		unreachable: 'Machine unreachable'
	};

	function setBadge(state, detail) {
		var badge = document.getElementById('live-status-badge');
		var text = document.getElementById('live-status-text');
		if (!badge || !text) return;
		badge.className = 'live-status-badge ' + state;
		text.textContent = detail || LABELS[state] || state;
	}

	// ── Preheat widget ───────────────────────────────────────────────────

	function updatePreheat(d) {
		var readyBadge = document.getElementById('preheat-ready-badge');
		var warmingWrap = document.getElementById('preheat-warming-wrap');
		var barFill = document.getElementById('preheat-bar-fill');
		var countdown = document.getElementById('preheat-countdown');
		if (!readyBadge || !d) return;

		if (d.ready) {
			readyBadge.style.display = '';
			warmingWrap.style.display = 'none';
		} else if (d.remaining > 0) {
			readyBadge.style.display = 'none';
			warmingWrap.style.display = '';
			barFill.style.width = Math.round((d.pct || 0) * 100) + '%';
			var m = Math.floor(d.remaining / 60);
			var s = d.remaining % 60;
			countdown.textContent = m + 'm ' + s + 's remaining';
		} else {
			readyBadge.style.display = 'none';
			warmingWrap.style.display = 'none';
		}
	}

	// ── Live data ────────────────────────────────────────────────────────

	function handleLiveData(msg) {
		if (!msg) return;
		var dp = msg.datapoints || {};
		var times = dp.timeInShot || [];
		var lastIdx = times.length - 1;

		var metaEl = document.getElementById('live-meta');
		var contentEl = document.getElementById('live-content');
		var idleEl = document.getElementById('live-idle');
		var idleTitleEl = document.getElementById('liveIdleTitle');
		var idleTextEl = document.getElementById('liveIdleText');

		// #655: machineReachable === false is the authoritative "machine is
		// off/unreachable" signal and must win over the isLive-based "ready"
		// fallback below — otherwise a powered-off machine renders
		// identically to an idle-but-reachable one.
		if (msg.machineReachable === false) {
			setBadge('unreachable');
			if (metaEl) metaEl.textContent = '';
			if (contentEl) contentEl.style.display = 'none';
			if (idleEl) idleEl.style.display = 'flex';
			if (idleTitleEl) idleTitleEl.textContent = 'Machine unreachable';
			if (idleTextEl) idleTextEl.textContent = 'Check the machine is powered on and reachable on the network.';
			return;
		}

		if (!msg.isLive && times.length === 0) {
			setBadge('ready');
			if (metaEl) metaEl.textContent = '';
			if (contentEl) contentEl.style.display = 'none';
			if (idleEl) {
				idleEl.style.display = 'flex';
				if (idleTitleEl) idleTitleEl.textContent = 'Ready to brew';
				if (idleTextEl) idleTextEl.textContent = 'Start a shot on the machine to see it here live.';
			}
			return;
		}

		if (contentEl) contentEl.style.display = 'block';
		if (idleEl) idleEl.style.display = 'none';

		if (msg.isLive) {
			setBadge('brewing');
			if (metaEl) metaEl.textContent = msg.profileName || '';
		} else {
			setBadge('idle');
			if (metaEl) metaEl.textContent = (msg.profileName || '') + ' · finished';
		}

		if (lastIdx >= 0) {
			var elapsed = times[lastIdx] / 10;
			var pressure = dp.pressure && dp.pressure[lastIdx] != null ? dp.pressure[lastIdx] / 10 : null;
			var flow = dp.pumpFlow && dp.pumpFlow[lastIdx] != null ? dp.pumpFlow[lastIdx] / 10 : null;
			var weightArr = dp.shotWeight || dp.weight;
			var weight = weightArr && weightArr[lastIdx] != null ? weightArr[lastIdx] / 10 : null;
			var temp = dp.temperature && dp.temperature[lastIdx] != null ? dp.temperature[lastIdx] / 10 : null;

			setText('liveTime', elapsed.toFixed(1) + 's');
			setText('livePressure', pressure != null ? pressure.toFixed(1) : '–');
			setText('liveFlow', flow != null ? flow.toFixed(1) : '–');
			setText('liveWeight', weight != null ? weight.toFixed(1) : '–');
			setText('liveTemp', temp != null ? temp.toFixed(1) : '–');
		}

		if (chart) {
			var maxTime = times.length > 0 ? times[times.length - 1] / 10 : 60;
			chart.data.datasets[0].data = mapToXY(times, dp.pressure);
			chart.data.datasets[1].data = mapToXY(times, dp.pumpFlow);
			chart.data.datasets[2].data = mapToXY(times, dp.shotWeight || dp.weight);
			chart.data.datasets[3].data = mapToXY(times, dp.temperature);
			chart.options.scales.x.max = Math.max(maxTime + 5, 30);

			var maxTemp = 0;
			if (dp.temperature) {
				for (var i = 0; i < dp.temperature.length; i++) {
					if (dp.temperature[i] > maxTemp) maxTemp = dp.temperature[i];
				}
				maxTemp = maxTemp / 10;
			}
			chart.options.scales.y1.max = maxTemp ? Math.ceil(maxTemp + 5) : 100;

			chart.update('none');
		}
	}

	function setText(id, value) {
		var el = document.getElementById(id);
		if (el) el.textContent = value;
	}

	// ── Bootstrap ────────────────────────────────────────────────────────

	function connect() {
		chart = initChart();
		setBadge('connecting');

		fetchToken().then(function () {
			authedFetch('api/live/data')
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(handleLiveData)
				.catch(function () { setBadge('unreachable', 'Connection error'); });
			authedFetch('api/preheat')
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(updatePreheat)
				.catch(function () { /* preheat widget just stays hidden */ });
		});

		// GET /api/events is one of the three routes internal/auth.RequireToken
		// exempts unconditionally (EventSource can't send custom headers) —
		// no token/query-param dance needed here, unlike the two fetches above.
		var es = new EventSource('api/events');
		es.addEventListener('live-snapshot', function (evt) {
			try { handleLiveData(JSON.parse(evt.data)); } catch { /* malformed frame, skip */ }
		});
		es.addEventListener('preheat-update', function (evt) {
			try { updatePreheat(JSON.parse(evt.data)); } catch { /* malformed frame, skip */ }
		});
		es.onerror = function () {
			setBadge('unreachable', 'Connection lost');
		};
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', connect);
	} else {
		connect();
	}
})();
