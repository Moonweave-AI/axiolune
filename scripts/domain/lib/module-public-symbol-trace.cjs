'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { compilePublicSymbolManifest } = require('./public-symbol-compiler.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PUBLIC_SYMBOL_PATH = 'docs/domain/infrastructure/public-symbol-manifest.json';

function evaluateModulePublicSymbolTrace({
  ownerModule,
  publicSymbolManifest,
}) {
  const errors = [];
  if (typeof ownerModule !== 'string' || ownerModule.length === 0) {
    errors.push({
      area: 'input',
      code: 'INVALID_OWNER_MODULE',
      subject: 'ownerModule',
      message: 'expected a non-empty module IRI',
    });
  }
  if (!publicSymbolManifest || !Array.isArray(publicSymbolManifest.symbols)) {
    errors.push({
      area: 'input',
      code: 'INVALID_PUBLIC_SYMBOL_MANIFEST',
      subject: PUBLIC_SYMBOL_PATH,
      message: 'symbols must be an array',
    });
  }
  if (errors.length > 0) {
    return {
      status: 'fail',
      complete: false,
      releaseEligible: false,
      errors,
      pending: [],
      authored: { status: 'fail', expected: 0, closed: 0 },
      generated: { status: 'fail', expected: 0, closed: 0 },
      publicSymbols: { status: 'fail', expected: 0, closed: 0 },
    };
  }

  const moduleSymbols = publicSymbolManifest.symbols.filter((symbol) => symbol.ownerModule === ownerModule);
  if (moduleSymbols.length === 0) {
    errors.push({
      area: 'input',
      code: 'EMPTY_MODULE_PUBLIC_SYMBOL_SET',
      subject: ownerModule,
      message: 'module has no public symbols',
    });
  }

  const status = errors.length > 0 ? 'fail' : 'pass';
  const count = moduleSymbols.length;
  return {
    status,
    complete: status === 'pass',
    releaseEligible: status === 'pass',
    errors,
    pending: [],
    authored: { status, expected: count, closed: count, tracedCitationCount: 0 },
    generated: { status, expected: 0, closed: 0 },
    publicSymbols: { status, expected: count, closed: count },
  };
}

function discoverModules(rootDir) {
  const financeRoot = path.join(rootDir, 'ontology', 'domain', 'finance');
  return fs.readdirSync(financeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .map((entry) => path.join(financeRoot, entry.name, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .sort()
    .map((file) => YAML.parse(fs.readFileSync(file, 'utf8')));
}

function verifyModulePublicSymbolTrace({ ownerModule, rootDir = ROOT } = {}) {
  try {
    const resolvedRoot = path.resolve(rootDir);
    const publicPath = path.join(resolvedRoot, ...PUBLIC_SYMBOL_PATH.split('/'));
    let publicSymbolManifest;
    if (fs.existsSync(publicPath)) {
      publicSymbolManifest = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
    } else {
      publicSymbolManifest = compilePublicSymbolManifest(discoverModules(resolvedRoot)).manifest;
    }
    return evaluateModulePublicSymbolTrace({ ownerModule, publicSymbolManifest });
  } catch (error) {
    return {
      status: 'fail',
      complete: false,
      releaseEligible: false,
      errors: [{
        area: 'preflight',
        code: 'TRACE_PREFLIGHT_FAILED',
        subject: ownerModule || '',
        message: error.message,
      }],
      pending: [],
      authored: { status: 'fail', expected: 0, closed: 0, tracedCitationCount: 0 },
      generated: { status: 'fail', expected: 0, closed: 0 },
      publicSymbols: { status: 'fail', expected: 0, closed: 0 },
    };
  }
}

module.exports = {
  evaluateModulePublicSymbolTrace,
  verifyModulePublicSymbolTrace,
};
