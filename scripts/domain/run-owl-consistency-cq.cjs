#!/usr/bin/env node
/**
 * OWL 2 DL consistency check gate (G5).
 * Loads all M2 module OWL projections into one rdflib graph, runs the OWL-RL reasoner
 * (owlrl.DeductiveClosure), and checks for inferred owl:Nothing instances (disjoint-class
 * contradictions) and unsatisfiable classes. Evidence is persisted to JSON.
 *
 * OWL-RL is a rule-based reasoner (not HermiT/Pellet). It does not detect all DL
 * inconsistencies, but it DOES detect disjoint-class contradictions via owl:Nothing
 * inference. A full OWL 2 DL reasoner remains a future upgrade (M2-PLAN §11 Assess).
 *
 * Usage: node scripts/domain/run-owl-consistency-cq.cjs
 * Exit 0 if consistent (no owl:Nothing inferred), 1 otherwise.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const OUT_DIR = path.join(ROOT, 'docs', 'domain', 'infrastructure', 'owl-consistency-runs');

function findPython() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    'python3',
    'python',
  ];
  for (const cmd of candidates) {
    if (cmd.includes('python.exe') && !fs.existsSync(cmd)) continue;
    const useShell = !(path.isAbsolute(cmd) && /\.exe$/i.test(cmd));
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: useShell });
    if (r.status === 0 && /Python\s+3\./i.test((r.stdout || r.stderr || ''))) return cmd;
  }
  return null;
}

const owlFiles = fs
  .readdirSync(FINANCE)
  .map((n) => path.join(FINANCE, n, 'module.owl.ttl'))
  .filter((p) => fs.existsSync(p));

if (owlFiles.length === 0) {
  console.error('FAIL: no module.owl.ttl files found');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const mergedPath = path.join(OUT_DIR, 'all-domain-owl.ttl');
fs.writeFileSync(mergedPath, owlFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));

const py = findPython();
if (!py) {
  console.error('FAIL: Python not found — run scripts/domain/setup-shacl-runtime.ps1');
  process.exit(1);
}

const script = `
import sys, json
from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS
try:
    import owlrl
except Exception as e:
    print(json.dumps({"status":"pending-owlrl","error":str(e)})); sys.exit(2)

g = Graph()
try:
    g.parse(r"${mergedPath.replace(/\\/g, '\\\\')}", format="turtle")
except Exception as e:
    print(json.dumps({"status":"parse-error","error":str(e)})); sys.exit(1)

# Run OWL-RL closure (DL-safe rules). After expansion, check for inferred owl:Nothing
# instances which indicate disjoint-class contradictions (e.g., x rdf:type A, x rdf:type B,
# A owl:disjointWith B). OWL-RL does not raise exceptions for contradictions — it infers
# owl:Nothing membership which we detect explicitly.
try:
    owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(g)
except Exception as e:
    msg = str(e).lower()
    if "inconsisten" in msg or "unsatisfiable" in msg or "disjoint" in msg:
        print(json.dumps({"status":"inconsistent","error":str(e)})); sys.exit(1)
    # Some OWL-RL limitations raise on unsupported constructs; treat as warning, not failure.
    print(json.dumps({"status":"reasoner-warning","error":str(e)})); sys.exit(0)

# Post-closure contradiction detection: any resource typed as owl:Nothing indicates inconsistency.
nothing_instances = list(g.subjects(RDF.type, OWL.Nothing))
if nothing_instances:
    print(json.dumps({"status":"inconsistent","error":"owl:Nothing inferred for %d resource(s): %s" % (len(nothing_instances), str(sorted([str(s) for s in nothing_instances])[:5]))})); sys.exit(1)

# Also check for unsatisfiable classes (classes typed as owl:Nothing via subClassOf),
# excluding owl:Nothing itself (which is trivially subClassOf owl:Nothing).
unsatisfiable = [s for s in g.subjects(RDFS.subClassOf, OWL.Nothing) if str(s) != str(OWL.Nothing)]
if unsatisfiable:
    print(json.dumps({"status":"inconsistent","error":"unsatisfiable classes: %s" % str(sorted([str(s) for s in unsatisfiable])[:5])})); sys.exit(1)

triples = len(g)
classes = len(set(g.subjects(RDF.type, OWL.Class)))
print(json.dumps({"status":"consistent","triples":triples,"classes":classes,"nothingCount":0}))
sys.exit(0)
`;

const r = spawnSync(py, ['-c', script], { encoding: 'utf8', shell: !(path.isAbsolute(py) && /\.exe$/i.test(py)) });
const out = (r.stdout || '').trim();
const err = (r.stderr || '').trim();

let result;
try { result = JSON.parse(out); } catch { result = { status: 'unknown', raw: out, error: err }; }

console.log('=== OWL 2 DL consistency check (OWL-RL) ===');
console.log('Files merged: ' + owlFiles.length);

if (result.status === 'consistent') {
  console.log('✓ consistent — ' + result.triples + ' triples, ' + result.classes + ' classes after OWL-RL closure (no owl:Nothing inferred)');
  process.exit(0);
} else if (result.status === 'reasoner-warning') {
  console.error('FAIL: OWL-RL reasoner warning is non-final: ' + result.error);
  process.exit(1);
} else if (result.status === 'pending-owlrl') {
  console.error('FAIL: owlrl not installed — ' + result.error);
  process.exit(1);
} else {
  console.error('✗ ' + result.status + ': ' + (result.error || result.raw || ''));
  if (err) console.error(err);
  process.exit(1);
}
