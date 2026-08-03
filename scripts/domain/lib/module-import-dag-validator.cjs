'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const yaml = require('js-yaml');
const {
  CANONICAL_IMPORTS,
  FINANCE_BASE,
  validateCanonicalFinanceDag,
} = require('./canonical-finance-dag.cjs');
const {
  compilePublicSymbolManifest,
} = require('./public-symbol-compiler.cjs');

const ASSERTIONS = Object.freeze([
  'acyclic-imports',
  'exact-version-imports',
  'module-inventory',
]);
const REGISTRY_PATH = 'ontology/domain/finance/registry/module-registry.yaml';
const MODULE_PATHS = Object.freeze(Object.keys(CANONICAL_IMPORTS).map((name) => (
  `ontology/domain/finance/${name}/module.yaml`
)).sort(compareUtf8));
const CORPUS_PATHS = Object.freeze([...MODULE_PATHS, REGISTRY_PATH].sort(compareUtf8));
const CANONICAL_MODULE_IDENTITIES = Object.freeze({
  foundation: Object.freeze({ preferredPrefix: 'fin-foundation' }),
  instruments: Object.freeze({ preferredPrefix: 'fin-instruments' }),
  'market-data': Object.freeze({ preferredPrefix: 'fin-market-data' }),
  'market-rules': Object.freeze({ preferredPrefix: 'fin-market-rules' }),
  'market-structure': Object.freeze({ preferredPrefix: 'fin-market-structure' }),
  'orders-execution': Object.freeze({ preferredPrefix: 'fin-orders' }),
  'portfolio-positions': Object.freeze({ preferredPrefix: 'fin-portfolio' }),
  'post-trade-operations': Object.freeze({ preferredPrefix: 'fin-post-trade' }),
  risk: Object.freeze({ preferredPrefix: 'fin-risk' }),
  'strategy-research': Object.freeze({ preferredPrefix: 'fin-strategy' }),
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeUtf8Strict(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError(`${label} must be a byte buffer`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const error = new Error(`${label} is not valid UTF-8`);
    error.code = 'INVALID_UTF8';
    error.cause = cause;
    throw error;
  }
}

function sourcePath(root, relativePath) {
  return path.join(path.resolve(root), ...relativePath.split('/'));
}

function makeFinding(code, at, message) {
  return {
    code: String(code).replace(/[^A-Z0-9_]/gu, '_').toUpperCase(),
    path: String(at || ''),
    message: String(message || ''),
  };
}

function exactKeys(value, allowed, required) {
  const keys = Object.keys(value || {});
  return required.every((field) => keys.includes(field))
    && keys.every((field) => allowed.includes(field));
}

function ownAuthoredElementIris(module) {
  const result = new Set();
  for (const container of Object.values(module.doc?.domain || {})) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const value of Object.values(container)) {
      if (value && typeof value === 'object' && !Array.isArray(value)
          && typeof value.iri === 'string') result.add(value.iri);
    }
  }
  return result;
}

function ownLocalNames(module) {
  const result = new Set();
  for (const container of Object.values(module.doc?.domain || {})) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const value of Object.values(container)) {
      if (value && typeof value === 'object' && !Array.isArray(value)
          && typeof value.localName === 'string') result.add(value.localName);
    }
  }
  return result;
}

function normalizeFindings(findings) {
  return findings.map((row) => makeFinding(row.code, row.path, row.message))
    .sort((left, right) => compareUtf8(
      `${left.code}\0${left.path}\0${left.message}`,
      `${right.code}\0${right.path}\0${right.message}`,
    ));
}

