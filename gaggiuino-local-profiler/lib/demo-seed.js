// Static demo dataset for first-run onboarding (#274). Pure module — no DB,
// no lib/state.js — so it can be unit tested and reused by DemoService
// without pulling in any side-effecting dependency (see lib/score.js for the
// same pattern).
//
// IDs are namespaced in a high range that a real Gaggiuino machine (which
// hands out small sequential shot IDs) will never produce, so demo rows are
// trivially distinguishable and never collide with real data.
const DEMO_ID_BASE = 900_000_000;

// Curve helper: builds a plausible espresso-shot datapoints object.
// timeInShot in tenths of a second (0.1 s steps), pressure/temperature/
// weight in tenths of their unit — matches the shape produced by
// lib/poll.js's liveAccum and stored by ShotRepository.
function buildCurve({ seconds, peakPressure, targetTemp, doseG, yieldG }) {
    const steps = Math.round(seconds * 10);
    const timeInShot = [], pressure = [], temperature = [], shotWeight = [],
          weightFlow = [], pumpFlow = [], targetTemperature = [];
    let prevWeight = 0;
    for (let i = 0; i <= steps; i++) {
        const t = i / 10; // seconds
        const rampUp   = Math.min(1, t / 4);
        const rampDown = t > seconds - 5 ? Math.max(0, (seconds - t) / 5) : 1;
        const p = peakPressure * rampUp * rampDown;
        const temp = targetTemp - 0.4 + Math.sin(t / 3) * 0.3;
        const progress = Math.min(1, t / seconds);
        const weight = Math.round(yieldG * Math.pow(progress, 1.3) * 10) / 10;
        const flow = Math.max(0, weight - prevWeight);
        prevWeight = weight;

        timeInShot.push(Math.round(t * 10));
        pressure.push(Math.round(p * 10));
        temperature.push(Math.round(temp * 10));
        shotWeight.push(Math.round(weight * 10));
        weightFlow.push(Math.round(flow * 10));
        pumpFlow.push(Math.round(Math.max(0, p * 0.9) * 10));
        targetTemperature.push(Math.round(targetTemp * 10));
    }
    return { timeInShot, pressure, temperature, shotWeight, weightFlow, pumpFlow, targetTemperature };
}

// Shot definitions: [dayOffset, secondsAgo-ish info baked into timestamp by caller],
// dose/yield/rating/tds vary to make analytics/flavor views non-empty.
const SHOT_DEFS = [
    { daysAgo: 21, seconds: 28, dose: 18,   yieldG: 36,  temp: 93,  peak: 9.2, coffee: 'GLP Demo — Ethiopia Yirgacheffe', profile: 'Demo Profile 1', rating: 5, tds: 9.4, grind: '18 clicks' },
    { daysAgo: 20, seconds: 30, dose: 18,   yieldG: 38,  temp: 93,  peak: 9.0, coffee: 'GLP Demo — Ethiopia Yirgacheffe', profile: 'Demo Profile 1', rating: 4, tds: 9.1, grind: '18 clicks' },
    { daysAgo: 18, seconds: 27, dose: 18.2, yieldG: 34,  temp: 92,  peak: 9.4, coffee: 'GLP Demo — Ethiopia Yirgacheffe', profile: 'Demo Profile 1', rating: 4, tds: 9.6, grind: '17 clicks' },
    { daysAgo: 15, seconds: 32, dose: 18,   yieldG: 44,  temp: 94,  peak: 8.7, coffee: 'GLP Demo — Brasil/Ethiopia Blend', profile: 'Demo Profile 2', rating: 5, tds: 8.8, grind: '20 clicks' },
    { daysAgo: 13, seconds: 31, dose: 18.5, yieldG: 42,  temp: 94,  peak: 8.9, coffee: 'GLP Demo — Brasil/Ethiopia Blend', profile: 'Demo Profile 2', rating: 3, tds: 8.5, grind: '20 clicks' },
    { daysAgo: 10, seconds: 29, dose: 18,   yieldG: 37,  temp: 93,  peak: 9.1, coffee: 'GLP Demo — Brasil/Ethiopia Blend', profile: 'Demo Profile 2', rating: 4, tds: 9.0, grind: '19 clicks' },
    { daysAgo: 8,  seconds: 26, dose: 17.8, yieldG: 33,  temp: 92,  peak: 9.5, coffee: 'GLP Demo — Colombia Decaf', profile: 'Demo Profile 3', rating: 4, tds: 9.7, grind: '16 clicks' },
    { daysAgo: 6,  seconds: 33, dose: 18,   yieldG: 45,  temp: 94,  peak: 8.6, coffee: 'GLP Demo — Colombia Decaf', profile: 'Demo Profile 3', rating: 3, tds: 8.3, grind: '21 clicks' },
    { daysAgo: 4,  seconds: 28, dose: 18.2, yieldG: 36,  temp: 93,  peak: 9.2, coffee: 'GLP Demo — Ethiopia Yirgacheffe', profile: 'Demo Profile 1', rating: 5, tds: 9.5, grind: '18 clicks' },
    { daysAgo: 2,  seconds: 30, dose: 18,   yieldG: 40,  temp: 93,  peak: 9.0, coffee: 'GLP Demo — Brasil/Ethiopia Blend', profile: 'Demo Profile 2', rating: 4, tds: 9.0, grind: '19 clicks' },
    { daysAgo: 1,  seconds: 29, dose: 18,   yieldG: 38,  temp: 93,  peak: 9.1, coffee: 'GLP Demo — Ethiopia Yirgacheffe', profile: 'Demo Profile 1', rating: 5, tds: 9.3, grind: '18 clicks' },
    { daysAgo: 0,  seconds: 31, dose: 18.3, yieldG: 41,  temp: 94,  peak: 8.9, coffee: 'GLP Demo — Colombia Decaf', profile: 'Demo Profile 3', rating: 4, tds: 8.9, grind: '20 clicks' },
];

