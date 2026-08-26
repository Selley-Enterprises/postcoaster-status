// Renders the probe snapshot using the SAME markup + CSS as the in-app status
// page (src/status/ in the PostCoaster repo), so both surfaces look identical.
// status.css is copied verbatim from there — re-copy that one file to re-sync
// the design.
//
// In production the snapshot lives on the `data` branch (not `main`) so probe
// commits do not rebuild GitHub Pages. Locally we keep reading ./snapshot.json.
//
// Plain DOM, no framework, no build step: GitHub Pages serves this as-is, so the
// status page keeps working when everything else is on fire. All text goes in via
// textContent, never innerHTML, so a hostile field can never inject markup.

const STATE_COPY = {
  operational: {
    label: 'Operational',
    headline: 'All systems operational',
    detail: 'PostCoaster services are running normally.',
  },
  degraded: {
    label: 'Degraded',
    headline: 'Some systems are degraded',
    detail: 'A service is experiencing reduced performance. Follow the updates below.',
  },
  down: {
    label: 'Service interruption',
    headline: 'A service interruption is in progress',
    detail: 'We are working to restore normal service. Follow the incident timeline below.',
  },
  maintenance: {
    label: 'Maintenance',
    headline: 'Scheduled maintenance in progress',
    detail: 'Planned work is affecting one or more PostCoaster services.',
  },
};

const INCIDENT_STATUS_LABELS = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
};

const $ = (id) => document.getElementById(id);

const SNAPSHOT_REPO = 'Selley-Enterprises/postcoaster-status';
const SNAPSHOT_BRANCH = 'data';

