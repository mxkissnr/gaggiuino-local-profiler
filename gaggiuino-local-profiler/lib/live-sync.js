// backward-compat re-export — import directly from preheat, sync or poll
module.exports = {
    ...require('./preheat'),
    ...require('./sync'),
    ...require('./poll'),
};
