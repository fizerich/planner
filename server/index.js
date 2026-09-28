require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const scheduler = require('./scheduler');
const { sendWhatsAppMessage, isConfigured } = require('./whatsapp');
const { computeStatus } = require('./licenseStatus');
const push = require('./push');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function nextId(prefix, state) {
  const key = '_idCounter';
  state[key] = (state[key] || 200) + 1;
  return prefix + state[key];
}

function publicState(s) {
  const { sentLog, _idCounter, pushSubscriptions, ...rest } = s;
  return {
    ...rest,
    whatsappConfigured: isConfigured(),
    pushConfigured: push.isConfigured(),
    pushSubscriptionCount: (pushSubscriptions || []).length,
  };
}

function fmtDate(s) {
  if (!s) return '';
  return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- health check (for Railway/Render) ----------
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ---------- state ----------
app.get('/api/state', async (req, res) => {
  await db.load();
  res.json(publicState(db.getState()));
});

app.put('/api/state/bulk-import', async (req, res) => {
  const ALLOWED_KEYS = ['clinics', 'licenseTypes', 'licenses', 'todos', 'ownerPhone', 'thresholds', 'managerPhones', 'settings', 'sheetUrl'];
  const patch = req.body || {};
  const state = await db.update((s) => {
    for (const k of ALLOWED_KEYS) if (patch[k] !== undefined) s[k] = patch[k];
    s.lastSynced = new Date().toLocaleTimeString();
  });
  res.json(publicState(state));
});

// ---------- settings ----------
app.patch('/api/settings', async (req, res) => {
  const { ownerPhone, thresholds, managerPhones, accentColor, dashboardLayout, sheetUrl, lastSynced } = req.body || {};
  const state = await db.update((s) => {
    if (ownerPhone !== undefined) s.ownerPhone = ownerPhone;
    if (thresholds !== undefined) s.thresholds = { ...s.thresholds, ...thresholds };
    if (managerPhones !== undefined) s.managerPhones = { ...s.managerPhones, ...managerPhones };
    if (accentColor !== undefined) s.settings.accentColor = accentColor;
    if (dashboardLayout !== undefined) s.settings.dashboardLayout = dashboardLayout;
    if (sheetUrl !== undefined) s.sheetUrl = sheetUrl;
    if (lastSynced !== undefined) s.lastSynced = lastSynced;
  });
  res.json(publicState(state));
});

// ---------- clinics ----------
app.post('/api/clinics', async (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  const state = await db.update((s) => {
    const id = nextId('clinic', s);
    s.clinics.push({ id, code: String(code).trim().toUpperCase(), name: String(name).trim() });
    s.managerPhones[id] = '';
  });
  res.json(publicState(state));
});

app.patch('/api/clinics/:id', async (req, res) => {
  const { code, name } = req.body || {};
  const state = await db.update((s) => {
    s.clinics = s.clinics.map((c) => (c.id === req.params.id ? { ...c, ...(code !== undefined ? { code } : {}), ...(name !== undefined ? { name } : {}) } : c));
  });
  res.json(publicState(state));
});

app.delete('/api/clinics/:id', async (req, res) => {
  const state = await db.update((s) => {
    s.clinics = s.clinics.filter((c) => c.id !== req.params.id);
    s.licenses = s.licenses.filter((l) => l.clinicId !== req.params.id);
    s.todos = s.todos.filter((t) => t.clinicId !== req.params.id);
    delete s.managerPhones[req.params.id];
  });
  res.json(publicState(state));
});

// ---------- license types ----------
app.post('/api/license-types', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const state = await db.update((s) => {
    s.licenseTypes.push({ id: nextId('lt', s), name: name.trim() });
  });
  res.json(publicState(state));
});

app.delete('/api/license-types/:id', async (req, res) => {
  const state = await db.update((s) => {
    s.licenseTypes = s.licenseTypes.filter((t) => t.id !== req.params.id);
  });
  res.json(publicState(state));
});

// ---------- licenses ----------
app.post('/api/licenses', async (req, res) => {
  const { clinicId, typeId, expiry, notes } = req.body || {};
  if (!clinicId || !typeId || !expiry) return res.status(400).json({ error: 'clinicId, typeId and expiry are required' });
  const state = await db.update((s) => {
    const lt = s.licenseTypes.find((t) => t.id === typeId);
    s.licenses.push({ id: nextId('l', s), clinicId, typeId, type: lt ? lt.name : 'License', expiry, notes: notes || '' });
  });
  res.json(publicState(state));
});

app.delete('/api/licenses/:id', async (req, res) => {
  const state = await db.update((s) => {
    s.licenses = s.licenses.filter((l) => l.id !== req.params.id);
  });
  res.json(publicState(state));
});

// ---------- todos ----------
app.post('/api/todos', async (req, res) => {
  const { text, clinicId, dueDate } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const state = await db.update((s) => {
    s.todos.push({ id: nextId('t', s), clinicId, text: text.trim(), done: false, dueDate: dueDate || '' });
  });
  res.json(publicState(state));
});

app.patch('/api/todos/:id', async (req, res) => {
  const { done } = req.body || {};
  const state = await db.update((s) => {
    s.todos = s.todos.map((t) => (t.id === req.params.id ? { ...t, done: done !== undefined ? done : !t.done } : t));
  });
  res.json(publicState(state));
});

