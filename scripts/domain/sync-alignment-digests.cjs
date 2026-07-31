#!/usr/bin/env node
/**
 * Sync alignment sourceRelease.artifactDigest from references.lock.yaml.
 *
 * Round-4 (R4-M2): module / docs/ontology/alignments/*.yaml must not carry sha256:000…
 * Digests are cross-referenced to lock entries (FIBO → fibo-local-evidence, ISO → unavailable-paywalled).
 *
 * Usage: node scripts/domain/sync-alignment-digests.cjs [--check]
 *   --check  exit 1 if any zero digest remains (no write)
 * Default: rewrite digests + lockRef in place, then remind to run compute-digests.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const LOCK = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const ZERO = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const CHECK = process.argv.includes('--check');

const VOCAB_TO_LOCK = {
  FIBO: 'fibo-local-evidence',
  FinRegOnt: 'finregont-fibo-import-pattern',
  BIAN: 'bian-payment-order-sample',
  NautilusTrader: 'nautilus-trader',
  Nautilus: 'nautilus-trader',
  Lean: 'lean',
  Qlib: 'qlib',
  rqalpha: 'rqalpha',
  vnpy: 'vnpy',
  'vn.py': 'vnpy',
  ISO: null, // resolved by ISO number below
};

function loadLock() {
  const doc = yaml.load(fs.readFileSync(LOCK, 'utf8'));
  const byId = {};
  for (const ref of doc.references || []) byId[ref.id] = ref;
  return byId;
}

function resolveIsoLockId(release) {
  const s = String(release || '');
  if (s.includes('6166')) return 'iso-6166';
  if (s.includes('10383')) return 'iso-10383';
  if (s.includes('17442')) return 'iso-17442';
  if (s.includes('10962')) return 'iso-10962';
  return 'iso-6166'; // conservative paywalled fallback for bare "ISO"
}

function resolveDigest(sourceRelease, byId) {
  const vocab = String(sourceRelease.vocabulary || '').replace(/"/g, '');
  let lockId = sourceRelease.lockRef || null;
  if (!lockId && typeof sourceRelease.artifactDigest === 'string') {
    const m = sourceRelease.artifactDigest.match(/see-references\.lock#([A-Za-z0-9_-]+)/);
    if (m) lockId = m[1];
  }
  if (!lockId) {
    if (vocab === 'ISO' || /^ISO\b/i.test(vocab)) lockId = resolveIsoLockId(sourceRelease.release);
    else lockId = VOCAB_TO_LOCK[vocab] || null;
  }
  if (!lockId || !byId[lockId]) {
    return { ok: false, reason: `no lock mapping for vocabulary=${vocab}` };
  }
  const dig = byId[lockId].artifactDigest;
  if (!dig || /sha256:0{64}/.test(dig)) {
    return { ok: false, reason: `lock ${lockId} has zero/missing digest` };
  }
  return { ok: true, lockId, digest: dig, releaseOrCommit: byId[lockId].releaseOrCommit };
}

function walkAlignments(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) walkAlignments(x, fn);
    return;
  }
  if (Array.isArray(node.alignments)) {
    for (const a of node.alignments) {
      if (a && a.sourceRelease) fn(a);
      walkAlignments(a, fn);
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'alignments') continue;
    if (v && typeof v === 'object') walkAlignments(v, fn);
  }
}

function collectYamlFiles() {
  const out = [];
  const finance = path.join(ROOT, 'ontology', 'domain', 'finance');
  for (const name of fs.readdirSync(finance)) {
    const p = path.join(finance, name, 'module.yaml');
    if (fs.existsSync(p)) out.push(p);
  }
  const alignDir = path.join(ROOT, 'docs', 'ontology', 'alignments');
  if (fs.existsSync(alignDir)) {
    for (const f of fs.readdirSync(alignDir)) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) out.push(path.join(alignDir, f));
    }
  }
  return out;
}

const byId = loadLock();
let zeros = 0;
let fixed = 0;
let errors = 0;

for (const file of collectYamlFiles()) {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = yaml.load(raw);
  let changed = false;
  walkAlignments(doc, (alignment) => {
    const sr = alignment.sourceRelease;
    const dig = String(sr.artifactDigest || '');
    const needs =
      dig === ZERO ||
      /sha256:0{64}/.test(dig) ||
      dig.includes('see-references.lock#') ||
      !dig;
    if (!needs && sr.lockRef && byId[sr.lockRef] && dig === byId[sr.lockRef].artifactDigest) return;
    if (!needs) return;
    zeros++;
    const resolved = resolveDigest(sr, byId);
    if (!resolved.ok) {
      console.error('FAIL', path.relative(ROOT, file), resolved.reason, sr);
      errors++;
      return;
    }
    if (CHECK) return;
    sr.artifactDigest = resolved.digest;
    sr.lockRef = resolved.lockId;
    // Honesty: do not claim Production quarterly release unless lock says so
    if (String(sr.release || '').match(/^\d{4}Q[1-4]$/)) {
      sr.claimedReleaseLabel = sr.release;
      sr.release = 'local-evidence-bundle';
      sr.releaseNote =
        'Digest from references.lock#' +
        resolved.lockId +
        '; Production quarterly claim (' +
        sr.claimedReleaseLabel +
        ') unverified — see lock maturity.';
    }
    changed = true;
    fixed++;
  });
  if (changed && !CHECK) {
    // Preserve optional leading comment block before first document key
    const headerMatch = raw.match(/^((?:#[^\n]*\n)+)/);
    const header = headerMatch ? headerMatch[1] : '';
    fs.writeFileSync(file, header + yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' }));
    console.log('updated', path.relative(ROOT, file));
  }
}

if (CHECK) {
  if (zeros > 0 || errors > 0) {
    console.error(`FAIL: ${zeros} zero/placeholder alignment digest(s), ${errors} resolve error(s)`);
    process.exit(1);
  }
  console.log('✓ alignment digests cross-ref lock (no zeros)');
  process.exit(0);
}

if (errors > 0) {
  console.error(`FAIL: ${errors} unresolved alignment digest(s)`);
  process.exit(1);
}
console.log(`✓ synced ${fixed} alignment digest(s) from references.lock`);
console.log('Next: node scripts/domain/compute-digests.cjs');
