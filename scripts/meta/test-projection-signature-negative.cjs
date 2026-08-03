#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DataFactory, Parser, Writer } = require('n3');
const { namedNode } = DataFactory;

const ROOT = path.join(__dirname, '..', '..');
const META_DIR = path.join(ROOT, 'ontology', 'meta');
const FILES = [
  'axiolune-meta.owl.ttl',
  'axiolune-meta.shacl.ttl',
  'axiolune-meta.shacl-sparql.ttl',
];
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL = 'http://www.w3.org/2002/07/owl#';

function run(script, projectionDir) {
  return spawnSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, META_DIR, META_PROJECTION_DIR: projectionDir },
    encoding: 'utf8',
  });
}

function copyProjection(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(from, file), path.join(to, file));
}

function removeTypeTriple(file, subjectIri, typeIri) {
  const quads = new Parser().parse(fs.readFileSync(file, 'utf8')).filter((quad) => !(
    quad.subject.equals(namedNode(subjectIri)) &&
    quad.predicate.equals(namedNode(RDF_TYPE)) &&
    quad.object.equals(namedNode(typeIri))
  ));
  return new Promise((resolve, reject) => {
    const writer = new Writer();
    writer.addQuads(quads);
    writer.end((error, result) => {
      if (error) reject(error);
      else {
        fs.writeFileSync(file, result);
        resolve();
      }
    });
  });
}

function expectProjectionFailure(label, projectionDir, expectedText) {
  const result = run('scripts/meta/test-projection.js', projectionDir);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 && output.includes(expectedText)) {
    process.stdout.write(`PASS ${label}\n`);
    return 0;
  }
  process.stderr.write(`FAIL ${label}: exit=${result.status}; expected output ${expectedText}\n${output}\n`);
  return 1;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-meta-projection-negative-'));
  let failures = 0;
  try {
    const canonical = path.join(tmp, 'canonical');
    fs.mkdirSync(canonical, { recursive: true });
    for (const script of ['scripts/meta/generate-owl.js', 'scripts/meta/generate-shacl.js']) {
      const result = run(script, canonical);
      if (result.status !== 0) {
        process.stderr.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        throw new Error(`${script} failed`);
      }
    }

    const annotationMutation = path.join(tmp, 'missing-annotation-signature');
    copyProjection(canonical, annotationMutation);
    await removeTypeTriple(
      path.join(annotationMutation, 'axiolune-meta.owl.ttl'),
      'https://axiolune.ai/ontology/meta/core/annotations/sourceEvidenceRef',
      OWL + 'AnnotationProperty',
    );
    failures += expectProjectionFailure(
      'missing sourceEvidenceRef annotation signature is rejected',
      annotationMutation,
      'sourceEvidenceRef must be exclusively owl:AnnotationProperty',
    );

    const patternMutation = path.join(tmp, 'missing-pattern-class-signature');
    copyProjection(canonical, patternMutation);
    await removeTypeTriple(
      path.join(patternMutation, 'axiolune-meta.owl.ttl'),
      'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
      OWL + 'Class',
    );
    failures += expectProjectionFailure(
      'missing PatternDefinition class signature is rejected',
      patternMutation,
      'TemporalFact is missing its explicit owl:Class signature',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures > 0) process.exit(1);
  process.stdout.write('PASS all projection signature negative mutations\n');
}

main().catch((error) => {
  process.stderr.write(`FAIL projection signature negative test: ${error.stack || error.message}\n`);
  process.exit(1);
});
