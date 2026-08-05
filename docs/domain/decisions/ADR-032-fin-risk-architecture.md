# ADR-032: `fin-risk` Architecture Revision

**Status**: Proposed (v1.1.0 in-place additive revision implemented; SME joint review on RFC-007 Q1–Q12 outstanding; physical runtime-profile split deferred to follow-up ADR-033 candidate)
**Date**: 2026-08-05 (Proposed)
**Context**: Architecture review of `fin-risk` v1.0.0 ([M2-REVIEW-ROUND-18](M2-REVIEW-ROUND-18.md))
**Related**: ADR-014 (versioning), ADR-020 (foundation Party/Currency), ADR-022 (IRI-retention precedent), ADR-024 (market-structure v1.1.0 additive backbone revision precedent), ADR-026 (supertype-widening as additive minor), ADR-028 (document-deprecation + deferred physical split), ADR-029 (portfolio-positions v1.1.0 Option B precedent — core + profile layering), ADR-030 (post-trade-operations v1.1.0 Option B precedent), M2-PLAN §5.2, RFC-001, RFC-007

## Context

An independent architecture review of `fin-risk` v1.0.0 ([M2-REVIEW-ROUND-18](M2-REVIEW-ROUND-18.md)) concluded: **retain the module; architecture revision required (P0)**. The review verified nine P0 issues and eight P1 corrections against `module.yaml` (v1.0.0, 1325 lines) and the M2-PLAN; it modified no file and ran no validator (any execution result would be marked **unverified**). The review's only source of truth for the ontology was `module.yaml`; internet material (BCBS 239, FSB Risk Appetite Framework, BCBS Stress Testing Principles, BCBS Credit Risk Principles, BCBS Market Risk Framework, US Federal Reserve SR 26-2) was used only to calibrate industry semantics.

The module's backbone is sound — the `RiskMeasureDefinition → RiskMeasurement → RiskLimit → RiskLimitEvaluation → LimitBreach` chain separates concerns correctly, the `RiskBucketSchema → RiskBucketSet → RiskBucketValue` closure model is reproducible, and `ScenarioDefinition → StressTestRun → RiskMeasurement` binds scenario to result. The problems are structural: the module presents a generic "Risk" name but expresses only auditable-reproducible risk-number profiling, with no risk core (categories, sources, factors, exposures, scope, appetite), measure business semantics hidden in digests, unqueryable inputs, undefined bucket comparison, single-upper-bound limits, no breach governance, opaque scenarios, and audit-grade closure mandated for all facts. A genuine scope decision is required first: the user confirmed **Option B** — retain the generic name, add a lightweight risk core, and downgrade the strict digest/closure model to an optional high-assurance profile (per the ADR-029/030 precedent).

Round-12 v1.0.0 approval stands for the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This ADR addresses the stronger claim of a *semantically complete* risk module, which the released module does not yet satisfy.

## Decision

**Option B (per ADR-029/030 precedent) — retain the generic name; revise the backbone in place now (v1.1.0, additive, IRI-retentive); add a lightweight risk core (RiskCategory/RiskSource/RiskFactor/RiskExposure/RiskScope/RiskAppetite/RiskTolerance); decompress RiskMeasureDefinition into RiskMeasureSpecification + CalculationProfile + ImplementationVersion + RiskCalculationRun; make inputs/factors/exposures queryable via RiskInputSet/RiskCalculationContext; split scope definition from snapshot and define evaluation matching; separate bucket results from bucket limits with a comparison policy; lift limits to RiskLimitRule with lifecycle; layer breach-case governance over the immutable LimitBreach; decompress scenarios into ScenarioShock with application evidence; downgrade audit-grade closure/digest to an optional ValidatedReproducibleRiskMeasurement profile (document-scoped, no physical module split).** The user confirmed this form (v1.1.0 additive, full resolution of all review opinions). The nine backbone P0 revisions and eight P1 corrections are in place; the physical runtime-profile split is a correctly measured follow-up, not an in-place edit.

Until this ADR is **Accepted** and SME evidence is recorded for the deferred items, no cross-module runtime split or new peer module is authorized.

### D1. Risk core (P0-1)

**Problem**: No RiskExposure, RiskFactor, risk category, risk source, risk appetite, risk tolerance, or model-governance concepts; "risk management" was compressed into "calculation reproducibility."