function statFingerprint(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameStatFingerprint(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function changedDuringCapture(relativePath, cause) {
  const error = new Error(`${relativePath} changed while its bytes were captured`);
  error.code = 'SOURCE_CHANGED_DURING_CAPTURE';
  if (cause) error.cause = cause;
  return error;
}

function captureRegularFilePass(root, relativePath) {
  const absolute = sourcePath(root, relativePath);
  const pathStatBefore = fs.lstatSync(absolute, { bigint: true });
  if (!pathStatBefore.isFile() || pathStatBefore.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular non-symlink file`);
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(absolute);
  const relative = path.relative(realRoot, realFile);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${relativePath} resolves outside the source root`);
  }
  let descriptor;
  let descriptorStatBefore;
  let descriptorStatAfter;
  let bytes;
  try {
    descriptor = fs.openSync(realFile, 'r');
    descriptorStatBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!descriptorStatBefore.isFile()
        || !sameStatFingerprint(
          statFingerprint(pathStatBefore), statFingerprint(descriptorStatBefore),
        )) {
      throw changedDuringCapture(relativePath);
    }
    bytes = fs.readFileSync(descriptor);
    descriptorStatAfter = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStatFingerprint(
      statFingerprint(descriptorStatBefore), statFingerprint(descriptorStatAfter),
    ) || BigInt(bytes.length) !== descriptorStatAfter.size) {
      throw changedDuringCapture(relativePath);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  let pathStatAfter;
  let realFileAfter;
  try {
    pathStatAfter = fs.lstatSync(absolute, { bigint: true });
    realFileAfter = fs.realpathSync(absolute);
  } catch (cause) {
    throw changedDuringCapture(relativePath, cause);
  }
  if (!pathStatAfter.isFile() || pathStatAfter.isSymbolicLink()
      || path.resolve(realFileAfter) !== path.resolve(realFile)
      || !sameStatFingerprint(
        statFingerprint(descriptorStatAfter), statFingerprint(pathStatAfter),
      )) {
    throw changedDuringCapture(relativePath);
  }
  return Object.freeze({
    bytes,
    digest: sha256(bytes),
    fingerprint: statFingerprint(descriptorStatAfter),
    realRoot: path.resolve(realRoot),
    realFile: path.resolve(realFile),
  });
}

function sameFileCapture(left, right) {
  return left.realRoot === right.realRoot
    && left.realFile === right.realFile
    && sameStatFingerprint(left.fingerprint, right.fingerprint)
    && left.digest === right.digest
    && left.bytes.equals(right.bytes);
}

function captureRegularFile(root, relativePath) {
  const captured = captureRegularFilePass(root, relativePath);
  let rechecked;
  try {
    rechecked = captureRegularFilePass(root, relativePath);
  } catch (cause) {
    throw changedDuringCapture(relativePath, cause);
  }
  if (!sameFileCapture(captured, rechecked)) throw changedDuringCapture(relativePath);
  return captured;
}

function readRegularFile(root, relativePath) {
  return captureRegularFile(root, relativePath).bytes;
}

function loadModule(root, relativePath, findings) {
  let bytes;
  let doc;
  try {
    bytes = readRegularFile(root, relativePath);
  } catch (cause) {
    findings.push(makeFinding(
      'MODULE_YAML_INVALID', relativePath,
      `module bytes are unavailable as a regular source file (${String(cause?.code || 'INVALID_FILE')})`,
    ));
    return null;
  }
  try {
    doc = yaml.load(decodeUtf8Strict(bytes, relativePath));
  } catch (cause) {
    findings.push(makeFinding('MODULE_YAML_INVALID', relativePath, cause.message));
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || !doc.module || typeof doc.module !== 'object' || Array.isArray(doc.module)
      || typeof doc.module.moduleIri !== 'string'
      || typeof doc.module.version !== 'string'
      || !Array.isArray(doc.module.imports)) {
    findings.push(makeFinding(
      'MODULE_HEADER_INVALID',
      `${relativePath}.module`,
      'moduleIri, version, and imports are required with their exact scalar/array types',
    ));
    return { path: relativePath, bytes, digest: sha256(bytes), doc };
  }
  const moduleName = relativePath.split('/').at(-2);
  const identity = CANONICAL_MODULE_IDENTITIES[moduleName];
  const expectedIri = `${FINANCE_BASE}${moduleName}`;
  if (!identity || doc.module.moduleIri !== expectedIri
      || doc.module.baseIri !== `${expectedIri}/`
      || doc.module.preferredPrefix !== identity.preferredPrefix) {
    findings.push(makeFinding(
      'MODULE_PATH_IDENTITY_MISMATCH',
      `${relativePath}.module`,
      `canonical path requires moduleIri=${expectedIri}, baseIri=${expectedIri}/, preferredPrefix=${identity?.preferredPrefix || '<undefined>'}`,
    ));
  }
  return { path: relativePath, bytes, digest: sha256(bytes), doc };
}

function discoverActualModulePaths(root, findings) {
  const financeRoot = sourcePath(root, 'ontology/domain/finance');
  const result = [];
  const visit = (absolute, relativePath) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      findings.push(makeFinding(
        'MODULE_DISCOVERY_INVALID', relativePath, 'finance discovery refuses symbolic links',
      ));
      return;
    }
    if (stat.isFile()) {
      if (relativePath.endsWith('/module.yaml')) result.push(relativePath);
      return;
    }
    if (!stat.isDirectory()) {
      findings.push(makeFinding(
        'MODULE_DISCOVERY_INVALID', relativePath, 'finance discovery found a non-regular entry',
      ));
      return;
    }
    for (const name of fs.readdirSync(absolute).sort(compareUtf8)) {
      visit(path.join(absolute, name), `${relativePath}/${name}`);
    }
  };
  if (fs.existsSync(financeRoot)) visit(financeRoot, 'ontology/domain/finance');
  return result.sort(compareUtf8);
}

