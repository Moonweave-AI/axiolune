# AGENTS.md — Axiolune Ontology

## Repository layout (phase-separated)

```
ontology/meta/           # M3 meta-model YAML + projection (IRI-stable, do NOT move)
ontology/domain/         # M2 domain ontology (finance modules under ontology/domain/finance/)
scripts/meta/            # M3 validators + generators + tests (run from repo root)
scripts/domain/          # M2 validators + generators + test-all-domain
scripts/archive/         # one-shot migration scripts (completed, kept for audit)
docs/meta/               # M3-phase docs: decisions (ADRs), reports, design, reference
docs/domain/             # M2-phase docs: planning (M2-PLAN), decisions (ADR-013+)
  decisions/             # ADR-013+ domain ADRs + honest PROGRESS-REPORT
assets/                  # banner/logo
```

Do **not** fabricate validation results. Prefer `node scripts/domain/test-all-domain.js` for the domain gate (semantic checks only; digest/byte-lock gates removed).

## Canonical documentation (read first)

| Need | Path |
|------|------|
| What to read / cite | `docs/CANONICAL-INDEX.md` |
| Honest M2 progress | `docs/domain/decisions/PROGRESS-REPORT.md` |
| Current review verdict | `docs/domain/decisions/M2-REVIEW-ROUND-12.md` (v1.0.0 baseline) + Rounds 13–19 architecture wave |
| v1.0.0 completion + M1 handoff | `docs/domain/decisions/ADR-017-m2-v1-completion-and-m1-handoff.md` |
| Post-trade CQ matrix | `docs/domain/decisions/ADR-018-post-trade-cq-coverage-matrix.md` |
| Architecture ADRs (v1.1.0/v2.0.0) | `docs/domain/decisions/ADR-020-*.md` … `ADR-033-*.md` |
| M1 handoff entry | `docs/domain/handoffs/M2-V1.0.0-M1-HANDOFF.md` |
| Module alignments | `docs/ontology/alignments/` |
| Traceability matrices | `docs/ontology/traceability/` |
| v0.2.0 revocation | `docs/domain/decisions/ADR-015-revoke-v0.2.0-approval.md` |
| Exotic CA defer (P2) | `docs/domain/decisions/ADR-019-defer-exotic-corporate-actions.md` |
| M2 conformance contract | `docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md` |

**Do not cite** `docs/domain/decisions/superseded/` or `releases/superseded/` as completion or approval evidence.

## Quick verification

### M3 meta-model

```
node scripts/meta/test-all.js
```

### M2 domain

```
node scripts/domain/test-all-domain.js
node scripts/domain/run-all-cq-probes.cjs   # CQ honesty probes (199 pass / 105 CQs as of 2026-08-07)
node scripts/domain/run-pyshacl-smoke.cjs   # optional pySHACL smoke evidence JSON
node scripts/domain/audit-sidecar-sync.cjs  # sidecar/registry sync audit
node scripts/domain/merge-module-envelope.cjs <module> --write  # Phase B envelope merge
node scripts/domain/check-module-envelopes.cjs  # Phase B stale merge check
node scripts/domain/sync-terminology-sidecars.cjs --write  # regenerate terminology from module.yaml
```

Optional SHACL runtime smoke (not semantic acceptance): see `docs/domain/infrastructure/SHACL-RUNTIME-NOTES.md`.

## Individual M3 commands

```
node scripts/meta/validate-yaml.js ontology/meta/*.yaml        # syntax
node scripts/meta/verify-meta-model.js                          # YAML syntax (+ delegated reference closure)
node scripts/meta/validate-references.js                        # reference + version closure
node scripts/meta/validate-structure.js                         # deep structural (use --strict for typo checks)
node scripts/meta/test-structure-negative.js                    # negative tests
node scripts/meta/generate-owl.js && node scripts/meta/generate-shacl.js   # regenerate projection
node scripts/meta/test-projection.js                            # projection verification
```

M3 `test-all.js` runs the meta-model gate (exit 0 = pass): YAML, references, structure (+strict), negative tests, OWL/SHACL projection parse/validate. Digest locks and projection byte-drift checks are removed.

## Individual M2 domain commands

```
node scripts/domain/validate-m2-core.js --all
node scripts/domain/validate-m2-core.js --all --strict
node scripts/domain/normalize-authoring-dialect.cjs --write
node scripts/domain/generate-m2-owl.cjs ontology/domain/finance/<mod>/module.yaml
node scripts/domain/generate-m2-shacl.cjs ontology/domain/finance/<mod>/module.yaml
node scripts/domain/validate-pit.cjs tests/m2/fixtures/negative/<file>.yaml
node scripts/domain/test-all-domain.js
```

## Meta-model structure & conventions

- Four-layer meta-model in `ontology/meta/` (all at v0.6.0 — see meta ADR-013):
  - `core-meta-model.yaml` (Layer 1, v0.6.0) — semantic core: types, attributes, relations, associations, constraints, value objects
  - `cross-domain-patterns.yaml` (Layer 2, v0.6.0) — identity/time/provenance/evidence/lifecycle patterns + 9 constraint definitions
  - `behavior-meta-model.yaml` (Layer 3, v0.6.0) — query/function/action/policy
  - `data-binding-meta-model.yaml` (Layer 4, v0.6.0) — ADR-011 single truth source (SemanticMappingDefinition canonical)