// Builds the full demo dataset with fresh, deterministic-per-call timestamps
// (relative to "now") so the shot list always looks recent when demo mode
// is (re-)activated.
function buildDemoDataset(now = Date.now()) {
    const nowSec = Math.floor(now / 1000);
    const DAY = 86400;

    const shots = SHOT_DEFS.map((def, i) => {
        const id = DEMO_ID_BASE + i + 1;
        const datapoints = buildCurve({
            seconds: def.seconds, peakPressure: def.peak, targetTemp: def.temp,
            doseG: def.dose, yieldG: def.yieldG,
        });
        return {
            id,
            timestamp: nowSec - def.daysAgo * DAY - (SHOT_DEFS.length - i) * 3600,
            duration:  Math.round(def.seconds * 10),
            profileName: def.profile,
            datapoints,
            annotation: {
                coffee:       def.coffee,
                grindSetting: def.grind,
                dose:         def.dose,
                tds:          def.tds,
                rating:       def.rating,
                notes:        'Demo shot — generated by GLP demo mode.',
            },
        };
    });

    const beans = [
        {
            id: DEMO_ID_BASE + 101,
            name: 'GLP Demo — Ethiopia Yirgacheffe',
            roaster: 'GLP Demo Roastery',
            roastDate: new Date(now - 10 * DAY * 1000).toISOString().slice(0, 10),
            notes: 'Sample bean seeded by GLP demo mode.',
            origin: 'ET',
            origins: [{ code: 'ET' }],
            variety: 'Heirloom',
            process: 'Washed',
            flavors: ['Bergamot', 'Blueberry', 'Black Tea'],
            roastType: 'filter',
            stock_g: 250,
            decaf: false,
            bags: [{ id: DEMO_ID_BASE + 201, roastDate: new Date(now - 10 * DAY * 1000).toISOString().slice(0, 10), stock_g: 250, openedAt: now - 20 * DAY * 1000 }],
        },
        {
            id: DEMO_ID_BASE + 102,
            name: 'GLP Demo — Brasil/Ethiopia Blend',
            roaster: 'GLP Demo Roastery',
            roastDate: new Date(now - 15 * DAY * 1000).toISOString().slice(0, 10),
            notes: 'Blend example — demonstrates origins[] with per-country percent.',
            origin: 'BR',
            origins: [{ code: 'BR', percent: 60 }, { code: 'ET', percent: 40 }],
            variety: 'Bourbon / Heirloom',
            process: 'Natural',
            flavors: ['Chocolate', 'Hazelnut', 'Caramel'],
            roastType: 'espresso',
            stock_g: 500,
            decaf: false,
            bags: [{ id: DEMO_ID_BASE + 202, roastDate: new Date(now - 15 * DAY * 1000).toISOString().slice(0, 10), stock_g: 500, openedAt: now - 15 * DAY * 1000 }],
        },
        {
            id: DEMO_ID_BASE + 103,
            name: 'GLP Demo — Colombia Decaf',
            roaster: 'GLP Demo Roastery',
            roastDate: new Date(now - 8 * DAY * 1000).toISOString().slice(0, 10),
            notes: 'Decaf sample bean.',
            origin: 'CO',
            origins: [{ code: 'CO' }],
            variety: 'Castillo',
            process: 'Washed (Sugarcane EA Decaf)',
            flavors: ['Walnut', 'Brown Sugar'],
            roastType: 'espresso',
            stock_g: 250,
            decaf: true,
            bags: [{ id: DEMO_ID_BASE + 203, roastDate: new Date(now - 8 * DAY * 1000).toISOString().slice(0, 10), stock_g: 250, openedAt: now - 8 * DAY * 1000 }],
        },
    ];

    const recipes = [
        {
            id: DEMO_ID_BASE + 301,
            name: 'GLP Demo — Balanced Espresso',
            brewMethod: 'espresso',
            drinkType: 'espresso',
            grindSize: '18 clicks',
            sourceUrl: '',
            steps: [
                { text: '18g in, 45g out, 30s — 1:2.5 ratio', duration_s: 30 },
                { text: 'Preheat portafilter, tamp evenly', duration_s: null },
            ],
            notes: 'Demo recipe seeded by GLP demo mode.',
            profileName: 'Demo Profile 1',
            beanName: 'GLP Demo — Ethiopia Yirgacheffe',
        },
    ];

    return { shots, beans, recipes };
}

module.exports = { buildDemoDataset, DEMO_ID_BASE };
