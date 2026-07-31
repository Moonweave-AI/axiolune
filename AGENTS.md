# AGENTS.md — Axiolune Ontology

## Repository layout (phase-separated)

```
ontology/meta/           # M3 meta-model YAML + digests + projection (IRI-stable, do NOT move)
ontology/domain/         # M2 domain ontology (finance modules under ontology/domain/finance/)
scripts/meta/            # M3 validators + generators + tests (run from repo root)
scripts/domain/          # M2 validators + generators + test-all-domain
scripts/archive/         # one-shot migration scripts (completed, kept for audit)
docs/meta/               # M3-phase docs: decisions (ADRs), reports, design, reference
docs/domain/             # M2-phase docs: planning (M2-PLAN), decisions (ADR-013+)
  decisions/             # ADR-013+ domain ADRs + honest PROGRESS-REPORT
assets/                  # banner/logo
```

Do **not** claim M2 module `approved` / release complete unless M2-PLAN §0.1 evidence is machine-verified.
Do **not** fabricate validation results. Prefer `node scripts/domain/test-all-domain.js` for the domain gate.

## Quick verification

### M3 meta-model

```
node scripts/meta/test-all.js
```

### M2 domain

```
node scripts/domain/test-all-domain.js
```

## Individual M3 commands

```
node scripts/meta/validate-yaml.js ontology/meta/*.yaml        # syntax
node scripts/meta/verify-meta-model.js                          # digests + imports + closures
node scripts/meta/validate-references.js                        # reference + version closure
node scripts/meta/validate-structure.js                         # deep structural (use --strict for typo checks)
node scripts/meta/test-structure-negative.js                    # negative tests
node scripts/meta/generate-owl.js && node scripts/meta/generate-shacl.js   # regenerate projection
node scripts/meta/test-projection.js                            # projection verification
```

M3 `test-all.js` runs the full meta-model gate (exit 0 = pass): YAML, digests/imports, ADR-011/012, references, structure (+strict), negative tests, OWL/SHACL projection, projection parse/validate, drift check.

## Individual M2 domain commands

```
node scripts/domain/validate-m2-core.js --all
node scripts/domain/validate-m2-core.js --all --strict
node scripts/domain/normalize-authoring-dialect.cjs --write
node scripts/domain/compute-digests.cjs
node scripts/domain/generate-m2-owl.cjs ontology/domain/finance/<mod>/module.yaml
node scripts/domain/generate-m2-shacl.cjs ontology/domain/finance/<mod>/module.yaml
node scripts/domain/validate-pit.cjs tests/m2/fixtures/negative/<file>.yaml
node scripts/domain/test-all-domain.js
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

## Learned User Preferences

- For M2 completeness reviews, read `reference/` project-by-project and file-by-file (FIBO/BIAN/regulatory ontologies and trading-engine source); treat them as authoritative alignment inputs alongside M2-PLAN.md.
- Do not cite `docs/domain/decisions/superseded/` or `releases/superseded/` as completion or approval evidence.
- `test-all-domain` PASS and module count do not substitute M2-PLAN §0.1's six acceptance criteria; keep Stop-Ship / draft until all are machine-verified.
- When SHACL smoke or other runtime prerequisites are missing, report `pending-*` status honestly — never fabricate PASS.

## Learned Workspace Facts

- `reference/` splits into `ontology-design-reference/` (FIBO, BIAN, FinRegOnt) and `project-reference/` (nautilus_trader, Lean, qlib, rqalpha, vnpy, lumibot, …).
- `docs/ontology/references/references.lock.yaml` uses `localPath` → `reference/` with real SHA-256 digests; paywalled sources are `unavailable-paywalled`, not zero placeholders.
- Canonical honest M2 progress lives in `docs/domain/decisions/PROGRESS-REPORT.md`; stale E3–E7 completion narratives are archived under `docs/domain/decisions/superseded/`.
- All 11 finance modules remain `status: draft` until ADR-014 authorizes an `approved` release.
- pySHACL smoke evidence (`docs/domain/infrastructure/shacl-smoke-evidence.json`) is separate from domain SHACL shapes Adopt; structural negative fixtures may still be SHACL-execution pending.
- FIBO alignment uses the `ext-fibo-release-local` adapter with `imports: []` — no full-ontology import anti-pattern (per FinRegOnt lesson).
