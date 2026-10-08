const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

// In production, set DATA_DIR to a mounted persistent volume (e.g. Railway Volume
// or a Render Disk) — the platform's default filesystem is wiped on every deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SEED_PATH = path.join(__dirname, '..', 'data', 'db.json');

let cache = null;
let writeChain = Promise.resolve();

async function ensureDbFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!fsSync.existsSync(DB_PATH)) {
    const seed = await fs.readFile(SEED_PATH, 'utf-8');
    await fs.writeFile(DB_PATH, seed, 'utf-8');
  }
}

// Fills in fields added by later versions of the app so an older on-disk db.json
// (e.g. on a volume from a previous deploy) doesn't crash code that expects them.
let idCounter = 0;
function nextThresholdId() { idCounter += 1; return 'at' + Date.now() + idCounter; }

function migrate(data) {
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.pushSubscriptions)) data.pushSubscriptions = [];

  // Replaced the fixed d30/d14/d3(d1) checkboxes with a free-form list of
  // {amount, unit} thresholds the owner can add/remove. Carry old on/off
  // checkbox state over as equivalent entries so nobody's settings vanish.
  if (!Array.isArray(data.alertThresholds)) {
    const old = data.thresholds || {};
    const converted = [];
    if (old.d30) converted.push({ id: nextThresholdId(), amount: 1, unit: 'months' });
    if (old.d14) converted.push({ id: nextThresholdId(), amount: 14, unit: 'days' });
    if (old.d3) converted.push({ id: nextThresholdId(), amount: 3, unit: 'days' });
    if (old.d1) converted.push({ id: nextThresholdId(), amount: 1, unit: 'days' });
    data.alertThresholds = converted.length ? converted : [
      { id: nextThresholdId(), amount: 1, unit: 'months' },
      { id: nextThresholdId(), amount: 14, unit: 'days' },
      { id: nextThresholdId(), amount: 1, unit: 'days' },
    ];
  }
  delete data.thresholds;
  delete data.managerPhones;

  // Carry existing installs onto each theme revision's new default accent, unless
  // the owner had already picked something other than the previous default.
  if (data.settings && data.settings.accentColor === '#BE5B3D') {
    data.settings.accentColor = '#7C6FEA';
  }
  if (data.settings && data.settings.accentColor === '#7C6FEA') {
    data.settings.accentColor = '#5E6AD2';
  }

  if (data.settings && !Array.isArray(data.settings.dashboardSectionOrder)) {
    data.settings.dashboardSectionOrder = ['events', 'todo', 'licenses'];
  }
  if (data.settings && !data.settings.themeMode) {
    data.settings.themeMode = 'dark';
  }
  return data;
}

async function load() {
  if (cache) return cache;
  await ensureDbFile();
  let parsed = null;
  try {
    const raw = await fs.readFile(DB_PATH, 'utf-8');
    parsed = migrate(JSON.parse(raw));
  } catch (err) {
    console.error('[db] Existing db.json at', DB_PATH, 'is unreadable/corrupt — re-seeding from defaults so the app can start. Error:', err.message);
  }
  if (!parsed) {
    const seed = await fs.readFile(SEED_PATH, 'utf-8');
    parsed = migrate(JSON.parse(seed));
    await fs.writeFile(DB_PATH, JSON.stringify(parsed, null, 2), 'utf-8');
  }
  cache = parsed;
  return cache;
}

async function persist() {
  const tmpPath = DB_PATH + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(cache, null, 2), 'utf-8');
  await fs.rename(tmpPath, DB_PATH);
}

function getState() {
  if (!cache) throw new Error('db not loaded yet — call load() at startup');
  return cache;
}

// Serializes writes so concurrent requests can't interleave and corrupt the file.
function update(mutator) {
  writeChain = writeChain.then(async () => {
    await load();
    mutator(cache);
    await persist();
    return cache;
  });
  return writeChain;
}

module.exports = { load, getState, update, DB_PATH };
