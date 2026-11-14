#!/usr/bin/env node
// Dataset helper for the Edge Impulse wildlife classifier. No npm deps (Node 18+).
//
//   node dataset/tools/ei.js add <folder-or-zip> [--test]   copy new images into ei_upload/{train|test}
//   node dataset/tools/ei.js stats                          per-class counts
//   node dataset/tools/ei.js upload [--test]                upload to Edge Impulse (duplicates are skipped)
//
// Labels come from a parent folder named warn_animal / small_animal / no_animal, or a filename
// that starts with one of those. Files are renamed "<label>.<rest>.jpg" so Edge Impulse's own
// uploader would also infer the label. Re-adding the same image (same SHA-256) is a no-op.
//
// The Edge Impulse project API key is read from EI_API_KEY or from dataset/.env (git-ignored):
//   EI_API_KEY=ei_xxx

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LABELS = ['warn_animal', 'small_animal', 'no_animal'];
const EXTS = new Set(['.jpg', '.jpeg', '.png']);
const DATASET = path.resolve(__dirname, '..');
const OUT = { train: path.join(DATASET, 'ei_upload', 'train'), test: path.join(DATASET, 'ei_upload', 'test') };

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const images = (d) => (fs.existsSync(d) ? walk(d) : []).filter((f) => EXTS.has(path.extname(f).toLowerCase()));

function labelOf(file) {
  for (const part of path.dirname(file).split(path.sep).reverse()) if (LABELS.includes(part)) return part;
  const base = path.basename(file);
  return LABELS.find((l) => base.startsWith(l)) || null;
}

function extractZip(zip) {
  const dest = path.join(DATASET, 'raw', path.basename(zip, path.extname(zip)).replace(/[^\w.-]+/g, '_'));
  fs.mkdirSync(dest, { recursive: true });
  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'unzip';
  execFileSync(tar, tar === 'unzip' ? ['-q', '-n', zip, '-d', dest] : ['-xf', zip, '-C', dest], { stdio: 'inherit' });
  console.log(`Extracted to ${path.relative(process.cwd(), dest)}`);
  return dest;
}

function add(src, split) {
  if (!src || !fs.existsSync(src)) die(`Not found: ${src}`);
  if (src.toLowerCase().endsWith('.zip')) src = extractZip(src);
  const out = OUT[split];
  fs.mkdirSync(out, { recursive: true });
  const known = new Set(images(out).map(sha));
  const added = {}, skipped = { duplicate: 0, unlabelled: [] };
  for (const f of images(src)) {
    const label = labelOf(f);
    if (!label) { skipped.unlabelled.push(f); continue; }
    const h = sha(f);
    if (known.has(h)) { skipped.duplicate++; continue; }
    known.add(h);
    let rest = path.basename(f, path.extname(f));
    if (rest.startsWith(label)) rest = rest.slice(label.length).replace(/^[._-]+/, '');
    rest = (rest || h.slice(0, 12)).replace(/[^\w-]+/g, '_');
    let name = `${label}.${rest}${path.extname(f).toLowerCase()}`;
    if (fs.existsSync(path.join(out, name))) name = `${label}.${rest}_${h.slice(0, 8)}${path.extname(f).toLowerCase()}`;
    fs.copyFileSync(f, path.join(out, name));
    added[label] = (added[label] || 0) + 1;
  }
  console.log(`Added to ${split}:`, added, `| duplicates skipped: ${skipped.duplicate}`);
  if (skipped.unlabelled.length) {
    console.log(`Unlabelled (put them in a warn_animal/ small_animal/ no_animal/ folder): ${skipped.unlabelled.length}`);
    skipped.unlabelled.slice(0, 5).forEach((f) => console.log('  ' + f));
  }
  stats();
}

function stats() {
  for (const split of ['train', 'test']) {
    const c = {};
    for (const f of images(OUT[split])) { const l = path.basename(f).split('.')[0]; c[l] = (c[l] || 0) + 1; }
    console.log(`${split.padEnd(5)}`, LABELS.map((l) => `${l}: ${c[l] || 0}`).join('  '));
  }
}

function apiKey() {
  if (process.env.EI_API_KEY) return process.env.EI_API_KEY.trim();
  const env = path.join(DATASET, '.env');
  const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^EI_API_KEY=(.+)$/m);
  if (m) return m[1].trim();
  die('No API key. Put EI_API_KEY=ei_... in dataset/.env (Edge Impulse: Dashboard > Keys).');
}

async function upload(split) {
  const key = apiKey();
  const category = split === 'test' ? 'testing' : 'training';
  const files = images(OUT[split]);
  if (!files.length) die(`No images in ${OUT[split]}`);
  let ok = 0, dup = 0, fail = 0;
  for (const label of LABELS) {
    const batch = files.filter((f) => path.basename(f).startsWith(label + '.'));
    for (let i = 0; i < batch.length; i += 20) {
      const form = new FormData();
      for (const f of batch.slice(i, i + 20)) {
        const type = f.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        form.append('data', new Blob([fs.readFileSync(f)], { type }), path.basename(f));
      }
      const res = await fetch(`https://ingestion.edgeimpulse.com/api/${category}/files`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'x-label': label, 'x-disallow-duplicates': '1' },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !body.files) die(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      for (const r of body.files || []) {
        if (r.success) ok++;
        else if (/already exists|duplicate/i.test(r.error || '')) dup++;
        else { fail++; console.log(`  failed ${r.name || ''}: ${r.error}`); }
      }
      process.stdout.write(`\r${category}: uploaded ${ok}, already there ${dup}, failed ${fail}`);
    }
  }
  console.log();
}

function die(msg) { console.error(msg); process.exit(1); }

const [cmd, arg] = process.argv.slice(2);
const split = process.argv.includes('--test') ? 'test' : 'train';
if (cmd === 'add') add(arg, split);
else if (cmd === 'stats') stats();
else if (cmd === 'upload') upload(split).catch((e) => die(e.stack || String(e)));
else die('Usage: node dataset/tools/ei.js add <folder-or-zip> [--test] | stats | upload [--test]');
