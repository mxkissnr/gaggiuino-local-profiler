const axios = require('axios');
const { HA_API, HA_TOKEN } = require('./constants');
const { log } = require('./helpers');

async function getSwitchState(entity) {
    if (!HA_TOKEN || !entity) return null;
    try {
        const r = await axios.get(`${HA_API}/states/${entity}`,
            { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 3000 });
        return r.data.state === 'on';
    } catch (e) { return null; }
}

async function sendHaNotify(service, title, message, tag) {
    if (!HA_TOKEN || !service) return;
    const [domain, ...rest] = service.split('.');
    const svcName = rest.join('.');
    try {
        await axios.post(`${HA_API}/services/${domain}/${svcName}`,
            { title, message, data: { tag: tag || undefined, push: { sound: 'default' } } },
            { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 5000 });
    } catch (e) { log(`Notify ${service} failed: ${e.message}`); }
}

async function getNotifyServices() {
    if (!HA_TOKEN) return [];
    try {
        const r = await axios.get(`${HA_API}/services`,
            { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 5000 });
        const notifyDomain = r.data.find(d => d.domain === 'notify');
        if (!notifyDomain) return [];
        return Object.keys(notifyDomain.services)
            .filter(s => s !== 'notify' && s !== 'send_message')
            .map(s => ({ id: `notify.${s}`, name: s.replace(/_/g, ' ') }));
    } catch { return []; }
}

async function callHaService(domain, service, data) {
    if (!HA_TOKEN) throw new Error('HA token unavailable');
    const r = await axios.post(`${HA_API}/services/${domain}/${service}`, data,
        { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 5000 });
    return r.data;
}

async function getHaState(entityId) {
    if (!HA_TOKEN) throw new Error('HA token unavailable');
    const r = await axios.get(`${HA_API}/states/${entityId}`,
        { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 5000 });
    return r.data;
}

module.exports = { getSwitchState, sendHaNotify, getNotifyServices, callHaService, getHaState, HA_TOKEN };
