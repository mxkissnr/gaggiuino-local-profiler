const { log } = require('../helpers');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    const status = err.status ?? err.statusCode ?? 500;
    // 5xx messages can leak internal details (paths, DB errors) — log the
    // real message server-side but return a generic one to the client.
    if (status >= 500) {
        log(`[${req.method} ${req.path}] ${err.message ?? 'Internal server error'}`, true);
        return res.status(status).json({ error: 'Internal server error' });
    }
    res.status(status).json({ error: err.message ?? 'Bad request' });
}

module.exports = { errorHandler };