function discoverActualRegistryPaths(root, findings) {
  const registryRoot = sourcePath(root, 'ontology/domain/finance/registry');
  const result = [];
  const visit = (absolute, relativePath) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      findings.push(makeFinding(
        'REGISTRY_DISCOVERY_INVALID', relativePath, 'registry discovery refuses symbolic links',
      ));
      return;
    }
    if (stat.isFile()) {
      if (relativePath.endsWith('module-registry.yaml')) result.push(relativePath);
      return;
    }
    if (!stat.isDirectory()) {
      findings.push(makeFinding(
        'REGISTRY_DISCOVERY_INVALID', relativePath, 'registry discovery found a non-regular entry',
      ));
      return;
    }
    for (const name of fs.readdirSync(absolute).sort(compareUtf8)) {
      visit(path.join(absolute, name), `${relativePath}/${name}`);
    }
  };
  if (fs.existsSync(registryRoot)) {
    visit(registryRoot, 'ontology/domain/finance/registry');
  }
  return result.sort(compareUtf8);
}

function readCanonicalModules(root, findings) {
  const actualPaths = discoverActualModulePaths(root, findings);
  for (const relativePath of actualPaths) {
    if (!MODULE_PATHS.includes(relativePath)) {
      findings.push(makeFinding(
        'EXTRA_FINANCE_MODULE', relativePath,
        'module.yaml is outside the exact RFC-001 ten-module path inventory',
      ));
    }
  }
  for (const relativePath of MODULE_PATHS) {
    if (!actualPaths.includes(relativePath)) {
      findings.push(makeFinding('MISSING_FINANCE_MODULE', relativePath, 'canonical module file is absent'));
    }
  }
  const modules = [];
  for (const relativePath of actualPaths) {
    const module = loadModule(root, relativePath, findings);
    if (module) modules.push(module);
  }
  return modules.sort((left, right) => compareUtf8(left.path, right.path));
}

