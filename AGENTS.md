# AGENTS.md — Axiolune Ontology Meta-Model

## Repository layout (phase-separated)

```
ontology/meta/          # M3 meta-model YAML + digests + projection (IRI-stable, do NOT move)
scripts/meta/            # M3 validators + generators + tests (run from repo root)
scripts/archive/         # one-shot migration scripts (completed, kept for audit)
docs/meta/               # M3-phase docs: decisions (ADRs), reports, design, reference
  decisions/             # ADR-001..012 + superseded/
  reports/               # acceptance reports + raw test-all output
  reference/             # external reference projects (read-only)
assets/                  # banner/logo
```
Future phases (M2 domain ontology, M1 runtime) get their own `ontology/domain/`, `scripts/domain/`,
`docs/domain/`, `docs/runtime/` trees to avoid mixing with this phase.

## Quick verification (run before declaring the meta-model done)

```
node scripts/meta/test-all.js
```

This single command runs the full meta-model gate (exit 0 = pass):
1. `validate-yaml.js` — 4 meta-model YAML syntax
2. `verify-meta-model.js` — digest consistency, import lock, closures, temporal, single-truth-source
3. `deep-analysis-v0.5.js` — ADR-011 / ADR-012 compliance
4. `validate-references.js` — real reference + constraint + targetElement + import version-label closure
5. `validate-structure.js` — deep structural validation (root, module, required fields, IRI/enum)
6. `validate-structure.js --strict` — unknown-key typo detection on type-classifiers
7. `test-structure-negative.js` — 14 negative tests (proves the validator rejects malformed input)
8. `generate-owl.js` + `generate-shacl.js` — M3 -> M2 projection (OWL2-DL + SHACL)
9. `test-projection.js` — n3 parse of OWL/SHACL + rdf-validate-shacl good/bad M1 validation
10. projection drift check — committed `.ttl` == regenerated (catches stale artifacts)

## Individual commands

```
node scripts/meta/validate-yaml.js ontology/meta/*.yaml        # syntax
node scripts/meta/verify-meta-model.js                          # digests + imports + closures
node scripts/meta/validate-references.js                        # reference + version closure
node scripts/meta/validate-structure.js                         # deep structural (use --strict for typo checks)
node scripts/meta/test-structure-negative.js                    # negative tests
node scripts/meta/generate-owl.js && node scripts/meta/generate-shacl.js   # regenerate projection
node scripts/meta/test-projection.js                            # projection verification
```

## Meta-model structure & conventions

- Four-layer meta-model in `ontology/meta/`:
  - `core-meta-model.yaml` (Layer 1, v0.4.0) — semantic core: types, attributes, relations, associations, constraints, value objects
  - `cross-domain-patterns.yaml` (Layer 2, v0.4.0) — identity/time/provenance/evidence/lifecycle patterns + 9 constraint definitions
  - `behavior-meta-model.yaml` (Layer 3, v0.4.0) — query/function/action/policy
  - `data-binding-meta-model.yaml` (Layer 4, v0.5.0) — ADR-011 single truth source (SemanticMappingDefinition canonical)
- `digests.json` — SHA-256 of each module. Imports are content-addressed (`moduleIri#sha256:...`) with `artifactDigest`. Editing any file requires recomputing its digest and updating every importer (topological order: core -> patterns -> behavior -> data-binding) plus `digests.json`.
- `ontology/meta/projection/` — generated M3->M2 output (do not hand-edit; regenerate with the generators). Deterministic.
- ADRs in `docs/meta/decisions/` (ADR-001..012). ADR-011 (canonical data binding) and ADR-012 (three-axis temporal) govern Layer 4.

## Hard rules

- No `CURRENT_TIMESTAMP` / non-reproducible time functions anywhere in the meta-model (ADR-012). Use `$referenceTime` / `$queryTime` bound to `MaterializationRun`.
- Layer 4 single truth source: `SemanticMappingDefinition` is the only mapping structure. `Field.semanticMapping` and `SemanticFieldMapping` are PROHIBITED.
- `availableFrom`/`availableTo` are the canonical availability axis; `availableAt` is deprecated (removal 0.6.0).
- Do not fabricate validation/test/projection results. Anything not machine-run must be marked "unverified".
- Generated SHACL Tier-1 (format/range + per-pattern shapes) is machine-verified by `rdf-validate-shacl` (incl. TemporalFactShape requiring validFrom/knowledgeFrom at minCount 1); Tier-2 is split into parameter-free direct `sh:sparql` (BOUND() syntax) and parameterized `sh:ConstraintComponent` (NoFutureKnowledge/AvailabilityBeforeUse with sh:parameter + sh:SPARQLSelectValidator) — parse-verified only; enforcement needs a SPARQL-capable SHACL engine (e.g. pyshacl).