- Imports use plain `moduleIri` + semver `version` (no content-addressed `#sha256:` fragments or `artifactDigest` locks).
- `ontology/meta/projection/` — generated M3->M2 output (do not hand-edit; regenerate with the generators). Deterministic.
- ADRs in `docs/meta/decisions/` (ADR-001..013). ADR-011 (canonical data binding) and ADR-012 (three-axis temporal) govern Layer 4; ADR-013 binds the M3 v0.6.0 breaking prerequisite that is the frozen M2 upstream baseline.

## Hard rules

- No `CURRENT_TIMESTAMP` / non-reproducible time functions anywhere in the meta-model (ADR-012). Use `$referenceTime` / `$queryTime` bound to `MaterializationRun`.
- Layer 4 single truth source: `SemanticMappingDefinition` is the only mapping structure. `Field.semanticMapping` and `SemanticFieldMapping` are PROHIBITED.
- `availableFrom`/`availableTo` are the canonical availability axis; `availableAt` was deprecated and removed in 0.6.0.
- Do not fabricate validation/test/projection results. Anything not machine-run must be marked "unverified".
- Generated SHACL Tier-1 (format/range + per-pattern shapes) is machine-verified by `rdf-validate-shacl` (incl. TemporalFactShape requiring validFrom/knowledgeFrom at minCount 1); Tier-2 is split into parameter-free direct `sh:sparql` (BOUND() syntax) and parameterized `sh:ConstraintComponent` (NoFutureKnowledge/AvailabilityBeforeUse with sh:parameter + sh:SPARQLSelectValidator) — parse-verified only; enforcement needs a SPARQL-capable SHACL engine (e.g. pyshacl).

## Learned User Preferences

- Prefer Chinese (Simplified) for user-facing responses when the user writes in Chinese.
- For M2 completeness reviews, use dual-track comparison: M2-PLAN module blueprint plus `reference/` read project-by-project and file-by-file (FIBO/BIAN/FinRegOnt and trading-engine source); treat both as authoritative alignment inputs.
- M2 target is the formal `approved` release path, but semantic/system completeness is the primary acceptance bar; formal validation gates are supporting evidence only — prefer content depth over hash/digest/date formalistic checks.
- Flights-style ontology quality (identity, constrained value types, narratable definitions, cross-entity integrity, mapping coherence) is a rubric mapped onto existing M2 dialect fields — do not invent new dialect fields like `verbalizes` / `identify_by`.
- Ontology visualization: show all information, but each element in semantically correct placement — relations as relation UI (edges/sidebar), not canvas nodes; separate type-native definitions/attributes from pattern-inherited fields (TemporalFact/ProvenancedFact).
- Do not cite `docs/domain/decisions/superseded/` or `releases/superseded/` as completion or approval evidence.
- `test-all-domain` PASS is a regression smoke signal only; semantic acceptance follows RFC-001 + Round review (Round-12 approved v1.0.0 2026-08-03).
- When SHACL smoke or other runtime prerequisites are missing, report `pending-*` status honestly — never fabricate PASS.

## Learned Workspace Facts

- `reference/` splits into `ontology-design-reference/` (FIBO, BIAN, FinRegOnt) and `project-reference/` (nautilus_trader, Lean, qlib, rqalpha, vnpy, lumibot, …).
- `fibo-ontology/` is the complete local FIBO mirror from `reference/ontology-design-reference/fibo` (~295 RDF modules as `{Name}.module.yaml` plus verbatim RDF); regenerate with `python scripts/fibo/import-fibo-ontology.py`.
- `fibo-visualization/` is the FIBO-only graph explorer (`fibo-visualization/generate.cjs`); distinct from repo-root `visualization/` (M3+M2 Axiolune ontology).
- `protege/` is the Protege-ready OWL/Turtle export of M3+M2; regenerate with `node scripts/protege/sync-protege-project.cjs` (reads versions from module.yaml); open `00-entry/axiolune-all.owl.ttl`; Protege 5.x loads `catalog-v001.xml` from the opened file's directory (no Preferences → Catalogs menu).
- `docs/ontology/references/references.bibliography.yaml` maps authorities to `reference/` local paths; paywalled sources note `unavailable-paywalled` in terminology cards — no SHA digest locks.
- Canonical M2 progress: [docs/domain/decisions/PROGRESS-REPORT.md](docs/domain/decisions/PROGRESS-REPORT.md) — **approved** v1.0.0 baseline per [M2-REVIEW-ROUND-12.md](docs/domain/decisions/M2-REVIEW-ROUND-12.md); v1.1.0/v2.0.0 architecture revisions per ADR-020–033 and Rounds 13–19. Do not cite superseded Round-9/v0.2 digest narratives or Round-11 alone as final sign-off.
- Active finance modules: 10 under `ontology/domain/finance/` (excluding `registry`); all **`status: approved`** — 3 at v2.0.0 (foundation, instruments, market-data) + 7 at v1.1.0 per `module-registry.yaml`.
- The former FIBO adapter `ext-fibo-release-local` is archived under `ontology/domain/archive/` (not an active module); keep `imports: []` / no full-ontology FIBO import (FinRegOnt lesson).
- pySHACL smoke evidence (`docs/domain/infrastructure/shacl-smoke-evidence.json`) is separate from domain SHACL shapes Adopt; structural negative fixtures may still be SHACL-execution pending.
