import { S } from '../state.js';
import { setMobileShotSubview, updateMobileShotSidebarVisibility } from './sidebar.js';

export function goToShot(id) {
  switchMode('shots');
  if (window.selectShot) window.selectShot(id);
  // #410: jumping here from elsewhere (e.g. an analytics "personal best"
  // link) means straight to that shot's detail, not the list — mirrors the
  // shot-row tap in sidebar.js.
  if (window.innerWidth <= 768) setMobileShotSubview('detail');
  setTimeout(() => {
    const el = document.getElementById(`wrapper-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

export function switchMode(mode) {
  S.currentMode = mode;
  document.getElementById('btnShots').classList.toggle('active',       mode === 'shots');
  document.getElementById('btnLive').classList.toggle('active',        mode === 'live');
  document.getElementById('btnAnalytics').classList.toggle('active',   mode === 'analytics');
  document.getElementById('btnDialin').classList.toggle('active',      mode === 'dialin');
  document.getElementById('btnLibrary').classList.toggle('active',     mode === 'library');
  document.getElementById('btnMaintenance').classList.toggle('active', mode === 'maintenance');
  document.getElementById('btnOrders').classList.toggle('active',      mode === 'orders');
  document.getElementById('btnSettings').classList.toggle('active',    mode === 'settings');

  // Bottom nav (#403, mobile) — mirrors the rail's active state above;
  // dialin/maintenance/orders/settings all collapse under "Mehr" there.
  const moreModes = mode === 'dialin' || mode === 'maintenance' || mode === 'orders' || mode === 'settings';
  document.getElementById('bnShots').classList.toggle('active',     mode === 'shots');
  document.getElementById('bnLive').classList.toggle('active',      mode === 'live');
  document.getElementById('bnLibrary').classList.toggle('active',   mode === 'library');
  document.getElementById('bnAnalytics').classList.toggle('active', mode === 'analytics');
  document.getElementById('bnMore').classList.toggle('active',      moreModes);

  document.getElementById('shots-view').style.display       = mode === 'shots'       ? 'flex' : 'none';
  document.getElementById('live-view').style.display        = mode === 'live'        ? 'flex' : 'none';
  document.getElementById('analytics-view').style.display   = mode === 'analytics'   ? 'flex' : 'none';
  document.getElementById('dialin-view').style.display      = mode === 'dialin'      ? 'flex' : 'none';
  document.getElementById('library-view').style.display     = mode === 'library'     ? 'flex' : 'none';
  document.getElementById('maintenance-view').style.display = mode === 'maintenance' ? 'flex' : 'none';
  document.getElementById('orders-view').style.display      = mode === 'orders'      ? 'flex' : 'none';
  document.getElementById('settings-view').style.display    = mode === 'settings'    ? 'flex' : 'none';

  if (mode === 'live') {
    if (window.populateRefSelector) window.populateRefSelector();
    if (window.connectLiveStream) window.connectLiveStream();
  } else {
    if (window.disconnectLiveStream) window.disconnectLiveStream();
  }
  if (mode === 'analytics')   { if (window.initAnalytics) window.initAnalytics(); }
  if (mode === 'dialin')      { if (window.renderDialin) window.renderDialin(); }
  if (mode === 'library')     {
    if (window.renderBeanList) window.renderBeanList();
    if (window.renderGrinderList) window.renderGrinderList();
  }
  if (mode === 'maintenance') { if (window.loadMaintenanceView) window.loadMaintenanceView(); }
  // #334: re-render on every entry so the per-machine shot count reflects
  // S.allShots as of now, not whatever it was at the initial loadMachines()
  // call (which can race loadData() on startup — see #333).
  if (mode === 'settings')    { if (window.renderMachinesList) window.renderMachinesList(); }
  if (mode === 'orders') {
    if (window.loadOrdersView) window.loadOrdersView();
    if (window.startOrdersPolling) window.startOrdersPolling();
  } else {
    if (window.stopOrdersPolling) window.stopOrdersPolling();
  }

  const modeMap = {
    shots: 'btnShots', live: 'btnLive', analytics: 'btnAnalytics',
    dialin: 'btnDialin', library: 'btnLibrary', maintenance: 'btnMaintenance',
    orders: 'btnOrders', settings: 'btnSettings'
  };
  const activeBtn = document.getElementById(modeMap[mode]);
  if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

  // #410: mobile shows #sidebar (shot list) only while mode === 'shots' and
  // the mobile sub-view isn't 'detail' — re-evaluate on every mode switch,
  // e.g. so leaving Shots for Library hides the list underneath it too.
  updateMobileShotSidebarVisibility();
}
