const { log } = require('../helpers');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    const status  = err.status ?? err.statusCode ?? 500;
    const message = err.message ?? 'Internal server error';
    if (status >= 500) log(`[${req.method} ${req.path}] ${message}`, true);
    res.status(status).json({ error: message });
}

module.exports = { errorHandler };
