#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { Parser } = require('n3');
const { projectShacl } = require('../generate-m2-shacl.cjs');
const {
  probePython,
  spawnPinnedPython,
} = require('./s5-pyshacl-runtime-probe.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PYTHON_WORKER = path.resolve(
  __dirname,
  '..',
  'shacl-instance-profile',
  'v0.3.0',
  's5-materialized-graph-worker.py',
);
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const FACT_VERSION = 'https://axiolune.ai/ontology/meta/data-binding/FactVersion';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...names].sort());
}

function readExistingFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)
      || !fs.existsSync(value) || !fs.statSync(value).isFile()) {
    throw new Error(`${label} must be an existing absolute file path`);
  }
  return fs.readFileSync(value);
}

function graphInventory(nquads) {
  const quads = new Parser({ format: 'N-Quads' }).parse(nquads);
  const graphs = new Map();
  const factVersions = new Set();
  for (const statement of quads) {
    const graph = statement.graph.termType === 'NamedNode' ? statement.graph.value : '';
    graphs.set(graph, (graphs.get(graph) || 0) + 1);
    if (statement.predicate.value === RDF_TYPE
        && statement.object.termType === 'NamedNode'
        && statement.object.value === FACT_VERSION
        && statement.subject.termType === 'NamedNode') {
      factVersions.add(statement.subject.value);
    }
  }
  return {
    factVersionIris: [...factVersions].sort(),
    namedGraphs: [...graphs.entries()]
      .filter(([iri]) => iri !== '')
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([graphIri, statementCount]) => ({ graphIri, statementCount })),
  };
}

async function main() {
  const inputBytes = fs.readFileSync(0);
  const input = JSON.parse(inputBytes.toString('utf8'));
  if (!exactKeys(input, [
    'dataNQuads', 'moduleSidecarPath', 'moduleSourcePath', 'schemaVersion',
    'supportNQuads', 'targetGraphIri',
  ]) || input.schemaVersion !== '1.0') {
    throw new Error('request differs from the closed S5 materialized-SHACL protocol');
  }
  for (const field of ['dataNQuads', 'supportNQuads', 'targetGraphIri']) {
    if (typeof input[field] !== 'string') throw new Error(`${field} must be a string`);
  }
  const moduleBytesBefore = readExistingFile(input.moduleSourcePath, 'moduleSourcePath');
  const sidecarBytesBefore = readExistingFile(input.moduleSidecarPath, 'moduleSidecarPath');
  const document = yaml.load(moduleBytesBefore.toString('utf8'), { json: false });
  const projectedBytes = await projectShacl(document);
  if (!projectedBytes.equals(sidecarBytesBefore)) {
    throw new Error('checked-in current-domain SHACL differs from a fresh projection of module.yaml');
  }
  const combinedNQuads = `${input.dataNQuads}${input.supportNQuads}`;
  const inventory = graphInventory(input.dataNQuads);
  if (!inventory.namedGraphs.some((row) => row.graphIri === input.targetGraphIri)) {
    throw new Error(`materialized target graph is absent: ${input.targetGraphIri}`);
  }
  if (inventory.factVersionIris.length === 0) {
    throw new Error('actual materialized dataset has no current data-binding FactVersion nodes');
  }
  const runtime = probePython();
  const pythonWorkerBytes = readExistingFile(PYTHON_WORKER, 'pythonWorker');
  const pythonRequest = {
    schemaVersion: '1.0',
    dataNQuads: combinedNQuads,
    shapesTurtle: projectedBytes.toString('utf8'),
  };
  const execution = spawnPinnedPython(runtime, PYTHON_WORKER, {
    cwd: path.dirname(PYTHON_WORKER),
    encoding: 'utf8',
    input: canonicalJcs(pythonRequest),
    timeout: 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (execution.error || execution.status !== 0) {
    throw new Error(`pySHACL worker failed: ${execution.error?.message || execution.stderr || `exit ${execution.status}`}`);
  }
  const result = JSON.parse(execution.stdout);
  if (!result.conforms || result.resultCount !== 0 || result.results.length !== 0) {
    throw new Error(`current-domain SHACL rejected the materialized graph: ${canonicalJcs(result.results)}`);
  }
  const moduleBytesAfter = readExistingFile(input.moduleSourcePath, 'moduleSourcePath');
  const sidecarBytesAfter = readExistingFile(input.moduleSidecarPath, 'moduleSidecarPath');
  if (!moduleBytesBefore.equals(moduleBytesAfter)
      || !sidecarBytesBefore.equals(sidecarBytesAfter)) {
    throw new Error('ontology source or generated sidecar changed during validation');
  }
  const response = {
    schemaVersion: '1.0',
    artifactKind: 's5MaterializedCurrentDomainShaclEvidence',
    outcome: 'passed',
    module: {
      moduleIri: document.module.moduleIri,
      moduleSourceDigest: sha256(moduleBytesBefore),
      projectedShaclDigest: sha256(projectedBytes),
      checkedSidecarDigest: sha256(sidecarBytesBefore),
      projectionEqualsSidecar: true,
    },
    data: {
      materializedDatasetDigest: sha256(Buffer.from(input.dataNQuads, 'utf8')),
      validationSupportDigest: sha256(Buffer.from(input.supportNQuads, 'utf8')),
      targetGraphIri: input.targetGraphIri,
      ...inventory,
    },
    execution: result,
    worker: {
      nodeWorkerDigest: sha256(fs.readFileSync(__filename)),
      pythonWorkerDigest: sha256(pythonWorkerBytes),
      pythonVersion: runtime.pythonVersion,
    },
  };
  process.stdout.write(canonicalJcs(response));
}

main().catch((cause) => {
  process.stderr.write(`${cause.stack || cause.message}\n`);
  process.exitCode = 1;
});