app.delete('/api/todos/:id', async (req, res) => {
  const state = await db.update((s) => {
    s.todos = s.todos.filter((t) => t.id !== req.params.id);
  });
  res.json(publicState(state));
});

// ---------- reminders ----------
app.post('/api/reminders/send/:licenseId', async (req, res) => {
  await db.load();
  const s = db.getState();
  const license = s.licenses.find((l) => l.id === req.params.licenseId);
  if (!license) return res.status(404).json({ ok: false, error: 'License not found' });
  const clinic = s.clinics.find((c) => c.id === license.clinicId) || { code: '?', name: 'Unknown clinic' };
  const { daysLeft, key: statusKey } = computeStatus(license.expiry);
  const phone = s.managerPhones[license.clinicId] || s.ownerPhone;
  const text = 'Reminder: ' + license.type + ' at ' + clinic.name + ' (' + clinic.code + ') ' +
    (statusKey === 'overdue' ? 'is OVERDUE by ' + Math.abs(daysLeft) + ' day(s)' : 'expires in ' + daysLeft + ' day(s)') +
    ' — expiry date ' + fmtDate(license.expiry) + '. Please renew.';

  const result = await sendWhatsAppMessage(phone, text);
  const dayPhrase = statusKey === 'overdue' ? `${Math.abs(daysLeft)} day(s) overdue` : `${daysLeft} day(s) left`;

  const state = await db.update((st) => {
    if (result.ok) st.sentLog[`${license.id}:overdue:${new Date().toISOString().slice(0, 10)}`] = new Date().toISOString();
    st.activityLog = [{
      text: (result.ok ? 'Reminder sent — ' : 'Reminder FAILED — ') + clinic.name + ' ' + license.type + ' (' + dayPhrase + ')' + (result.ok ? '' : ': ' + result.error),
      when: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
      automated: false,
      ok: result.ok,
    }, ...st.activityLog].slice(0, 50);
  });

  res.json({ ok: result.ok, error: result.error, state: publicState(state) });
});

app.post('/api/reminders/test', async (req, res) => {
  await db.load();
  const s = db.getState();
  const text = 'Test reminder from SuperPlanner: this is what a license/task alert will look like.';
  const result = await sendWhatsAppMessage(s.ownerPhone, text);

  const state = await db.update((st) => {
    st.activityLog = [{
      text: result.ok ? 'Test reminder sent to owner' : 'Test reminder FAILED: ' + result.error,
      when: 'Just now',
      automated: false,
      ok: result.ok,
    }, ...st.activityLog].slice(0, 50);
  });

  res.json({ ok: result.ok, error: result.error, state: publicState(state) });
});

// ---------- push notifications ----------
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: push.getPublicKey() });
});

app.post('/api/push/subscribe', async (req, res) => {
  const subscription = req.body || {};
  if (!subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const state = await db.update((s) => {
    s.pushSubscriptions = s.pushSubscriptions.filter((sub) => sub.endpoint !== subscription.endpoint);
    s.pushSubscriptions.push(subscription);
  });
  res.json(publicState(state));
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  const state = await db.update((s) => {
    s.pushSubscriptions = s.pushSubscriptions.filter((sub) => sub.endpoint !== endpoint);
  });
  res.json(publicState(state));
});

app.post('/api/push/test', async (req, res) => {
  await db.load();
  const s = db.getState();
  if (!push.isConfigured()) return res.json({ ok: false, error: 'Push notifications not configured on the server (missing VAPID keys).' });
  if (!s.pushSubscriptions.length) return res.json({ ok: false, error: 'No device has enabled notifications yet.' });

  const { deadEndpoints } = await push.broadcastPush(s.pushSubscriptions, {
    title: '✦ SuperPlanner',
    body: 'Test notification — this is what a license/task alert will look like.',
  });
  const delivered = s.pushSubscriptions.length - deadEndpoints.length;

  const state = await db.update((st) => {
    if (deadEndpoints.length) st.pushSubscriptions = st.pushSubscriptions.filter((sub) => !deadEndpoints.includes(sub.endpoint));
    st.activityLog = [{
      text: delivered > 0 ? `Test push notification sent to ${delivered} device(s)` : 'Test push notification FAILED — no reachable devices',
      when: 'Just now',
      automated: false,
      ok: delivered > 0,
    }, ...st.activityLog].slice(0, 50);
  });

  res.json({ ok: delivered > 0, error: delivered > 0 ? null : 'Could not reach any subscribed device.', state: publicState(state) });
});

const PORT = process.env.PORT || 3000;

db.load().then(() => {
  scheduler.start();
  app.listen(PORT, () => {
    console.log(`Dental Planner server running on port ${PORT}`);
    if (!isConfigured()) {
      console.warn('WhatsApp Cloud API is not configured — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env to enable real sending. See SETUP.md.');
    }
    if (!push.isConfigured()) {
      console.warn('Web push is not configured — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env to enable push notifications. See SETUP.md.');
    }
  });
}).catch((err) => {
  console.error('[startup] Failed to load the database — server cannot start:', err);
  process.exit(1);
});
