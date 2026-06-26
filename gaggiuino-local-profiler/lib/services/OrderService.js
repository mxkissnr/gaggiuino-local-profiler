const repo = require('../repositories/OrderRepository');

class OrderService {
    getActiveOrders()              { return repo.findActive(); }
    getOrder(id)                   { return repo.findById(id); }
    saveOrder(order)               { return repo.save(order); }
    getMenu()                      { return repo.getMenu(); }
    saveMenu(menu)                 { return repo.saveMenu(menu); }
    getSettings()                  { return repo.getSettings(); }
    saveSettings(s)                { return repo.saveSettings(s); }
    getNotifyMapping()             { return repo.getNotifyMapping(); }
    saveNotifyMapping(m)           { return repo.saveNotifyMapping(m); }
    isEnabled(opts)                { return !!opts?.enable_orders; }
}

module.exports = new OrderService();
