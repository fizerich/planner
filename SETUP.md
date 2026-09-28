# SuperPlanner — Dental Clinic Planner

Multi-clinic license/permit renewal tracker with a dashboard, calendar, to-do list,
and automated WhatsApp reminders (owner + per-clinic managers).

## Run it locally

```
npm install
npm start
```

Then open http://localhost:3000. Data is stored in `data/db.json` on the server —
that's the shared source of truth for the owner and every clinic manager who opens
the app (no per-device local storage split).

For local development with auto-restart on file changes: `npm run dev`.

**Going live?** See `DEPLOY.md` for Railway/Render hosting steps.

## Configure WhatsApp reminders (Meta Cloud API)

The app ships wired up to send real WhatsApp messages via the Meta WhatsApp Cloud
API, both for the "Send WhatsApp" button on the Reminders screen and for the
automated daily check (08:00 server time) that alerts the owner or the relevant
clinic manager as each license crosses its 30/14/3-day threshold or goes overdue.

Until you add credentials, sends will fail with a clear "not configured" message
in the UI and server logs — nothing else in the app is affected.

1. Create a Meta developer app at https://developers.facebook.com/apps and add the
   **WhatsApp** product.
2. From the app's WhatsApp > API Setup page, grab:
   - a temporary (or permanent, via a System User) **access token**
   - the **Phone number ID** for the sending number
3. Copy `.env.example` to `.env` and fill in:
   ```
   WHATSAPP_TOKEN=...
   WHATSAPP_PHONE_NUMBER_ID=...
   ```
4. Restart the server (`npm start`).

**About proactive reminders and templates:** Meta only allows plain free-form text
messages inside the 24-hour window after a customer messages your business number
first. The scheduler's automated reminders are business-initiated (nobody messaged
first), so outside that window Meta requires a pre-approved **message template**.
To enable that:

1. In Meta Business Manager, create a WhatsApp message template (category:
   Utility) with a single body variable, e.g. body text `{{1}}`.
2. Once approved, set in `.env`:
   ```
   WHATSAPP_TEMPLATE_NAME=your_template_name
   WHATSAPP_TEMPLATE_LANG=en_US
   ```
3. Restart the server. The scheduler and manual "Send WhatsApp" / "Send test
   reminder" buttons will now send that template with the reminder text as the
   `{{1}}` parameter.

If you leave `WHATSAPP_TEMPLATE_NAME` blank, the app sends plain text — fine for
testing in the sandbox or once a recipient has messaged the business number
within the last 24 hours, but automated reminders sent outside that window will
be rejected by Meta until a template is configured.

## Optional: back up / share data via Google Sheets

The server's `data/db.json` is already the shared source of truth, so this is
purely an optional external export/import — useful as a backup or if you want to
eyeball the data in a spreadsheet. Setup steps and the Apps Script code to paste
are in `docs/google-apps-script-setup.gs.txt`. Paste the deployed Web App URL into
Settings > Data & sync, then use Save/Load — same whole-snapshot, last-save-wins
sync described in that file.

## Project layout

- `server/` — Express app: REST API, JSON-file data store, the reminder scheduler,
  and the Meta Cloud API client.
- `public/` — static frontend (plain HTML/CSS/JS, no build step).
- `data/db.json` — the persisted app data (seed/local dev copy).
- `docs/google-apps-script-setup.gs.txt` — paste-in script for the optional Sheets bridge.
- `render.yaml` / `railway.json` — hosting config, see `DEPLOY.md`.
