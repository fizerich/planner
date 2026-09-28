const cron = require('node-cron');
const db = require('./db');
const { computeStatus } = require('./licenseStatus');
const { sendWhatsAppMessage } = require('./whatsapp');

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

const THRESHOLD_DAYS = { d30: 30, d14: 14, d3: 3 };

/** One pass: finds licenses that just crossed an enabled threshold (or are overdue) and haven't
 * already been alerted for that crossing, sends a WhatsApp message, and logs the activity. */
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

  for (const send of sends) {
    const text = reminderText(send.license, send.clinic.name, send.clinic.code, send.daysLeft, send.isOverdue);
    const result = await sendWhatsAppMessage(send.phone, text);
    const dayPhrase = send.isOverdue ? `${Math.abs(send.daysLeft)} day(s) overdue` : `${send.daysLeft} day(s) left`;
    toLog.push({
      sentKey: send.sentKey,
      entry: {
        text: (result.ok ? 'Reminder sent — ' : 'Reminder FAILED — ') + send.clinic.name + ' ' + send.license.type + ' (' + dayPhrase + ')' + (result.ok ? '' : ': ' + result.error),
        when: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        automated: true,
        ok: result.ok,
      },
    });
  }

  if (toLog.length) {
    await db.update((s) => {
      for (const { sentKey, entry } of toLog) {
        if (entry.ok) s.sentLog[sentKey] = new Date().toISOString();
        s.activityLog = [entry, ...s.activityLog].slice(0, 50);
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
