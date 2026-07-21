const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// ── App-level rate limiter (CodeQL js/missing-rate-limiting, #3-#7) ────────
//
// GLP is a single-household LAN/HA-Ingress app, not a public service, so this
// is a light-touch backstop against runaway clients/bugs rather than a real
// abuse defense. Real traffic patterns this must clear with headroom:
//   - /api/status polled every 30s                        (~2 req/min)
//   - live view polling every ~1s during a brew            (~60 req/min)
//   - preheat polling every 10s during a brew               (~6 req/min)
//   - HA integration sensor polling
//   - bursts of shot/bean/grinder image requests when a list/gallery renders
// Sustained worst case for one active browser tab is well under 100 req/min;
// 600 req/min (10 req/s sustained) leaves 6-10x headroom over that while
// still capping a runaway loop or scripted abuse.
//
// Key/trust-proxy: server.js does NOT call app.set('trust proxy', ...) — the
// app deliberately trusts only the raw socket address (see isFromSupervisor
// in server.js), never client-supplied X-Forwarded-For headers, to prevent
// header spoofing from LAN clients hitting the direct port. That means every
// request that arrives via HA Ingress presents the same socket address (the
// Supervisor's internal proxy), so all Ingress traffic shares one bucket
// regardless of how many browsers/users are behind it — that's the honest
// picture of what this deployment can distinguish, and 600/min per bucket
// already assumes a single shared bucket. Direct LAN access (port 8099,
// bypassing Ingress) gets its own bucket per real client IP as normal.
const RATE_LIMIT_WINDOW_MS = Number(process.env.GLP_RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX       = Number(process.env.GLP_RATE_LIMIT_MAX) || 600;

function createApiRateLimiter() {
    return rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        limit: RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        // No client ever legitimately serves traffic through GLP itself, so
        // trusting only the raw connection address (not XFF) is correct here
        // too — mirrors server.js's own trust model instead of relying on
        // Express's `trust proxy` setting.
        keyGenerator: (req) => ipKeyGenerator(req.socket?.remoteAddress || req.ip),
        // Never throttle the built JS/CSS bundle (public/assets/, content-hashed
        // by Vite) — only API and page routes count against the budget.
        skip: (req) => req.path.startsWith('/assets/'),
        handler: (req, res) => {
            res.status(429).json({ error: 'Too many requests' });
        },
    });
}

module.exports = { createApiRateLimiter, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX };
