const webpush = require('web-push');

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

if (isConfigured()) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:owner@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/** Sends one push message to one subscription. Returns { ok, expired } —
 * expired means the subscription is dead (unsubscribed/uninstalled) and should be removed. */
async function sendPush(subscription, payload) {
  if (!isConfigured()) return { ok: false, error: 'Push notifications not configured (missing VAPID keys).' };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    const expired = err.statusCode === 404 || err.statusCode === 410;
    return { ok: false, expired, error: err.message };
  }
}

/** Sends to every stored subscription, in parallel; returns the endpoints that are dead so callers can prune them. */
async function broadcastPush(subscriptions, payload) {
  const deadEndpoints = [];
  await Promise.all(subscriptions.map(async (sub) => {
    const result = await sendPush(sub, payload);
    if (result.expired) deadEndpoints.push(sub.endpoint);
  }));
  return { deadEndpoints };
}

module.exports = { isConfigured, getPublicKey, sendPush, broadcastPush };
