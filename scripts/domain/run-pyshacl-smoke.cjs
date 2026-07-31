#!/usr/bin/env node
/**
 * pySHACL smoke probe for the pinned Trial validator (Round-4: real execution when Python available).
 *
 * Prefers: %LOCALAPPDATA%/Programs/Python/Python312/python.exe
 * Install: that python -m pip install -r docs/domain/infrastructure/requirements-shacl.txt
 *
 * Runs shapes.ttl against data-good (expect conforms) and data-bad (expect non-conforms).
 * Exit 0 on success or honest pending; exit 1 only on unexpected failure / pin missing.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'domain', 'infrastructure', 'shacl-smoke-evidence.json');
const PIN = path.join(ROOT, 'docs', 'domain', 'infrastructure', 'SHACL-ENGINE-PIN.yaml');
const REQ = path.join(ROOT, 'docs', 'domain', 'infrastructure', 'requirements-shacl.txt');
const SMOKE = path.join(ROOT, 'docs', 'domain', 'infrastructure', 'smoke');
const PINNED = '0.26.0';

function findPython() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join('C:\\', 'Program Files', 'Python312', 'python.exe'),
    'python3',
    'python',
    'py',
  ];
  for (const cmd of candidates) {
    if (!cmd || cmd.endsWith(path.sep + 'python.exe') && !fs.existsSync(cmd)) continue;
    if ((cmd.includes('\\') || cmd.includes('/')) && cmd.endsWith('python.exe') && !fs.existsSync(cmd)) continue;
    const useShell = !(path.isAbsolute(cmd) && /\.exe$/i.test(cmd));
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: useShell });
    if (r.status === 0) {
      const ver = (r.stdout || r.stderr || '').trim();
      if (/was not found|Microsoft Store/i.test(ver)) continue;
      if (!/Python\s+3\./i.test(ver)) continue;
      return { cmd, version: ver };
    }
  }
  return null;
}

function runPy(py, args) {
  // Prefer no shell for absolute python.exe — Windows shell re-parsing breaks -c imports
  const useShell = !(path.isAbsolute(py) && /\.exe$/i.test(py));
  return spawnSync(py, args, { encoding: 'utf8', shell: useShell, cwd: ROOT });
}

const evidence = {
  iri: 'https://axiolune.ai/evidence/shacl-smoke/2026-07-30-r6',
  pinFile: 'docs/domain/infrastructure/SHACL-ENGINE-PIN.yaml',
  requirementsFile: 'docs/domain/infrastructure/requirements-shacl.txt',
  checkedAt: '2026-07-29T21:05:00Z',
  checkedAtBinding: 'slice-a-materialization-run.referenceTime (reproducible; not wall-clock)',
  pinExists: fs.existsSync(PIN),
  pinnedVersion: PINNED,
};

if (!evidence.pinExists) {
  console.error('FAIL: missing SHACL-ENGINE-PIN.yaml');
  process.exit(1);
}

const py = findPython();
if (!py) {
  evidence.evidenceStatus = 'pending-python-runtime';
  evidence.primaryResult = 'skipped';
  evidence.note = 'Python 3.x not found; Trial pin recorded, execution unverified.';
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.log('○ pySHACL smoke: pending-python-runtime (honest skip)');
  process.exit(0);
}

evidence.python = py;

let verR = runPy(py.cmd, ['-c', 'import pyshacl,sys; print(pyshacl.__version__)']);
if (verR.status !== 0) {
  console.log('… installing pinned pyshacl from requirements-shacl.txt');
  const pip = runPy(py.cmd, ['-m', 'pip', 'install', '-r', REQ]);
  if (pip.stdout) process.stdout.write(pip.stdout);
  if (pip.stderr) process.stderr.write(pip.stderr);
  if (pip.status !== 0) {
    evidence.evidenceStatus = 'pending-pyshacl-install';
    evidence.primaryResult = 'install-failed';
    evidence.note = 'pip install failed; see console';
    fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
    console.error('FAIL: could not install pyshacl');
    process.exit(1);
  }
  verR = runPy(py.cmd, ['-c', 'import pyshacl,sys; print(pyshacl.__version__)']);
}

if (verR.status !== 0) {
  evidence.evidenceStatus = 'pending-pyshacl-install';
  evidence.primaryResult = 'skipped';
  evidence.note = 'pyshacl not importable after install attempt';
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.error('FAIL: pyshacl import');
  process.exit(1);
}

evidence.pyshaclVersion = (verR.stdout || '').trim();

const shapes = path.join(SMOKE, 'shapes.ttl');
const good = path.join(SMOKE, 'data-good.ttl');
const bad = path.join(SMOKE, 'data-bad.ttl');

const goodR = runPy(py.cmd, ['-m', 'pyshacl', '-s', shapes, good]);
const badR = runPy(py.cmd, ['-m', 'pyshacl', '-s', shapes, bad]);

// pySHACL exit: 0 conforms, 1 non-conforms, >1 error
const goodOk = goodR.status === 0;
const badOk = badR.status === 1;

evidence.goodConforms = goodOk;
evidence.badRejected = badOk;
evidence.goodExit = goodR.status;
evidence.badExit = badR.status;

if (goodOk && badOk) {
  evidence.evidenceStatus = 'executed';
  evidence.primaryResult = 'smoke-pass';
  evidence.note =
    'Minimal shapes+data smoke PASS. Domain corpus SHACL Adopt still pending; structural fixture negatives not yet engine-enforced.';
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.log('✓ pySHACL smoke: good conforms + bad rejected (version=' + evidence.pyshaclVersion + ')');
  process.exit(0);
}

evidence.evidenceStatus = 'executed-failed';
evidence.primaryResult = 'smoke-fail';
evidence.goodStdout = (goodR.stdout || '').slice(0, 500);
evidence.badStdout = (badR.stdout || '').slice(0, 500);
fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.error('FAIL: pySHACL smoke unexpected (goodExit=' + goodR.status + ' badExit=' + badR.status + ')');
process.exit(1);
