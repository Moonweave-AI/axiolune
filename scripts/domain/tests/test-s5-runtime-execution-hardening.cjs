'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  EXPECTED_PYTHON_VERSION,
  probePython,
  spawnPinnedPython,
} = require('../lib/s5-pyshacl-runtime-probe.cjs');

function isolatedPythonEnvironment() {
  const environment = { PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return environment;
}

test('S5 pySHACL runtime has an exact executable and transitive runtime identity', () => {
  const runtime = probePython();
  assert.equal(runtime.pythonVersion, EXPECTED_PYTHON_VERSION);
  assert.equal(path.isAbsolute(runtime.executable), true);
  assert.match(runtime.executableDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(runtime.runtimeClosureDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(runtime.fileCount > 3_000);
  assert.ok(runtime.runtimeByteLength > 80 * 1024 * 1024);
});

test('verified runtime wrapper revalidates the closure and executes with isolated flags', (t) => {
  const runtime = probePython();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-pinned-python-worker-'));
  const worker = path.join(directory, 'worker.py');
  fs.writeFileSync(worker, [
    'import json,sys',
    'payload=sys.stdin.buffer.read().decode("utf-8")',
    'sys.stdout.write(json.dumps({"isolated":sys.flags.isolated,"payload":payload},sort_keys=True,separators=(",",":")))',
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnPinnedPython(runtime, worker, {
    cwd: directory,
    encoding: 'utf8',
    input: 'bound-input',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { isolated: 1, payload: 'bound-input' });
});

test('LOCALAPPDATA Python shim is rejected before its sitecustomize marker executes', {
  skip: process.platform !== 'win32',
}, (t) => {
  const trusted = probePython();
  const trustedRoot = path.dirname(trusted.executable);
  const fakeLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-fake-localappdata-'));
  const fakeRoot = path.join(
    fakeLocalAppData,
    'Programs',
    'Python',
    'Python312',
  );
  const fakeSitePackages = path.join(fakeRoot, 'Lib', 'site-packages');
  const marker = path.join(fakeLocalAppData, 'fake-python-executed');
  fs.mkdirSync(fakeSitePackages, { recursive: true });
  for (const name of [
    'python.exe', 'python3.dll', 'python312.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
  ]) {
    fs.copyFileSync(path.join(trustedRoot, name), path.join(fakeRoot, name));
  }
  fs.writeFileSync(
    path.join(fakeSitePackages, 'sitecustomize.py'),
    `open(${JSON.stringify(marker)}, "w", encoding="utf-8").write("executed")\n`,
  );
  fs.writeFileSync(path.join(fakeRoot, 'python312._pth'), [
    path.join(trustedRoot, 'Lib'),
    path.join(trustedRoot, 'DLLs'),
    fakeSitePackages,
    path.join(trustedRoot, 'Lib', 'site-packages'),
    'import site',
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(fakeLocalAppData, { recursive: true, force: true }));

  const fakePython = path.join(fakeRoot, 'python.exe');
  const direct = spawnSync(fakePython, ['-I', '-c', 'print("fixture-active")'], {
    encoding: 'utf8',
    env: isolatedPythonEnvironment(),
    shell: false,
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(direct.status, 0, direct.stderr || direct.error?.message);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
  fs.rmSync(marker);

  const previousLocalAppData = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = fakeLocalAppData;
    assert.throws(
      () => probePython(),
      /no verifier-locked Python runtime/u,
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});