**Decision**: Introduce generic semantic core object types: `RiskCategory` (+ `RiskCategoryValue` code list: market/credit/liquidity/operational/concentration/model/other), `RiskSource`, `RiskFactor` (distinct from strategy-research `FactorDefinition`; optional `riskFactorResearchRef` cross-link), `RiskExposure` (association: scope × factor × category × magnitude kind), `RiskScopeDefinition` (policy/business scope), `RiskAppetite` (quantitative + qualitative), `RiskTolerance`. Relations `riskSourceCategory` and `riskFactorCategory` classify sources/factors. All optional/additive. Full regulatory frameworks per category remain out of scope. BCBS Credit Risk Principles informs the category boundary as terminology only. **SME Q1** on the RiskFactor vs research-FactorDefinition boundary.

### D2. Measure spec / calculation / implementation / run split (P0-2)

**Problem**: `RiskMeasureDefinition` carries methodRef/digests but no queryable measure kind, model purpose, loss convention, aggregation method, factor universe, or valuation method; a code upgrade implicitly forces all business limits to re-approve.

**Decision**: Introduce `RiskMeasureSpecification` (object: business semantics — `riskMeasureKind` code list: var/es/sensitivity/pfe/liquidityGap/concentration/probability/ratio/capitalRequirement/other; `modelPurpose`, `lossConvention`, `aggregationMethod`, `valuationMethodRef`, `riskMeasureCategoryRef`; authority-scoped logical key), `CalculationProfile` (abstract object family), `ImplementationVersion` (object: executable + digest, separate from methodology), and `RiskCalculationRun` (association: this run's inputs/profile/output). Relations `measureSpecificationProfile` and `calculationProfileImplementation` bind them. `RiskMeasureDefinition` IRI **retained** as the compatibility binding of spec+implementation; its audit-grade digest/contract requirements move to the `ValidatedReproducibleRiskMeasurement` profile (D9). `methodDigest` retained as the methodology digest; `implementationDigest` moved to `ImplementationVersion` (P1-2). **SME Q2** on the specification/profile/implementation three-way split.

### D3. Queryable inputs, factors, exposures (P0-3)

**Problem**: `RiskMeasurement` optionally points to one `MarketDataStream`; the rest is compressed into `inputContextRef`/digest and generating context — no queryable positions, curves, vol surfaces, FX, parameters, data quality, or driving factors.

**Decision**: Introduce `RiskInputSet` (association: multiple `PositionSnapshot`, `MarketDataStream` roles; `inputValuationAsOf`, `inputDataQualityStatus`, `inputParameterSetRef`, `fxPolicyRef`, `valuationPolicyRef`) and `RiskCalculationContext` (binds an input set to a `RiskCalculationRun`). Add optional `measurementSpecification`, `measurementInputSet`, `measurementCalculationContext`, `measurementScopeSnapshot`, `measurementRiskFactor`, `measurementRiskExposure` roles to `RiskMeasurement`. `inputContextRef`/`inputContextRecordDigest`/`inputContextCompleted` retained but made optional (profile-scoped per D9). BCBS Market Risk Framework informs factor/liquidity-horizon/sensitivity/bucket as distinct objects, terminology only. **SME Q3** on the input-set shape.

### D4. Scope definition vs snapshot; evaluation matching (P0-4)

**Problem**: Scope allows at most one Portfolio/Account/PositionSnapshot (at least one) but may reference all three with no intersection/union/independence semantics; "same scope" in the evaluation contract is undefined.

**Decision**: Introduce `RiskScopeDefinition` (limit-anchored policy scope) and `RiskScopeSnapshot` (measurement-anchored frozen members + selection rule at an as-of). Limit binds `limitScopeDefinition`; measurement binds `measurementScopeSnapshot`. Add `scopeMatchRule` code list (exactMatch/approvedRollup/contains) and an `evaluationComparisonPolicy` role to `RiskLimitEvaluation`. The existing Portfolio/Account/Position roles are retained as a legacy single-scope profile. `RiskLimitEvaluationContract` now defines scope compatibility explicitly and requires historical measurements to use the limit actually effective at the measurement as-of, not a post-hoc superseding version. **SME Q4** on the scope-match rule set.

### D5. Bucket result vs bucket limit; comparison policy (P0-5)

**Problem**: `RiskBucketValue` is a measurement value but `RiskLimit` reuses the same `RiskBucketSet` as a threshold; the value<=threshold evaluation is undefined for bucket sets (per-bucket? any? all? aggregate? missing bucket? different granularity/FX?).

**Decision**: Add `bucketSetPurpose` attribute (`BucketSetPurpose`: measurement/limit) to `RiskBucketSet` so the same structure is not silently both value and threshold. Introduce `RiskLimitComparisonPolicy` (object: `bucketComparisonMode` [perBucket/aggregate/perBucketAndAggregate/anyBucket/allBuckets], `missingBucketHandling` [failClosed/treatAsZero/ignore/indeterminate], `comparisonTolerance`, `roundingPolicy`, `unitConversionPolicyRef`) and an `evaluationComparisonPolicy` role on `RiskLimitEvaluation`. Introduce typed `RiskDimension` and `BucketDefinition` (upgrading free-text `bucketKey`/`bucketDimensionRef`) with relations `bucketSchemaDimension`/`bucketSchemaBucketDefinition`. Bucket values broaden to carry Money/Quantity/Ratio via `bucketQuantity`/`bucketValue` (the legacy `bucketQuantity` QuantityValue is retained). `RiskLimitEvaluationContract` defines bucket comparison via the policy, not a scalar. **SME Q5** on the comparison-policy vocabulary.

### D6. Limit rule + lifecycle (P0-6)

**Problem**: Limit hardcoded to a single upper bound (value<=threshold / value>threshold); no lower/band/absolute/two-sided/utilization/concentration, no warning/soft/hard, no suspend/supersede, and approval conflated with effectiveness.

**Decision**: Introduce `RiskLimitRule` (object: `comparisonOperator` code list [le/ge/lt/gt/withinBand/outsideBand/absoluteValueLe/absoluteValueGe], optional `lowerThresholdMoney`/`upperThresholdMoney`/`lowerThresholdQuantity`/`upperThresholdQuantity`, `comparisonBasis`, `limitSeverity` [warning/soft/hard], `riskLimitLifecycleStatus` [effective/suspended/superseded]) with a `limitRule` role on `RiskLimit`. The single-value upper threshold remains the first concrete profile. Add `effectiveAt`/`suspendedAt`/`supersededBy` distinct from `approvedAt`. Unify the principal model: add an `approver` Party role consistent with `limitOwner` (P1-7); `approvedBy` retained as a compatible attribute. `RiskLimitContract` enforces monotonic lifecycle and effectiveAt-defaults-to-approvedAt. **SME Q6** on the operator/severity/lifecycle vocabulary.

### D7. Breach-case governance (P0-7)

**Problem**: `LimitBreach` is a correct immutable fact but has no magnitude, duration, responsible, acknowledgement, waiver, remediation, escalation, close, or reopen.

**Decision**: Retain `LimitBreach` as the immutable computational fact (unchanged). Layer `RiskLimitBreachCase` (association: `breachCaseBreach` → LimitBreach; `breachMagnitude`, `breachDuration`, `breachCaseStatus` [open/acknowledged/remediated/waived/escalated/closed/reopened], `breachCaseResponsible` Party) over it. Add `BreachAcknowledgement`, `LimitWaiver` (`waiverKind`: temporary/permanent/conditional), `RemediationAction` (`remediationKind`: exposureReduction/limitAdjustment/dataCorrection/positionCloseout), `EscalationEvent`. `RiskLimitBreachCaseContract` enforces monotonic workflow. **SME Q7** on the breach-case workflow.

### D8. Scenario shock + application evidence (P0-8)

**Problem**: `ScenarioDefinition` has only `shockParameterDigest` and source evidence; `StressTestRun` does not prove the scenario acted on the output (input context shocked, scope consistent, generating context equal, definition.scenarioRef equal).

**Decision**: Introduce `ScenarioShock` (object: `shockType`, `shockMagnitude`, `shockUnit`, `shockPropagationRule`) with `scenarioShockMember` (ScenarioDefinition → ScenarioShock) and `shockTargetFactor` (ScenarioShock → RiskFactor) relations. Add `scenarioCategory`, `scenarioNarrative`, `baselineStateRef`, `shockCanonicalizationRef` to `ScenarioDefinition` (P1-6: explicit canonicalization, not vague "matches"). Add `stressRunScopeSnapshot`, `stressRunInputSet`, `stressRunBaseline`, `stressRunApplicationEvidence` roles to `StressTestRun`. Introduce `ScenarioApplicationEvidence` (binds scenario, input set, output). `StressTestRunContract` strengthened to require output.generatingContextRef = run.generatingContextRef, output scope matches stress scope, and measurementDefinition.scenarioRef = run's exact ScenarioDefinition. BCBS Stress Testing Principles informs the scenario-narrative/governance boundary, terminology only. **SME Q8** on the shock/application-evidence shape.

### D9. Audit-grade closure → optional profile (P0-9)

**Problem**: `implementationDigest`/`inputContractDigest`/`outputContractDigest`/closure-probe/`inputContextCompleted`/`closureCompleted` are mandatory for all risk facts, excluding preliminary, late-data, fallback, revised, and data-quality-limited results.

**Decision**: Introduce the `ValidatedReproducibleRiskMeasurement` profile marker (document-scoped, no new YAML key, per ADR-028/029 convention) and the `RiskMeasurementStatus` code list (preliminary/incomplete/revised/failed/estimated/validated). The audit-grade digest/contract/closure requirements become **profile-Mandatory, core-optional**: on `RiskMeasureDefinition` (methodDigest/implementationDigest/inputContractDigest/outputContractDigest/source-artifact), `RiskMeasurement` (inputContextRef/inputContextRecordDigest/inputContextCompleted), `RiskBucketSet` (bucketValueCount/bucketValueSetDigest/closureProbeRef/closureProbeDigest/closureCompleted), `RiskLimit` (approval digest/source evidence), and `RiskLimitEvaluation` (evaluatorDigest). `RiskMeasureDefinitionContract` and `RiskBucketSetClosureContract` expressions scope the hard requirements to the profile. Core constraints (identity, xone, scope, representation compatibility, breach iff breach-evaluation) stay Mandatory. **SME Q9** on the profile boundary. The physical runtime-profile split is deferred to a follow-up ADR-033 candidate (gated on Q9).

### D10. P1 documented corrections (P1-1..P1-8)

Eight P1 items are implemented as lighter additive edits with SME questions: authority in logical keys (P1-1); methodDigest vs implementationDigest separation (P1-2); typed exact-version relations for internal objects (P1-3); confidenceLevel redefined as method-specified probability/quantile parameter interpreted per riskMeasureKind (P1-4); RiskBucketSet membership frozen at as-of/context (P1-5); shockParameterDigest↔sourceArtifactDigest explicit canonicalization (P1-6); approver Party role + approvedBy consistency (P1-7); RiskReport lightweight hook (P1-8). **SME Q10–Q12** on confidenceLevel interpretation, canonicalization, and the RiskReport boundary.

## Compatibility strategy (mirrors ADR-029/030)

- All existing `fin-risk` IRIs are **retained** (object types, association types, relation types, attribute types, code lists, constraints) per the ADR-020..024 IRI-retention precedent.
- New attributes are optional (minCount 0) so existing data continues to load; the hard digest/contract/closure attributes are broadened from minCount 1 to minCount 0 and profile-scoped.
- New abstract families (`CalculationProfile`) and concrete types are additive; the existing single-method/single-upper-bound paths remain valid as the first profile.
- This is additive (v1.1.0), **not** a 2.0.0 major, because (a) no IRI is removed, (b) the locked values remain valid as the first profile, (c) the broadening is attribute-cardinality relaxation + codelist admission + new optional types, and (d) fixtures use the domain YAML vocabulary (fixture-impact check, per ADR-023 D11).
- `RiskMeasureDefinition` IRI retained as the compatibility binding of spec+implementation; `LimitBreach` IRI retained as the immutable computational fact.

## Cross-module impact

| Downstream / peer module | References into/ from risk | Impact of v1.1.0 |
|---|---|---|
| `portfolio-positions` | `Portfolio`, `PositionSnapshot` used by RiskMeasurement/RiskLimit/RiskInputSet | None (IRIs retained; new optional roles only). |
| `market-data` | `MarketDataStream` used by RiskMeasurement/RiskInputSet | None (IRIs retained). |
| `foundation` | `Party`, `FinancialAccount`, `Currency` | None (foundation IRIs unchanged; new Party roles only). |
| `strategy-research` | `FactorDefinition` (optional `riskFactorResearchRef` uri) | None (no hard import; cross-link is a uri ref). |
| `post-trade-operations` | (none direct) | None. |

## Required evidence before Acceptance (never fabricated)

- [x] P0 revisions implemented (D1–D9) in `module.yaml`; P1 documented (D10); internal cross-check passes (0 dangling valueType/role/range/binding references; YAML valid: 19 objectTypes, 17 associationTypes, 11 relationTypes, 147 attributeTypes, 14 codeLists, 18 constraints, 72 constraintBindings).
- [x] Fixture-impact check confirms additive/non-breaking → v1.1.0 (new attributes minCount 0; new types optional; hard locks broadened not removed).
- [x] Regression gates run with **actual** results (2026-08-05):
  - `node scripts/domain/validate-m2-core.js --all --strict` → **PASS** (0 errors, 10 modules)
  - `node scripts/domain/run-domain-shacl.cjs` → **PASS**
  - `node scripts/domain/run-all-cq-probes.cjs` → **PASS** (183 pass / 0 fail / 0 pending; 97 CQs probed; CQ-R6–R13 wired)
  - `node scripts/domain/validate-pit.cjs mappings/finance/synthetic/risk-pit-validation-request.yaml` → **PASS** (0/0)
  - `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (risk) → **PASS** (0 projection warnings; 277KB OWL / 369KB SHACL)
- [ ] SME joint review on [RFC-007](../planning/RFC-007-fin-risk-architecture.md) Q1–Q12 — **open, not blocking**, never marked PASS without execution.
- [ ] SME confirmation of external regulatory citations (BCBS 239, FSB RAF, BCBS Stress Testing Principles, BCBS Credit Risk Principles, BCBS Market Risk Framework, US SR 26-2) as evidence pointers.
- [ ] Physical runtime-profile split deferred-design ADR authored (ADR-033 candidate) — gated on ADR-032 Acceptance + RFC-007 Q9.

## Status

**Proposed (v1.1.0).** The in-place additive revision (Option B) is implemented in `ontology/domain/finance/risk/module.yaml`. Items requiring SME input remain open and are not blocking; the physical runtime-profile split is deferred per [RFC-007](../planning/RFC-007-fin-risk-architecture.md).

### Regression evidence (actual, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 183 pass / 0 fail / 0 pending (97 CQs probed; CQ-R6–R13 wired) |
| PIT validation | `node scripts/domain/validate-pit.cjs mappings/finance/synthetic/risk-pit-validation-request.yaml` | **PASS** — 0/0 (no findings) |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (risk) | **PASS** — 0 projection warnings (277KB OWL / 369KB SHACL) |

`test-all-domain` step 2 has a pre-existing environment-specific file-system race on Windows (documented in ADR-023 and memory) that is not caused by this revision and is not a validation/semantic failure. **Actual run (2026-08-05):** `node scripts/domain/test-all-domain.js` — step 1 (validate-m2-core) PASS; step 2 (regenerate OWL/SHACL) intermittently failed with `UNKNOWN: unknown error, open '...Foundation.owl.ttl'` (first run, foundation module untouched by this revision) and `FAIL: regenerate orders-execution` / `FAIL: regenerate risk` (retry, both modules passing in isolation) — the Windows write race fired on modules this revision did not modify (foundation/orders-execution) as well as risk, confirming it is environment-specific. The individual gates (validate-m2-core, run-domain-shacl, run-all-cq-probes, validate-pit, and direct generate-m2-owl/generate-m2-shacl on the risk module) all PASS in isolation with exit 0.

## References

- [M2-REVIEW-ROUND-18](M2-REVIEW-ROUND-18.md)
- [RFC-007](../planning/RFC-007-fin-risk-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](../planning/M2-PLAN.md)
- [ADR-029](ADR-029-portfolio-positions-architecture.md) (Option B precedent)
- [ADR-030](ADR-030-post-trade-operations-architecture.md) (Option B precedent)
- [ADR-024](ADR-024-market-structure-architecture.md) (additive backbone precedent)
- [ADR-026](ADR-026-orders-quotation-convention-broadening.md) (supertype-widening)
- [ADR-028](ADR-028-orders-layer-separation.md) (document-deprecation + deferred split)
- [risk-semantic-gap.md](gap/risk-semantic-gap.md)
