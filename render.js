// Renders ./snapshot.json (written by the probe) into the page. Plain DOM, no
// framework, no build step — so GitHub Pages serves this file as-is and it keeps
// working even if everything else is on fire. All text goes in via textContent,
// never innerHTML, so a hostile field can never inject markup.

const OVERALL = {
  operational: { cls: 'op', headline: 'All systems operational' },
  degraded: { cls: 'deg', headline: 'Some services are degraded' },
  down: { cls: 'down', headline: "We're experiencing an outage" },
  maintenance: { cls: 'maint', headline: 'Maintenance in progress' },
};
const STATE = {
  operational: { cls: 'op', label: 'Operational' },
  degraded: { cls: 'deg', label: 'Degraded' },
  down: { cls: 'down', label: 'Down' },
  maintenance: { cls: 'maint', label: 'Maintenance' },
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const fmtTime = (iso) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  try { return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return new Date(t).toISOString(); }
};

function renderNote(snapshot) {
  const note = $('sp-note');
  if (snapshot.note) {
    note.textContent = snapshot.note;
    note.className = snapshot.appReachable ? 'warn' : 'bad';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderBanner(snapshot) {
  const meta = OVERALL[snapshot.overall] || OVERALL.operational;
  $('sp-banner').className = `sp-banner ${meta.cls}`;
  $('sp-headline').textContent = meta.headline;
  const stamp = snapshot.polledAt ? `Checked ${fmtTime(snapshot.polledAt)}` : '';
  const stale = snapshot.source === 'stale' ? ' · last known values' : '';
  $('sp-updated').textContent = stamp + stale;
}

function renderServices(snapshot) {
  const wrap = $('sp-services');
  wrap.replaceChildren();
  const services = Array.isArray(snapshot.services) ? snapshot.services : [];
  if (!services.length) {
    wrap.appendChild(el('div', 'sp-empty', 'Service status is temporarily unavailable.'));
    return;
  }
  for (const svc of services) {
    const st = STATE[svc.state] || STATE.operational;
    const row = el('div', 'sp-svc');
    row.appendChild(el('span', 'sp-svc-name', svc.label || svc.key));
    const right = el('span', 'sp-svc-right');
    if (typeof svc.uptime90d === 'number') right.appendChild(el('span', 'sp-uptime', `${svc.uptime90d.toFixed(2)}% · 90d`));
    const pill = el('span', `sp-pill ${st.cls}`);
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(st.label));
    right.appendChild(pill);
    row.appendChild(right);
    wrap.appendChild(row);
  }
}

function incidentCard(inc) {
  const card = el('article', 'sp-inc');
  const head = el('div', 'sp-inc-head');
  const left = el('div');
  left.appendChild(el('div', 'sp-inc-title', inc.title || 'Incident'));
  const scope = (inc.components || []).join(', ');
  if (scope) left.appendChild(el('div', 'sp-inc-scope', `Affected: ${scope}`));
  head.appendChild(left);
  const when = inc.resolvedAt || inc.startedAt || inc.scheduledStart;
  if (when) head.appendChild(el('div', 'sp-inc-date', fmtTime(when)));
  card.appendChild(head);
  for (const u of inc.updates || []) {
    const row = el('div', 'sp-u');
    row.appendChild(el('div', `sp-u-stage ${u.status}`, (u.status || '').replace(/_/g, ' ')));
    const body = el('div', 'sp-u-body', u.body || '');
    if (u.at) body.appendChild(el('time', 'sp-u-time', fmtTime(u.at)));
    row.appendChild(body);
    card.appendChild(row);
  }
  return card;
}

function renderIncidents(snapshot) {
  const incidents = Array.isArray(snapshot.incidents) ? snapshot.incidents : [];
  const active = incidents.filter((i) => !i.resolvedAt);
  const recent = incidents.filter((i) => i.resolvedAt).slice(0, 5);

  const activeWrap = $('sp-incidents');
  activeWrap.replaceChildren();
  $('sp-incidents-head').hidden = active.length === 0;
  active.forEach((i) => activeWrap.appendChild(incidentCard(i)));

  const recentWrap = $('sp-recent');
  recentWrap.replaceChildren();
  $('sp-recent-head').hidden = recent.length === 0;
  recent.forEach((i) => recentWrap.appendChild(incidentCard(i)));
}

async function load() {
  try {
    const res = await fetch(`./snapshot.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = await res.json();
    renderNote(snapshot);
    renderBanner(snapshot);
    renderServices(snapshot);
    renderIncidents(snapshot);
  } catch (err) {
    // The snapshot itself couldn't be read — say so plainly, don't imply all-clear.
    $('sp-banner').className = 'sp-banner deg';
    $('sp-headline').textContent = 'Status is temporarily unavailable';
    $('sp-updated').textContent = 'The status feed could not be loaded. Please retry shortly.';
    $('sp-services').replaceChildren();
    $('sp-foot-note').textContent = String(err && err.message ? err.message : err);
  }
}

load();
setInterval(load, 60_000);
