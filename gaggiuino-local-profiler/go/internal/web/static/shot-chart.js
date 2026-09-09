// shot-chart.js is Phase B's (#901) shot-detail chart: a standalone
// vanilla-JS module (same pattern as static/live.js — see that file's own
// doc comment for the full "why a standalone module instead of a
// server-rendered fragment" reasoning, which applies here for a different
// reason: Chart.js itself needs a live DOM canvas + JS object to draw
// into, not something templ can emit as static markup) that renders a
// STATIC post-shot pressure/flow/weight/temperature chart, not a live SSE
// stream — the port of public-src/views/shots/index.js's updateView()
// main-chart datasets, restyled onto the same vendored Chart.js UMD build
// live.js already uses (static/vendor/chart-4.5.1.umd.min.js — see
// vendor/NOTICE.md).
//
// Design pass 4 follow-up (#901): this module now also covers the two
// chart-side pieces that pass deliberately left out — the same-profile
// "ghost curve" ((`data-ghost-shot-id`, findPreviousShot's dashed,
// low-opacity pressure/flow/weight overlay) and A/B compare mode
// (`data-compare-shot-id`, a second full dataset group at reduced opacity
// with a "(B)"-suffixed legend) — mirroring index.js's own datasets array
// construction (pressure/flow/weightFlow/weight/temp colors and the exact
// dash patterns/opacities for each of the three chart "layers": solid A,
// dashed [3,3] B at .65 alpha, dashed [2,3] ghost at .35 alpha) exactly.
// Only one of ghost/compare is ever active at once — templates/
// shots_detail.templ only ever sets one of the two data attributes, same
// as Node's own `!shotB` gate on computing a ghost shot at all.
//
// Data source: GET /api/shots/{id} (internal/shots/handlers.go's getShot)
// — already returns a shot's full datapoints/annotation/score, the exact
// same endpoint the JSON API's own consumers use, not a Go-only endpoint
// invented for this page. This module fetches its own token the same way
// static/live.js does (rather than reaching into glp-token.js's own
// module-private state), keeping this file a genuinely standalone module.
//
// Render trigger: templates/shots.templ's canvas
// (id="shotDetailChart", data-shot-id="<id>", optionally
// data-ghost-shot-id/data-compare-shot-id) exists either in GET /shots'
// own initial server-render, or in a GET /shots/{id} htmx fragment swapped
// into #shot-detail by a compact-row click — htmx does NOT execute a new
// <script src> for swapped-in content, so this module (loaded once, at the
// page level, like live.js) listens for htmx's own `htmx:afterSwap` event
// on #shot-detail and re-renders for whatever shot-id the swapped-in
// canvas now carries, in addition to rendering once on its own initial
// load for the server-rendered case.
/* global Chart */
(function () {
	"use strict";

	var glpToken = null;
	var chart = null;

	function fetchToken() {
		return fetch("api/token")
			.then(function (r) {
				return r.ok ? r.json() : null;
			})
			.then(function (body) {
				if (body && body.apiToken) glpToken = body.apiToken;
			})
			.catch(function () {
				// Network error, or expose_api_port=false with no Ingress:
				// stay tokenless — the api/shots/{id} fetch below then 401s,
				// same failure mode static/live.js's own fetchToken already
				// documents.
			});
	}

	function authedFetch(url) {
		var headers = glpToken ? { "X-GLP-Token": glpToken } : {};
		return fetch(url, { headers: headers });
	}

	function mapToXY(times, values) {
		var out = [];
		if (!times || !values) return out;
		for (var i = 0; i < times.length; i++) {
			if (values[i] == null) continue;
			out.push({ x: times[i] / 10, y: values[i] / 10 });
		}
		return out;
	}

	function maxOf(arr) {
		var m = 0;
		for (var i = 0; i < arr.length; i++) {
			if (arr[i] > m) m = arr[i];
		}
		return m;
	}

	// buildDatasets mirrors index.js's updateView() datasets array
	// construction exactly — see this file's own top-of-file doc comment
	// for the three-layer (solid A / dashed-.65-alpha B / dashed-.35-alpha
	// ghost) styling this reproduces.
	function buildDatasets(shotA, shotB, ghostShot) {
		var dpA = (shotA && shotA.datapoints) || {};
		var timesA = dpA.timeInShot || [];
		var sfx = shotB ? " (A)" : "";
		var datasets = [
			{ label: "Pressure" + sfx, data: mapToXY(timesA, dpA.pressure), yAxisID: "y", borderWidth: 2.5, tension: 0.1, borderColor: "#3498db", backgroundColor: "transparent", pointStyle: false },
			{ label: "Flow" + sfx, data: mapToXY(timesA, dpA.pumpFlow), yAxisID: "y", borderWidth: 2, tension: 0.1, borderColor: "#f39c12", backgroundColor: "transparent", pointStyle: false },
			{ label: "Weight flow" + sfx, data: mapToXY(timesA, dpA.weightFlow), yAxisID: "y", borderWidth: 2, tension: 0.1, borderColor: "#9b59b6", backgroundColor: "transparent", pointStyle: false },
			{ label: "Weight" + sfx, data: mapToXY(timesA, dpA.shotWeight || dpA.weight), yAxisID: "y1", borderWidth: 2, tension: 0.1, borderColor: "#2ecc71", backgroundColor: "transparent", pointStyle: false },
			{ label: "Temperature" + sfx, data: mapToXY(timesA, dpA.temperature), yAxisID: "y1", borderWidth: 2.5, tension: 0.1, borderColor: "#e74c3c", backgroundColor: "transparent", pointStyle: false }
		];

		if (!shotB) {
			datasets.push(
				{ label: "Target pressure", data: mapToXY(timesA, dpA.targetPressure), yAxisID: "y", borderDash: [5, 5], borderWidth: 1.5, tension: 0.1, borderColor: "#3498db", backgroundColor: "transparent", pointStyle: false },
				{ label: "Target flow", data: mapToXY(timesA, dpA.targetPumpFlow), yAxisID: "y", borderDash: [5, 5], borderWidth: 1.5, tension: 0.1, borderColor: "#f39c12", backgroundColor: "transparent", pointStyle: false },
				{ label: "Target temperature", data: mapToXY(timesA, dpA.targetTemperature), yAxisID: "y1", borderDash: [5, 5], borderWidth: 1.5, tension: 0.1, borderColor: "#e74c3c", backgroundColor: "transparent", pointStyle: false }
			);
		}

		if (shotB) {
			var dpB = shotB.datapoints || {};
			var timesB = dpB.timeInShot || [];
			datasets.push(
				{ label: "Pressure (B)", data: mapToXY(timesB, dpB.pressure), yAxisID: "y", borderDash: [3, 3], borderWidth: 2, tension: 0.1, borderColor: "rgba(52,152,219,.65)", backgroundColor: "transparent", pointStyle: false },
				{ label: "Flow (B)", data: mapToXY(timesB, dpB.pumpFlow), yAxisID: "y", borderDash: [3, 3], borderWidth: 1.5, tension: 0.1, borderColor: "rgba(243,156,18,.65)", backgroundColor: "transparent", pointStyle: false },
				{ label: "Weight flow (B)", data: mapToXY(timesB, dpB.weightFlow), yAxisID: "y", borderDash: [3, 3], borderWidth: 1.5, tension: 0.1, borderColor: "rgba(155,89,182,.65)", backgroundColor: "transparent", pointStyle: false },
				{ label: "Weight (B)", data: mapToXY(timesB, dpB.shotWeight || dpB.weight), yAxisID: "y1", borderDash: [3, 3], borderWidth: 1.5, tension: 0.1, borderColor: "rgba(46,204,113,.65)", backgroundColor: "transparent", pointStyle: false },
				{ label: "Temperature (B)", data: mapToXY(timesB, dpB.temperature), yAxisID: "y1", borderDash: [3, 3], borderWidth: 2, tension: 0.1, borderColor: "rgba(231,76,60,.65)", backgroundColor: "transparent", pointStyle: false }
			);
		}

		if (ghostShot) {
			var dpG = ghostShot.datapoints || {};
			var timesG = dpG.timeInShot || [];
			var ghostSfx = " (Shot " + ghostShot.id + ")";
			datasets.push(
				{ label: "Pressure" + ghostSfx, data: mapToXY(timesG, dpG.pressure), yAxisID: "y", borderDash: [2, 3], borderWidth: 1.5, tension: 0.1, borderColor: "rgba(52,152,219,.35)", backgroundColor: "transparent", pointStyle: false },
				{ label: "Flow" + ghostSfx, data: mapToXY(timesG, dpG.pumpFlow), yAxisID: "y", borderDash: [2, 3], borderWidth: 1.5, tension: 0.1, borderColor: "rgba(243,156,18,.35)", backgroundColor: "transparent", pointStyle: false },
				{ label: "Weight" + ghostSfx, data: mapToXY(timesG, dpG.shotWeight || dpG.weight), yAxisID: "y1", borderDash: [2, 3], borderWidth: 1.5, tension: 0.1, borderColor: "rgba(46,204,113,.35)", backgroundColor: "transparent", pointStyle: false }
			);
		}

		return datasets;
	}

	// maxTimeOf/maxTempOf compute the x/y1 axis bounds across every shot
	// actually drawn (A, plus B or the ghost shot when present) — mirrors
	// index.js's own Math.max(maxTempA, maxTempB) scaling, extended the same
	// way for the ghost case (a ghost pull's own last-sample time/max temp
	// must fit on the shared axes too).
	function lastTime(shot) {
		var times = (shot && shot.datapoints && shot.datapoints.timeInShot) || [];
		return times.length ? times[times.length - 1] / 10 : 0;
	}

	function maxTempOf(shot) {
		var vals = (shot && shot.datapoints && shot.datapoints.temperature) || [];
		return maxOf(vals) / 10;
	}

	function renderChart(canvas, shotA, shotB, ghostShot) {
		if (chart) {
			chart.destroy();
			chart = null;
		}
		var timesA = (shotA && shotA.datapoints && shotA.datapoints.timeInShot) || [];
		if (!timesA.length) return; // shots_detail.templ's HasChart gate already hides the canvas for this case; belt-and-suspenders.

		var maxTime = Math.max(lastTime(shotA), lastTime(shotB), lastTime(ghostShot));
		var maxTemp = Math.ceil(Math.max(maxTempOf(shotA), maxTempOf(shotB), maxTempOf(ghostShot)) + 5) || 100;

		chart = new Chart(canvas, {
			type: "line",
			data: {
				datasets: buildDatasets(shotA, shotB, ghostShot)
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: "index", intersect: false },
				plugins: {
					legend: { display: true, position: "bottom", labels: { color: "#a4a9ad", font: { size: 11 }, boxWidth: 12, padding: 8 } },
					tooltip: {
						callbacks: {
							title: function (ctx) {
								return "Time: " + ctx[0].parsed.x.toFixed(1) + "s";
							}
						}
					}
				},
				scales: {
					x: { type: "linear", min: 0, max: Math.max(maxTime, 5), ticks: { color: "#93989c" }, grid: { color: "#2b2f33" } },
					y: { type: "linear", position: "left", min: 0, max: 12, ticks: { color: "#93989c" }, grid: { color: "#2b2f33" } },
					y1: { type: "linear", position: "right", min: 0, max: maxTemp, ticks: { color: "#93989c" }, grid: { drawOnChartArea: false } }
				}
			}
		});
	}

	function fetchShot(id) {
		if (!id) return Promise.resolve(null);
		return authedFetch("api/shots/" + encodeURIComponent(id))
			.then(function (r) {
				return r.ok ? r.json() : null;
			})
			.catch(function () {
				return null; // same network-error handling as the rest of this module
			});
	}

	function renderForCanvas(canvas) {
		var id = canvas.getAttribute("data-shot-id");
		if (!id) return;
		var compareID = canvas.getAttribute("data-compare-shot-id");
		var ghostID = canvas.getAttribute("data-ghost-shot-id");

		Promise.all([fetchShot(id), fetchShot(compareID), fetchShot(ghostID)]).then(function (results) {
			var shotA = results[0];
			if (!shotA) return;
			renderChart(canvas, shotA, results[1], results[2]);
		});
	}

	function renderCurrent() {
		var canvas = document.getElementById("shotDetailChart");
		if (canvas && typeof Chart !== "undefined") renderForCanvas(canvas);
	}

	fetchToken().then(renderCurrent);

	document.body.addEventListener("htmx:afterSwap", function (evt) {
		if (evt.detail.target && evt.detail.target.id === "shot-detail") renderCurrent();
	});
})();
