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

async function load() {
  if (cache) return cache;
  await ensureDbFile();
  const raw = await fs.readFile(DB_PATH, 'utf-8');
  cache = JSON.parse(raw);
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
