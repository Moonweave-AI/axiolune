#!/usr/bin/env node
/**
 * Generate module interdependency matrix for M2 release
 * Extracts import relationships from all module.yaml files
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '../..');
const M2_MODULES_DIR = path.join(REPO_ROOT, 'ontology/m2/finance');

function loadModule(modulePath) {
  const content = fs.readFileSync(modulePath, 'utf8');
  const parsed = yaml.load(content);
  return parsed;
}

function findModuleFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const moduleFile = path.join(fullPath, 'module.yaml');
      if (fs.existsSync(moduleFile)) {
        results.push(moduleFile);
      }
    }
  }

  return results;
}

function extractModuleDependencies() {
  const modulePaths = findModuleFiles(M2_MODULES_DIR);

  const dependencies = {};

  for (const modulePath of modulePaths) {
    const doc = loadModule(modulePath);

    // Module metadata is nested under 'module' key
    const module = doc.module;
    if (!module) {
      console.warn(`Warning: Module at ${modulePath} has no 'module' section`);
      continue;
    }

    const moduleIri = module.moduleIri;
    const version = module.version;

    if (!moduleIri) {
      console.warn(`Warning: Module at ${modulePath} has no moduleIri field`);
      continue;
    }

    const imports = (module.imports || []).map(imp => ({
      moduleIri: typeof imp === 'string' ? imp : (imp.moduleIri || imp.iri),
      version: (typeof imp === 'object' ? imp.version : null) || 'unspecified'
    }));

    dependencies[moduleIri] = {
      version,
      localPath: path.relative(REPO_ROOT, modulePath),
      imports: imports,
      importedBy: []  // Will be populated in reverse pass
    };
  }

  // Reverse pass: populate importedBy
  for (const [moduleIri, info] of Object.entries(dependencies)) {
    for (const imp of info.imports) {
      if (dependencies[imp.moduleIri]) {
        dependencies[imp.moduleIri].importedBy.push({
          moduleIri,
          version: info.version
        });
      }
    }
  }

  return dependencies;
}

function generateMatrix() {
  console.log('Generating M2 module interdependency matrix...');

  const dependencies = extractModuleDependencies();

  const matrix = {
    generatedAt: new Date().toISOString(),
    totalModules: Object.keys(dependencies).length,
    dependencies: {}
  };

  // Convert to clean output format
  for (const [moduleIri, info] of Object.entries(dependencies)) {
    const moduleName = moduleIri.split('/').pop();

    matrix.dependencies[moduleName] = {
      moduleIri,
      version: info.version,
      localPath: info.localPath,
      imports: info.imports.map(imp => ({
        module: imp.moduleIri.split('/').pop(),
        version: imp.version
      })),
      importedBy: info.importedBy.map(imp => ({
        module: imp.moduleIri.split('/').pop(),
        version: imp.version
      }))
    };
  }

  return matrix;
}

function detectCycles(dependencies) {
  const cycles = [];
  const visited = new Set();
  const stack = new Set();

  function dfs(moduleIri, path = []) {
    if (stack.has(moduleIri)) {
      const cycleStart = path.indexOf(moduleIri);
      cycles.push(path.slice(cycleStart).concat([moduleIri]));
      return;
    }

    if (visited.has(moduleIri)) return;

    visited.add(moduleIri);
    stack.add(moduleIri);
    path.push(moduleIri);

    const info = dependencies[moduleIri];
    if (info) {
      for (const imp of info.imports) {
        dfs(imp.moduleIri, [...path]);
      }
    }

    stack.delete(moduleIri);
  }

  for (const moduleIri of Object.keys(dependencies)) {
    dfs(moduleIri);
  }

  return cycles;
}

function main() {
  const dependencies = extractModuleDependencies();
  const matrix = generateMatrix();

  // Check for cycles
  const cycles = detectCycles(dependencies);
  if (cycles.length > 0) {
    console.error('\n❌ ERROR: Circular dependencies detected!');
    for (const cycle of cycles) {
      console.error('  Cycle:', cycle.map(iri => iri.split('/').pop()).join(' → '));
    }
    process.exit(1);
  }

  // Output matrix
  const outputPath = path.join(REPO_ROOT, 'releases/INTERDEPENDENCY-MATRIX.yaml');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.dump(matrix, { lineWidth: 120, noRefs: true }));

  console.log(`✓ Interdependency matrix written to: ${outputPath}`);
  console.log(`  Total modules: ${matrix.totalModules}`);
  console.log(`  No circular dependencies detected`);
}

if (require.main === module) {
  main();
}

module.exports = { extractModuleDependencies, detectCycles, generateMatrix };

// Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
