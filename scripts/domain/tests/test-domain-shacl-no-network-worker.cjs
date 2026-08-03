'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  analyzeShaclExecution,
} = require('../lib/shacl-execution-evidence.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKER = path.join(
  ROOT,
  'scripts',
  'domain',
  'shacl-domain-profile',
  'v0.3.0',
  'pyshacl-no-network-cli.py',
);

function pythonExecutable() {
  const candidates = [
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(
        process.env.LOCALAPPDATA,
        'Programs',
        'Python',
        'Python312',
        'python.exe',
      )
      : null,
    process.execPath.replace(/node(?:\.exe)?$/iu, process.platform === 'win32' ? 'python.exe' : 'python3'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (probe.status === 0 && /Python 3\.12\./u.test(probe.stdout || probe.stderr || '')) {
      return candidate;
    }
  }
  throw new Error('absolute Python 3.12 executable is required');
}

function workerEnvironment() {
  const environment = {
    PYTHONHASHSEED: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return environment;
}

test('domain SHACL worker pins both engines and denies SPARQL SERVICE network access', (t) => {
  const python = pythonExecutable();
  const selfTest = spawnSync(python, ['-I', WORKER, '--self-test'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: workerEnvironment(),
    shell: false,
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(selfTest.status, 0, selfTest.stderr);
  const attestation = JSON.parse(selfTest.stdout);
  assert.equal(attestation.pyshaclVersion, '0.26.0');
  assert.equal(attestation.rdflibVersion, '7.6.0');
  assert.deepEqual(attestation.permissionAssurance, {
    guard: 'python-socket-urllib-v1',
    inference: 'none',
    js: false,
    network: 'denied-in-process',
    owlImports: false,
    rules: false,
    socketConstructorProbe: 'denied',
    urlopenProbe: 'denied',
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-shacl-network-deny-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const shapes = path.join(directory, 'shapes.ttl');
  const data = path.join(directory, 'data.ttl');
  fs.writeFileSync(data, '<https://example.test/focus> <https://example.test/p> "value" .\n');
  fs.writeFileSync(shapes, [
    '@prefix sh: <http://www.w3.org/ns/shacl#> .',
    '<https://example.test/shape> a sh:NodeShape ;',
    '  sh:targetNode <https://example.test/focus> ;',
    '  sh:sparql [',
    '    a sh:SPARQLConstraint ;',
    '    sh:select """',
    '      SELECT $this WHERE {',
    '        SERVICE <http://127.0.0.1:9/sparql> { ?s ?p ?o }',
    '      }',
    '    """',
    '  ] .',
    '',
  ].join('\n'));
  const denied = spawnSync(
    python,
    ['-I', WORKER, '-f', 'nt', '-s', shapes, data],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: workerEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const diagnostics = `${denied.stdout}\n${denied.stderr}`;
  assert.equal(denied.status, 1, diagnostics);
  assert.match(
    diagnostics,
    /must not contain a federated query \(SERVICE\)/u,
  );
  const assessment = analyzeShaclExecution(
    denied,
    'rejected',
    {
      component: 'http://www.w3.org/ns/shacl#SPARQLConstraintComponent',
      focus: 'https://example.test/focus',
      severity: 'http://www.w3.org/ns/shacl#Violation',
    },
  );
  assert.equal(assessment.ok, false);
  assert.equal(assessment.reason, 'invalid-validation-report');

  const prohibited = spawnSync(
    python,
    ['-I', WORKER, '-im', '-s', shapes, data],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: workerEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: 15_000,
    },
  );
  assert.equal(prohibited.status, 4);
  assert.match(prohibited.stderr, /closed SHACL worker accepts only/u);
});
