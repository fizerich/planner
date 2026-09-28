# Going live: Railway or Render

Both platforms build straight from a GitHub repo and give you a free HTTPS
subdomain (`*.up.railway.app` / `*.onrender.com`). Add a custom domain later
from either dashboard once you're happy with the live app.

**Important — persistent storage.** This app stores all data (clinics,
licenses, to-dos, activity log) in a single JSON file on disk (`data/db.json`
locally). Both Railway and Render wipe the container's local filesystem on
every deploy/restart — **your data will vanish on the next deploy unless you
attach a persistent volume/disk and point `DATA_DIR` at it.** The steps below
cover that. Don't skip it.

---

## 0. Push the code to GitHub

```
cd dental-planner
git add -A
git commit -m "Initial commit"
```

Then create an empty repo on GitHub (via the website or `gh repo create`) and:

```
git remote add origin https://github.com/<you>/dental-planner.git
git branch -M main
git push -u origin main
```

---

## Option A: Railway (recommended — simplest)

1. Go to https://railway.app, sign in, **New Project > Deploy from GitHub repo**,
   pick this repo. Railway auto-detects Node.js and uses `railway.json` (start
   command `npm start`, health check `/healthz`).
2. **Add a Volume** so your data survives deploys: in the service, go to
   **Settings > Volumes > New Volume**. Set the mount path to `/data`.
3. **Set environment variables** (Service > Variables):
   - `DATA_DIR` = `/data`
   - `WHATSAPP_TOKEN` = *(your Meta token — see SETUP.md)*
   - `WHATSAPP_PHONE_NUMBER_ID` = *(your Meta phone number ID)*
   - `WHATSAPP_TEMPLATE_NAME` / `WHATSAPP_TEMPLATE_LANG` = *(optional, see SETUP.md)*
   - Railway sets `PORT` automatically — don't override it.
4. Deploy. Railway gives you a public URL under **Settings > Networking >
   Generate Domain**. Open it and confirm the app loads.
5. Cost: Railway's Hobby plan (~$5/month usage-based) comfortably covers a
   small app like this plus the 1GB volume. There's no free tier with
   volumes, but usage for 3 clinics' worth of traffic is tiny.

## Option B: Render

1. Go to https://render.com, sign in, **New > Blueprint**, connect this repo.
   Render reads `render.yaml` and provisions the web service + a 1GB disk
   mounted at `/data` automatically.
   - If you'd rather click through manually instead of using the blueprint:
     **New > Web Service** → connect repo → Build command `npm install` →
     Start command `npm start` → Health check path `/healthz`. Then add a
     **Disk** under the service's **Disks** tab (mount path `/data`, 1GB), and
     set `DATA_DIR=/data` under **Environment**.
2. **Set the WhatsApp secrets** under **Environment** (the blueprint leaves
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_TEMPLATE_NAME`
   blank on purpose — `sync: false` in `render.yaml` — fill them in from the
   dashboard, not in the repo).
3. Deploy. Render gives you a `*.onrender.com` URL.
4. Cost: **persistent disks require a paid instance** (Starter, ~$7/month) —
   Render's free web service tier has no disk and also spins down after
   inactivity, which would both lose your data and delay the scheduler.

---

## After first deploy, verify data survives

1. Open the live URL, add a test to-do or license.
2. Trigger a redeploy (push any small commit, or use the dashboard's "Redeploy"
   button).
3. Reload the app — the test item should still be there. If it's gone, the
   volume/disk isn't mounted at the path `DATA_DIR` points to — check the
   platform's volume/disk settings.

## Ongoing updates

Push to `main` (or your default branch) — both platforms auto-deploy on push.
No manual steps needed beyond the one-time volume/env-var setup above.