function snapshotUrl() {
  const host = typeof location === 'undefined' ? '' : location.hostname;
  const local = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (local) return `./snapshot.json?t=${Date.now()}`;
  return `https://raw.githubusercontent.com/${SNAPSHOT_REPO}/${SNAPSHOT_BRANCH}/snapshot.json?t=${Date.now()}`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function formattedDate(value) {
  if (!value) return 'Time not available';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Time not available';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

function timeEl(value) {
  if (!value) return el('span', null, 'Time not available');
  const node = el('time', null, formattedDate(value));
  node.setAttribute('datetime', value);
  return node;
}

const stateCopy = (state) => STATE_COPY[state] || STATE_COPY.operational;
const incidentStatusLabel = (status) => INCIDENT_STATUS_LABELS[status] || status || '';

function componentLabels(incident, services) {
  const labels = (incident.components || []).map((key) => services.get(key)).filter(Boolean);
  return labels.length ? labels.join(' · ') : 'PostCoaster';
}

function emptyNotice(title, detail) {
  const wrap = el('div', 'pcs-empty');
  const check = el('span', 'pcs-empty-check', '✓');
  check.setAttribute('aria-hidden', 'true');
  wrap.appendChild(check);
  const body = el('div');
  body.appendChild(el('h3', null, title));
  body.appendChild(el('p', null, detail));
  wrap.appendChild(body);
  return wrap;
}

function sectionHeading(eyebrow, heading, aside) {
  const wrap = el('div', 'pcs-section-heading');
  const left = el('div');
  left.appendChild(el('p', 'pcs-eyebrow', eyebrow));
  left.appendChild(el('h2', null, heading));
  wrap.appendChild(left);
  if (aside) wrap.appendChild(el('span', null, aside));
  return wrap;
}

function serviceRow(service) {
  const article = el('article', 'pcs-service');
  article.dataset.state = service.state || 'operational';

  const title = el('div', 'pcs-service-title');
  const dot = el('span', 'pcs-state-dot');
  dot.setAttribute('aria-hidden', 'true');
  title.appendChild(dot);
  const titleBody = el('div');
  titleBody.appendChild(el('h3', null, service.label || service.key));
  titleBody.appendChild(el('p', null, stateCopy(service.state).label));
  title.appendChild(titleBody);
  article.appendChild(title);

  const uptime = typeof service.uptime90d === 'number' ? service.uptime90d : null;
  const wrap = el('div', 'pcs-uptime');
  const track = el('div', 'pcs-uptime-track');
  if (uptime !== null) {
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${service.label || service.key} 90-day uptime`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(uptime));
    const fill = el('span');
    fill.style.width = `${uptime}%`;
    track.appendChild(fill);
  }
  wrap.appendChild(track);
  wrap.appendChild(el('strong', null, uptime === null ? '—' : `${uptime.toFixed(uptime === 100 ? 0 : 2)}%`));
  article.appendChild(wrap);
  return article;
}

function cardTopline(incident, services, tone) {
  const line = el('div', 'pcs-card-topline');
  const pill = el('span', 'pcs-pill', incidentStatusLabel(incident.status));
  pill.dataset.tone = tone;
  line.appendChild(pill);
  line.appendChild(el('span', null, componentLabels(incident, services)));
  return line;
}

function maintenanceCard(incident, services) {
  const card = el('article', 'pcs-maintenance-card');
  card.appendChild(cardTopline(incident, services, 'maintenance'));
  card.appendChild(el('h3', null, incident.title || 'Scheduled maintenance'));
  const window_ = el('p', 'pcs-window');
  window_.appendChild(timeEl(incident.scheduledStart));
  const arrow = el('span', null, ' → ');
  arrow.setAttribute('aria-hidden', 'true');
  window_.appendChild(arrow);
  window_.appendChild(timeEl(incident.scheduledEnd));
  card.appendChild(window_);
  const latest = (incident.updates || [])[0];
  if (latest && latest.body) card.appendChild(el('p', 'pcs-maintenance-note', latest.body));
  return card;
}

function incidentCard(incident, services) {
  const card = el('article', 'pcs-incident-card');
  card.appendChild(cardTopline(incident, services, incident.resolvedAt ? 'resolved' : incident.impact || 'minor'));
  card.appendChild(el('h4', null, incident.title || 'Incident'));

  const time = el('p', 'pcs-incident-time', incident.resolvedAt ? 'Resolved ' : 'Started ');
  time.appendChild(timeEl(incident.resolvedAt || incident.startedAt));
  card.appendChild(time);

  const updates = incident.updates || [];
  if (updates.length) {
    const list = el('ol', 'pcs-timeline');
    list.setAttribute('aria-label', `${incident.title || 'Incident'} timeline`);
    for (const update of updates) {
      const item = el('li');
      const marker = el('span', 'pcs-timeline-marker');
      marker.setAttribute('aria-hidden', 'true');
      item.appendChild(marker);
      const body = el('div');
      const head = el('div');
      head.appendChild(el('strong', null, incidentStatusLabel(update.status)));
      if (update.at) head.appendChild(timeEl(update.at));
      body.appendChild(head);
      body.appendChild(el('p', null, update.body || ''));
      item.appendChild(body);
      list.appendChild(item);
    }
    card.appendChild(list);
  }
  return card;
}

function renderSnapshot(snapshot) {
  const body = $('pcs-body');
  body.replaceChildren();

  const allServices = Array.isArray(snapshot.services) ? snapshot.services : [];
  const allIncidents = Array.isArray(snapshot.incidents) ? snapshot.incidents : [];
  const services = new Map(allServices.map((s) => [s.key, s.label]));

  // The probe's honest-failure message (app unreachable / showing last known)
  // reuses the in-app "stale snapshot" banner slot.
  if (snapshot.note) body.appendChild(el('div', 'pcs-stale', snapshot.note));

  const copy = stateCopy(snapshot.overall);
  const overall = el('section', 'pcs-overall');
  overall.dataset.state = snapshot.overall || 'operational';
  overall.setAttribute('aria-labelledby', 'overall-heading');
  const icon = el('span', 'pcs-overall-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(el('i'));
  overall.appendChild(icon);
  const overallBody = el('div');
  overallBody.appendChild(el('p', null, copy.label));
  const h2 = el('h2', null, copy.headline);
  h2.id = 'overall-heading';
  overallBody.appendChild(h2);
  overallBody.appendChild(el('span', null, copy.detail));
  overall.appendChild(overallBody);
  body.appendChild(overall);

  // Key services
  const servicesSection = el('section', 'pcs-section');
  servicesSection.appendChild(sectionHeading('Current state', 'Key services', '90-day uptime'));
  if (allServices.length) {
    const list = el('div', 'pcs-service-list');
    allServices.forEach((service) => list.appendChild(serviceRow(service)));
    servicesSection.appendChild(list);
  } else {
    servicesSection.appendChild(emptyNotice('Service detail unavailable', 'The latest per-service snapshot could not be read.'));
  }
  body.appendChild(servicesSection);

  // Scheduled maintenance
  const maintenance = allIncidents.filter((i) => i.isMaintenance && !i.resolvedAt);
  const maintenanceSection = el('section', 'pcs-section');
  maintenanceSection.appendChild(sectionHeading('Planned work', 'Scheduled maintenance'));
  if (maintenance.length) {
    const list = el('div', 'pcs-maintenance-list');
    maintenance.forEach((incident) => list.appendChild(maintenanceCard(incident, services)));
    maintenanceSection.appendChild(list);
  } else {
    maintenanceSection.appendChild(emptyNotice('No maintenance scheduled', 'There are no active maintenance windows.'));
  }
  body.appendChild(maintenanceSection);

  // Incidents
  const incidents = allIncidents.filter((i) => !i.isMaintenance);
  const active = incidents.filter((i) => !i.resolvedAt);
  const recent = incidents.filter((i) => i.resolvedAt);
  const incidentsSection = el('section', 'pcs-section');
  incidentsSection.appendChild(sectionHeading('Latest updates', 'Incidents', active.length ? `${active.length} active` : 'None active'));
  if (incidents.length) {
    const groups = el('div', 'pcs-incident-groups');
    if (active.length) {
      const group = el('div', 'pcs-incident-group');
      group.appendChild(el('h3', null, 'Active incidents'));
      active.forEach((incident) => group.appendChild(incidentCard(incident, services)));
      groups.appendChild(group);
    }
    if (recent.length) {
      const group = el('div', 'pcs-incident-group');
      group.appendChild(el('h3', null, 'Recent incidents'));
      recent.forEach((incident) => group.appendChild(incidentCard(incident, services)));
      groups.appendChild(group);
    }
    incidentsSection.appendChild(groups);
  } else {
    incidentsSection.appendChild(emptyNotice('No incidents reported', 'No active or recently resolved incidents appear in this snapshot.'));
  }
  body.appendChild(incidentsSection);

  const updated = $('pcs-updated');
  updated.replaceChildren(document.createTextNode('Snapshot updated '), timeEl(snapshot.polledAt));
}

function renderUnavailable(message) {
  const body = $('pcs-body');
  body.replaceChildren();
  const section = el('section', 'pcs-error');
  section.setAttribute('role', 'alert');
  section.appendChild(el('p', 'pcs-eyebrow', 'Snapshot unavailable'));
  section.appendChild(el('h2', null, 'We could not load the status page'));
  section.appendChild(el('p', null, 'Try again shortly. This does not necessarily mean PostCoaster services are unavailable.'));
  if (message) section.appendChild(el('p', 'pcs-maintenance-note', message));
  body.appendChild(section);
  $('pcs-updated').textContent = '';
}

async function load() {
  try {
    const res = await fetch(snapshotUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderSnapshot(await res.json());
  } catch (err) {
    renderUnavailable(err && err.message ? err.message : String(err));
  }
}

load();
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, 60_000);
