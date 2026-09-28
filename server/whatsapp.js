const GRAPH_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

function isConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function toWhatsAppId(phone) {
  return (phone || '').replace(/\D/g, '');
}

/**
 * Sends a WhatsApp message via the Meta Cloud API.
 *
 * Meta only allows free-form "text" messages inside the 24h window opened by
 * the recipient messaging your business number first. Automated reminders
 * fired by the scheduler are business-initiated, so outside that window Meta
 * requires a pre-approved message template instead. If WHATSAPP_TEMPLATE_NAME
 * is set, we send that template with `body` as its single {{1}} parameter;
 * otherwise we send plain text (works for manual sends / sandbox testing
 * within the 24h window).
 */
async function sendWhatsAppMessage(toPhone, body) {
  const to = toWhatsAppId(toPhone);
  if (!to) return { ok: false, error: 'No phone number on file.' };

  if (!isConfigured()) {
    console.warn('[whatsapp] Not configured (missing WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID) — dry run:', { to, body });
    return { ok: false, dryRun: true, error: 'WhatsApp Cloud API not configured yet — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.' };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;

  const payload = templateName
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: body }] }],
        },
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body } };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || `Request failed with status ${res.status}`;
      console.error('[whatsapp] send failed:', message, data);
      return { ok: false, error: message };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    console.error('[whatsapp] send error:', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendWhatsAppMessage, isConfigured };