function validateRegistry(root, modules, findings) {
  const registryPaths = discoverActualRegistryPaths(root, findings);
  if (!registryPaths.includes(REGISTRY_PATH)) {
    findings.push(makeFinding('REGISTRY_MISSING', REGISTRY_PATH, 'canonical module registry is absent'));
  }
  for (const relativePath of registryPaths) {
    if (relativePath !== REGISTRY_PATH) {
      findings.push(makeFinding(
        'REGISTRY_EXTRA', relativePath,
        'module registry is outside the exact canonical registry path inventory',
      ));
    }
  }
  let bytes;
  let registry;
  try {
    bytes = readRegularFile(root, REGISTRY_PATH);
  } catch (cause) {
    findings.push(makeFinding(
      'REGISTRY_INVALID', REGISTRY_PATH,
      `registry bytes are unavailable as a regular source file (${String(cause?.code || 'INVALID_FILE')})`,
    ));
    return registryPaths.length;
  }
  try {
    registry = yaml.load(decodeUtf8Strict(bytes, REGISTRY_PATH));
  } catch (cause) {
    findings.push(makeFinding('REGISTRY_INVALID', REGISTRY_PATH, cause.message));
    return registryPaths.length;
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)
      || !exactKeys(registry, ['registryVersion', 'note', 'modules'], [
        'registryVersion', 'note', 'modules',
      ])
      || registry.registryVersion !== '0.3.0' || typeof registry.note !== 'string') {
    findings.push(makeFinding(
      'REGISTRY_HEADER_INVALID', REGISTRY_PATH,
      'registry must be the closed v0.3.0 registryVersion/note/modules document',
    ));
  }
  const rows = Array.isArray(registry?.modules) ? registry.modules : null;
  if (!rows) {
    findings.push(makeFinding('REGISTRY_INVALID', `${REGISTRY_PATH}.modules`, 'modules must be an array'));
    return registryPaths.length;
  }
  const byIri = new Map();
  const paths = new Set();
  let previousIri = null;
  for (const [index, row] of rows.entries()) {
    const at = `${REGISTRY_PATH}.modules[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || !exactKeys(row, [
          'moduleIri', 'version', 'artifactDigest', 'status', 'preferredPrefix', 'path',
        ], [
          'moduleIri', 'version', 'artifactDigest', 'status', 'preferredPrefix', 'path',
        ])
        || typeof row.moduleIri !== 'string' || typeof row.path !== 'string'
        || typeof row.version !== 'string' || typeof row.status !== 'string'
        || typeof row.preferredPrefix !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(row.artifactDigest || '')) {
      findings.push(makeFinding(
        'REGISTRY_ROW_INVALID', at,
        'row lacks the closed IRI/version/digest/status/prefix/path tuple',
      ));
      continue;
    }
    if (previousIri !== null && compareUtf8(previousIri, row.moduleIri) >= 0) {
      findings.push(makeFinding(
        'REGISTRY_ORDER_INVALID', `${at}.moduleIri`,
        'registry module IRIs must be strictly UTF-8 sorted and unique',
      ));
    }
    previousIri = row.moduleIri;
    if (byIri.has(row.moduleIri)) {
      findings.push(makeFinding('REGISTRY_DUPLICATE_MODULE', at, row.moduleIri));
    } else {
      byIri.set(row.moduleIri, row);
    }
    if (paths.has(row.path)) findings.push(makeFinding('REGISTRY_DUPLICATE_PATH', at, row.path));
    paths.add(row.path);
  }
  if (rows.length !== modules.length || byIri.size !== modules.length) {
    findings.push(makeFinding(
      'REGISTRY_INVENTORY_MISMATCH',
      REGISTRY_PATH,
      `${rows.length} registry rows / ${byIri.size} unique IRIs for ${modules.length} module files`,
    ));
  }
  const moduleIris = new Set();
  for (const module of modules) {
    const header = module.doc?.module;
    const iri = header?.moduleIri;
    if (typeof iri !== 'string') continue;
    if (moduleIris.has(iri)) {
      findings.push(makeFinding('DUPLICATE_FINANCE_MODULE', module.path, iri));
      continue;
    }
    moduleIris.add(iri);
    const row = byIri.get(iri);
    if (!row) {
      findings.push(makeFinding('REGISTRY_MODULE_MISSING', module.path, iri));
      continue;
    }
    if (row.path !== module.path || row.version !== header.version
        || row.artifactDigest !== module.digest || row.status !== header.status
        || row.preferredPrefix !== header.preferredPrefix) {
      findings.push(makeFinding(
        'REGISTRY_MODULE_MISMATCH',
        module.path,
        'registry path/version/digest/status/preferredPrefix differs from the module',
      ));
    }
  }
  for (const [iri, row] of byIri) {
    if (!moduleIris.has(iri)) {
      findings.push(makeFinding('REGISTRY_UNKNOWN_MODULE', row.path || REGISTRY_PATH, iri));
    }
  }
  return registryPaths.length;
}

function validateImports(modules, findings) {
  const byIri = new Map();
  for (const module of modules) {
    const iri = module.doc?.module?.moduleIri;
    if (typeof iri === 'string' && !byIri.has(iri)) byIri.set(iri, module);
  }
  for (const module of modules) {
    const exports = module.doc?.module?.exports;
    if (!Array.isArray(exports)) {
      findings.push(makeFinding(
        'MODULE_EXPORTS_INVALID', `${module.path}.module.exports`,
        'exports must be an array under the M3 module header contract',
      ));
      continue;
    }
    const owned = ownAuthoredElementIris(module);
    const seen = new Set();
    for (const [index, exportedIri] of exports.entries()) {
      const at = `${module.path}.module.exports[${index}]`;
      if (typeof exportedIri !== 'string' || !/^https?:\/\/[^\s]+$/u.test(exportedIri)) {
        findings.push(makeFinding(
          'MODULE_EXPORT_IRI_INVALID', at, 'export must be an absolute M3 IRI',
        ));
        continue;
      }
      if (seen.has(exportedIri)) {
        findings.push(makeFinding(
          'MODULE_EXPORT_INVENTORY_INVALID', at,
          'explicit exports must be unique; source order is set-semantic',
        ));
      }
      seen.add(exportedIri);
      if (!owned.has(exportedIri)) {
        findings.push(makeFinding(
          'MODULE_EXPORT_NOT_OWNED', at,
          `${exportedIri} is not an authored public symbol of ${module.path}`,
        ));
      }
    }
  }
  const publicSymbolsByModule = new Map();
  try {
    const compiled = compilePublicSymbolManifest(modules.map((item) => item.doc));
    for (const symbol of compiled.manifest.symbols) {
      if (!publicSymbolsByModule.has(symbol.ownerModule)) {
        publicSymbolsByModule.set(symbol.ownerModule, new Set());
      }
      publicSymbolsByModule.get(symbol.ownerModule).add(symbol.publicIri);
    }
  } catch (cause) {
    const errors = Array.isArray(cause?.errors) ? cause.errors : [{
      code: 'COMPILATION_FAILED', path: 'modules', message: cause.message,
    }];
    for (const row of errors) {
      findings.push(makeFinding(
        `PUBLIC_SYMBOL_${row.code}`,
        row.path,
        row.message,
      ));
    }
  }
  for (const row of validateCanonicalFinanceDag(modules.map((item) => item.doc))) {
    findings.push(makeFinding(row.code, row.module, row.message));
  }
  const edges = new Map();
  for (const module of modules) {
    const header = module.doc?.module;
    if (!header || typeof header.moduleIri !== 'string' || !Array.isArray(header.imports)) continue;
    const local = [];
    const aliases = new Set();
    const localNames = new Set(
      [...ownLocalNames(module)].map((localName) => localName.normalize('NFC')),
    );
    for (const [index, imported] of header.imports.entries()) {
      const at = `${module.path}.module.imports[${index}]`;
      if (!imported || typeof imported !== 'object' || Array.isArray(imported)
          || typeof imported.moduleIri !== 'string') {
        findings.push(makeFinding(
          'IMPORT_EDGE_INVALID', at,
          'import edge must be an object with a string moduleIri',
        ));
        continue;
      }
      if (typeof imported.version !== 'string'
          || !/^sha256:[0-9a-f]{64}$/u.test(imported.artifactDigest || '')
          || typeof imported.importMode !== 'string') {
        findings.push(makeFinding(
          'IMPORT_TUPLE_INVALID', at,
          'import lacks exact version/digest/importMode fields',
        ));
      }
      if (!exactKeys(
        imported,
        ['moduleIri', 'version', 'artifactDigest', 'importMode', 'importedSymbols'],
        ['moduleIri', 'version', 'artifactDigest', 'importMode'],
      )) {
        findings.push(makeFinding(
          'IMPORT_TUPLE_FIELDS', at,
          'import contains a field outside ModuleImportDefinition',
        ));
      }
      if (!['All', 'Selective'].includes(imported.importMode)) {
        findings.push(makeFinding(
          'IMPORT_MODE_INVALID', `${at}.importMode`,
          `expected All or Selective, got ${String(imported.importMode)}`,
        ));
      }
      const target = byIri.get(imported.moduleIri);
      if (!target) {
        findings.push(makeFinding('UNKNOWN_IMPORT_TARGET', at, imported.moduleIri));
        continue;
      }
      local.push(imported.moduleIri);
      if (imported.version !== target.doc?.module?.version) {
        findings.push(makeFinding(
          'IMPORT_VERSION_MISMATCH',
          `${at}.version`,
          `${imported.version} != ${String(target.doc?.module?.version)}`,
        ));
      }
      if (imported.artifactDigest !== target.digest) {
        findings.push(makeFinding(
          'IMPORT_DIGEST_MISMATCH',
          `${at}.artifactDigest`,
          `${imported.artifactDigest} != ${target.digest}`,
        ));
      }
      const importedSymbols = imported.importedSymbols;
      if (imported.importMode === 'All') {
        if (importedSymbols !== undefined) {
          findings.push(makeFinding(
            'IMPORT_SYMBOLS_MODE_MISMATCH', `${at}.importedSymbols`,
            'All import mode forbids declaring a selective symbol list',
          ));
        }
      } else if (imported.importMode === 'Selective') {
        if (!Array.isArray(importedSymbols) || importedSymbols.length === 0) {
          findings.push(makeFinding(
            'IMPORT_SYMBOLS_REQUIRED', `${at}.importedSymbols`,
            'Selective import mode requires a non-empty symbol list',
          ));
        } else {
          const visible = publicSymbolsByModule.get(target.doc?.module?.moduleIri) || new Set();
          const symbolIris = [];
          for (const [symbolIndex, spec] of importedSymbols.entries()) {
            const symbolAt = `${at}.importedSymbols[${symbolIndex}]`;
            if (!spec || typeof spec !== 'object' || Array.isArray(spec)
                || !exactKeys(spec, ['symbolIri', 'localAlias'], ['symbolIri'])
                || typeof spec.symbolIri !== 'string'
                || !/^https?:\/\/[^\s]+$/u.test(spec.symbolIri)
                || (spec.localAlias !== undefined
                  && (typeof spec.localAlias !== 'string'
                    || spec.localAlias.length === 0))) {
              findings.push(makeFinding(
                'IMPORT_SYMBOL_INVALID', symbolAt,
                'selective symbol must be a closed symbolIri/optional-localAlias tuple',
              ));
              continue;
            }
            symbolIris.push(spec.symbolIri);
            if (!visible.has(spec.symbolIri)) {
              findings.push(makeFinding(
                'IMPORT_SYMBOL_NOT_EXPORTED', `${symbolAt}.symbolIri`, spec.symbolIri,
              ));
            }
            if (spec.localAlias !== undefined) {
              const aliasKey = spec.localAlias.normalize('NFC');
              if (spec.localAlias !== aliasKey) {
                findings.push(makeFinding(
                  'IMPORT_ALIAS_INVALID', `${symbolAt}.localAlias`,
                  'localAlias must be authored in Unicode NFC',
                ));
              }
              if (aliases.has(aliasKey)) {
                findings.push(makeFinding(
                  'IMPORT_ALIAS_DUPLICATE', `${symbolAt}.localAlias`, spec.localAlias,
                ));
              }
              if (localNames.has(aliasKey)) {
                findings.push(makeFinding(
                  'IMPORT_ALIAS_LOCAL_COLLISION', `${symbolAt}.localAlias`,
                  `${spec.localAlias} collides with an authored localName in ${module.path}`,
                ));
              }
              aliases.add(aliasKey);
            }
          }
          if (new Set(symbolIris).size !== symbolIris.length) {
            findings.push(makeFinding(
              'IMPORT_SYMBOL_INVENTORY', `${at}.importedSymbols`,
              'selective symbol IRIs must be unique; source order is set-semantic',
            ));
          }
        }
      }
    }
    edges.set(header.moduleIri, local);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (iri, chain) => {
    if (visiting.has(iri)) {
      findings.push(makeFinding('IMPORT_CYCLE', iri, [...chain, iri].join(' -> ')));
      return;
    }
    if (visited.has(iri)) return;
    visiting.add(iri);
    for (const child of edges.get(iri) || []) visit(child, [...chain, iri]);
    visiting.delete(iri);
    visited.add(iri);
  };
  for (const iri of [...edges.keys()].sort(compareUtf8)) visit(iri, []);
}

function failedAssertions(findings) {
  const codes = new Set(findings.map((row) => row.code));
  const graphCompletenessCodes = new Set([
    'DUPLICATE_FINANCE_MODULE', 'EXTRA_FINANCE_MODULE', 'MISSING_FINANCE_MODULE',
    'IMPORT_EDGE_INVALID',
    'MODULE_DISCOVERY_INVALID', 'MODULE_HEADER_INVALID', 'MODULE_PATH_IDENTITY_MISMATCH',
    'MODULE_YAML_INVALID', 'UNKNOWN_IMPORT_TARGET',
  ]);
  const inventoryCodes = new Set([
    'DUPLICATE_FINANCE_MODULE', 'EXTRA_FINANCE_MODULE', 'MISSING_FINANCE_MODULE',
    'MODULE_DISCOVERY_INVALID', 'MODULE_HEADER_INVALID', 'MODULE_PATH_IDENTITY_MISMATCH',
    'MODULE_YAML_INVALID',
    'REGISTRY_DISCOVERY_INVALID', 'REGISTRY_DUPLICATE_MODULE', 'REGISTRY_DUPLICATE_PATH',
    'REGISTRY_EXTRA', 'REGISTRY_HEADER_INVALID', 'REGISTRY_INVALID',
    'REGISTRY_INVENTORY_MISMATCH', 'REGISTRY_MISSING', 'REGISTRY_ORDER_INVALID',
    'REGISTRY_MODULE_MISMATCH', 'REGISTRY_MODULE_MISSING', 'REGISTRY_ROW_INVALID',
    'REGISTRY_UNKNOWN_MODULE',
  ]);
  const importCodes = new Set([
    'DIRECT_IMPORT_SET_MISMATCH', 'DUPLICATE_DIRECT_IMPORT', 'IMPORT_DIGEST_MISMATCH',
    'IMPORT_EDGE_INVALID',
    'IMPORT_ALIAS_DUPLICATE', 'IMPORT_ALIAS_INVALID', 'IMPORT_ALIAS_LOCAL_COLLISION',
    'IMPORT_MODE_INVALID',
    'IMPORT_SYMBOL_INVENTORY',
    'IMPORT_SYMBOL_INVALID', 'IMPORT_SYMBOL_NOT_EXPORTED', 'IMPORT_SYMBOLS_MODE_MISMATCH',
    'IMPORT_SYMBOLS_REQUIRED', 'IMPORT_TUPLE_FIELDS', 'IMPORT_TUPLE_INVALID',
    'IMPORT_VERSION_MISMATCH', 'MODULE_EXPORT_INVENTORY_INVALID',
    'MODULE_EXPORT_IRI_INVALID', 'MODULE_EXPORT_NOT_OWNED', 'MODULE_EXPORTS_INVALID',
    'UNKNOWN_IMPORT_TARGET', 'WRONG_FINANCE_VERSION',
  ]);
  const failed = [];
  if ([...codes].some((code) => inventoryCodes.has(code))) failed.push('module-inventory');
  if (codes.has('IMPORT_CYCLE')
      || [...codes].some((code) => graphCompletenessCodes.has(code))) {
    failed.push('acyclic-imports');
  }
  if ([...codes].some((code) => importCodes.has(code))
      || [...codes].some((code) => graphCompletenessCodes.has(code))
      || [...codes].some((code) => code.startsWith('PUBLIC_SYMBOL_'))) {
    failed.push('exact-version-imports');
  }
  if (findings.length > 0 && failed.length === 0) return [...ASSERTIONS];
  return failed.sort(compareUtf8);
}

function validateModuleImportDag(root) {
  const resolvedRoot = path.resolve(root);
  const findings = [];
  const modules = readCanonicalModules(resolvedRoot, findings);
  validateImports(modules, findings);
  const registryCount = validateRegistry(resolvedRoot, modules, findings);
  const normalized = normalizeFindings(findings);
  const failed = failedAssertions(normalized);
  const passed = ASSERTIONS.filter((assertion) => !failed.includes(assertion));
  return {
    ok: normalized.length === 0 && failed.length === 0,
    findings: normalized,
    checkedArtifactCount: modules.length + registryCount,
    passedAssertions: passed,
    failedAssertions: failed,
  };
}

module.exports = {
  ASSERTIONS,
  CORPUS_PATHS,
  MODULE_PATHS,
  REGISTRY_PATH,
  captureRegularFile,
  compareUtf8,
  decodeUtf8Strict,
  readRegularFile,
  sameFileCapture,
  sha256,
  validateModuleImportDag,
};
