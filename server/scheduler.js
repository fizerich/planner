const cron = require('node-cron');
const db = require('./db');
const { computeStatus } = require('./licenseStatus');
const { sendWhatsAppMessage, isConfigured: whatsappConfigured } = require('./whatsapp');
const push = require('./push');

function fmtDate(s) {
  if (!s) return '';
  return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function reminderText(license, clinicName, clinicCode, daysLeft, isOverdue) {
  return 'Reminder: ' + license.type + ' at ' + clinicName + ' (' + clinicCode + ') ' +
    (isOverdue ? 'is OVERDUE by ' + Math.abs(daysLeft) + ' day(s)' : 'expires in ' + daysLeft + ' day(s)') +
    ' — expiry date ' + fmtDate(license.expiry) + '. Please renew.';
}

const THRESHOLD_DAYS = { d30: 30, d14: 14, d1: 1 };

/** One pass: finds licenses that just crossed an enabled threshold (or are overdue) and haven't
 * already been alerted for that crossing, sends a push notification (and WhatsApp if configured),
 * and logs the activity. */
async function runReminderCheck() {
  const state = db.getState();
  const enabledThresholds = Object.entries(THRESHOLD_DAYS)
    .filter(([key]) => state.thresholds[key])
    .sort((a, b) => b[1] - a[1]); // largest window first

  const toLog = [];
  const sends = [];

  for (const license of state.licenses) {
    const clinic = state.clinics.find((c) => c.id === license.clinicId) || { code: '?', name: 'Unknown clinic' };
    const { daysLeft, key: statusKey } = computeStatus(license.expiry);
    const phone = state.managerPhones[license.clinicId] || state.ownerPhone;

    if (statusKey === 'overdue') {
      const sentKey = `${license.id}:overdue:${todayKey()}`;
      if (!state.sentLog[sentKey]) {
        sends.push({ sentKey, phone, license, clinic, daysLeft, isOverdue: true });
      }
      continue;
    }

    for (const [thresholdKey, thresholdDays] of enabledThresholds) {
      if (daysLeft <= thresholdDays) {
        const sentKey = `${license.id}:${thresholdKey}`;
        if (!state.sentLog[sentKey]) {
          sends.push({ sentKey, phone, license, clinic, daysLeft, isOverdue: false });
        }
        break; // only the nearest applicable threshold per run
      }
    }
  }

  const pushConfigured = push.isConfigured() && state.pushSubscriptions.length > 0;

  for (const send of sends) {
    const text = reminderText(send.license, send.clinic.name, send.clinic.code, send.daysLeft, send.isOverdue);
    const dayPhrase = send.isOverdue ? `${Math.abs(send.daysLeft)} day(s) overdue` : `${send.daysLeft} day(s) left`;

    let pushOk = false;
    let deadEndpoints = [];
    if (pushConfigured) {
      const result = await push.broadcastPush(state.pushSubscriptions, {
        title: send.isOverdue ? '⚠️ License overdue' : '⏰ License expiring soon',
        body: send.clinic.name + ' — ' + send.license.type + ' (' + dayPhrase + ')',
      });
      deadEndpoints = result.deadEndpoints;
      pushOk = deadEndpoints.length < state.pushSubscriptions.length; // at least one live subscription got it
    }

    // WhatsApp send is independent/optional; sendWhatsAppMessage itself no-ops gracefully if not configured.
    const waResult = await sendWhatsAppMessage(send.phone, text);
    const waOk = waResult.ok;
    const waError = waResult.error;

    const ok = pushOk || waOk;
    const channels = [pushOk ? 'push' : null, waOk ? 'WhatsApp' : null].filter(Boolean);
    let failureNote = '';
    if (!ok) {
      if (!push.isConfigured() && !whatsappConfigured()) failureNote = 'no notification channel set up yet — see Settings';
      else if (push.isConfigured() && !pushConfigured) failureNote = 'no devices have enabled push notifications yet';
      else failureNote = waError || 'send failed';
    }

    toLog.push({
      sentKey: send.sentKey,
      deadEndpoints,
      entry: {
        text: (ok ? 'Reminder sent (' + channels.join(' + ') + ') — ' : 'Reminder FAILED — ') +
          send.clinic.name + ' ' + send.license.type + ' (' + dayPhrase + ')' +
          (!ok ? ': ' + failureNote : ''),
        when: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        automated: true,
        ok,
      },
    });
  }

  if (toLog.length) {
    await db.update((s) => {
      const allDeadEndpoints = new Set();
      for (const { sentKey, entry, deadEndpoints } of toLog) {
        if (entry.ok) s.sentLog[sentKey] = new Date().toISOString();
        s.activityLog = [entry, ...s.activityLog].slice(0, 50);
        (deadEndpoints || []).forEach((e) => allDeadEndpoints.add(e));
      }
      if (allDeadEndpoints.size) {
        s.pushSubscriptions = s.pushSubscriptions.filter((sub) => !allDeadEndpoints.has(sub.endpoint));
      }
    });
  }

  return toLog;
}

function start() {
  // Daily at 08:00 server time — matches the "Owner alerted ... " schedule shown in the app.
  cron.schedule('0 8 * * *', () => {
    runReminderCheck().catch((err) => console.error('[scheduler] reminder check failed:', err));
  });

  // Also run shortly after startup so a freshly-deployed/restarted server doesn't wait until
  // the next 8am to catch anything already due.
  setTimeout(() => {
    runReminderCheck().catch((err) => console.error('[scheduler] startup reminder check failed:', err));
  }, 10_000);
}

module.exports = { start, runReminderCheck };
