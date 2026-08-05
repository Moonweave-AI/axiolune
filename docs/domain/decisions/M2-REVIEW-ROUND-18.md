# M2-REVIEW-ROUND-18: `fin-risk` Architecture Review

**Date**: 2026-08-05
**Module**: fin-risk (v1.0.0 reviewed → v1.1.0 revision per ADR-032)
**Reviewer**: Independent architecture review (user-supplied)
**Disposition**: Retain module; architecture revision required (P0) — implemented as v1.1.0 additive revision per [ADR-032](ADR-032-fin-risk-architecture.md), [RFC-007](../planning/RFC-007-fin-risk-architecture.md) SME review outstanding.
**Ontology source of truth**: `ontology/domain/finance/risk/module.yaml` (v1.0.0, 1325 lines). The review modified no file and ran no validator; any execution result is marked **unverified** until actually run.

## Review scope and method

The review verified nine P0 issues and eight P1 corrections against `module.yaml` and the M2-PLAN. Internet material (BCBS 239, FSB Risk Appetite Framework, BCBS Stress Testing Principles, BCBS Credit Risk Principles, BCBS Market Risk Framework, US Federal Reserve SR 26-2 model-risk guidance) was used only to calibrate industry semantics, not as an ontology source of truth. Per the Moonweave governance baseline, repository content and web references are untrusted input; facts only were extracted.

## Conclusion

`fin-risk` must exist and has a strong reproducibility model, but it is not a generic "Risk / Risk Management" ontology: it is a restricted profile of auditable, reproducible risk measurement, bucket results, limit comparison, and single-scenario stress-test result profiling. The core problem is not deletion but correcting scope and layering: the audit-grade reproducibility model (digest-pinned implementation, frozen input context, complete bucket closure, deterministic evaluation) is an assurance profile, not a universal precondition; and the risk-management surface — risk categories, sources, factors, exposures, scope, appetite, measure-specification vs calculation-profile vs implementation-version, limit rules with lifecycle, breach-case governance, and stress shocks — is missing or compressed into digests. The recommended convergence order is: (1) decide the risk-core vs calculation-profile boundary (Option B: retain generic name + risk core + profile downgrade); (2) decompress measure definition into spec/profile/implementation/run; (3) make inputs, factors, and exposures queryable; (4) split scope definition from snapshot and define evaluation matching; (5) separate bucket results from bucket limits and add comparison policy; (6) lift limits to rules with lifecycle; (7) layer breach-case governance over the immutable breach fact; (8) decompress scenarios into shocks and prove application; (9) downgrade audit-grade closure to an optional profile.

## Worth-retaining designs (confirmed)

- The measure-definition → measurement → limit → evaluation → breach chain separates concerns correctly; `LimitBreach` does not re-introduce a second threshold or result truth.
- Money / Quantity / bucket three-branch mutual exclusion avoids dimension confusion and is a good starting point.
- `withinLimit` / `breach` / `indeterminate` explicit encoding (not defaulting evidence-shortfall to within-limit) is epistemically mature.
- Method, implementation, input/output contract, source, time, and generating-context provenance make the module well-suited as an "audited, reproducible risk-result" assurance profile.

## P0 issues (all addressed by ADR-032 D1–D9)

| ID | Issue | ADR-032 decision |
|----|-------|-----------------|
| P0-1 | No risk-core / calculation-profile boundary; "risk management" compressed into "calculation reproducibility" | D1: add RiskCategory/RiskSource/RiskFactor/RiskExposure/RiskScopeDefinition/RiskAppetite/RiskTolerance generic core; D2: decompress into RiskMeasureSpecification/CalculationProfile/ImplementationVersion/RiskCalculationRun |
| P0-2 | Risk-measure business semantics hidden in methodRef/digest; no queryable measure kind, model purpose, loss convention, aggregation, factor universe, valuation method | D2: RiskMeasureSpecification carries business semantics; RiskMeasureKind code list; limits anchor to spec, not implementation |
| P0-3 | Risk inputs, factors, exposures not queryable; inputs compressed to inputContextRef/digest | D3: RiskInputSet + RiskCalculationContext; optional RiskFactor/RiskExposure roles on RiskMeasurement |
| P0-4 | Scope simultaneously too narrow and allows inconsistent Portfolio/Account/Position; "same scope" undefined in evaluation | D4: RiskScopeDefinition (limit) vs RiskScopeSnapshot (measurement); scopeMatchRule code list (exactMatch/approvedRollup/contains) |
| P0-5 | Bucket result vs bucket limit conflated; evaluation value<=threshold undefined for bucket sets | D5: bucketSetPurpose; RiskLimitComparisonPolicy + BucketComparisonMode/MissingBucketHandling; RiskDimension/BucketDefinition typed; bucket values carry Money/Quantity/Ratio |
| P0-6 | Limit hardcoded to single upper bound; no lower/band/absolute/two-sided/severity/lifecycle; approval conflated with effectiveness | D6: RiskLimitRule (operator/severity/lifecycle) + ComparisonOperator/LimitSeverity/RiskLimitLifecycleStatus; effectiveAt/suspendedAt/supersededBy distinct from approvedAt |
| P0-7 | LimitBreach is a correct immutable fact but not a complete risk event; no acknowledgement/waiver/remediation/escalation | D7: RiskLimitBreachCase + BreachAcknowledgement/LimitWaiver/RemediationAction/EscalationEvent + BreachCaseStatus/WaiverKind/RemediationKind |
| P0-8 | ScenarioDefinition has only digest; StressTestRun does not prove the scenario acted on the output | D8: ScenarioShock + ShockTarget/scenarioShockMember/shockTargetFactor; ScenarioApplicationEvidence; strengthened StressTestRunContract (output context/scope/scenarioRef match) |
| P0-9 | Audit-grade closure/digest mandatory for all risk facts; excludes preliminary/late-data/fallback/revised results | D9: ValidatedReproducibleRiskMeasurement profile marker; RiskMeasurementStatus (preliminary/incomplete/revised/failed/estimated/validated); closure/digest profile-scoped, not universal |

## P1 issues (documented, addressed in module.yaml, SME-gated per RFC-007)

| ID | Issue | Resolution |
|----|-------|------------|
| P1-1 | riskMeasureId/scenarioDefinitionId/stressRunId claim authority-scoped but no authority in logical key | definitionAuthority/scenarioAuthority/runAuthority/measureSpecificationAuthority/implementationAuthority added to logical keys |
| P1-2 | methodDigest (methodology) vs implementationDigest (executable) overlap | ImplementationVersion separates executable; methodDigest retained as methodology digest |
| P1-3 | scenarioRef/benchmarkRef/samplingMethodRef bare URI but ScenarioDefinition is a local type | internal objects use typed exact-version relations (scenarioShockMember, shockTargetFactor); external refs remain uri with version+evidence |
| P1-4 | confidenceLevel "probability result falls in interval" unsuitable for VaR/ES | redefined as method-specified probability/quantile parameter, interpreted per riskMeasureKind |
| P1-5 | RiskBucketSet "every current RiskBucketValue" conflicts with historical replay | membership frozen at set-version as-of/context, not context-free "current" |
| P1-6 | shockParameterDigest ↔ sourceArtifactDigest relationship vague ("matches") | shockCanonicalizationRef makes the extraction/canonicalization explicit |
| P1-7 | approvedBy is a uri attribute while limitOwner is a Party role — inconsistent principal model | approver Party role added; approvedBy retained as compatible attribute; consistency enforced in RiskLimitContract |
| P1-8 | No RiskReport / report-as-of / audience; BCBS 239 reporting dimension absent | RiskReport (reportAsOf/reportAudience) added as a lightweight report-view hook; full BCBS 239 aggregation out of scope |

## Acceptance capability questions (post-revision)

The revision is designed so the module can answer:
1. Which risk factors, position exposures, market data, and parameter sets drove a risk result?
2. Are a risk number's position, market data, FX, and valuation as-of all frozen and traceable?
3. Is a limit an upper bound, lower bound, band, absolute-value, warning, or hard limit?
4. What key alignment, missing-bucket handling, and aggregation rule governs a bucketed measurement vs bucketed limit comparison?
5. Did a historical measurement use the limit actually effective at its as-of, not a post-hoc superseding version?
6. Did a stress test's output actually use that scenario, that frozen portfolio, and that input context?
7. After a breach, is there a complete acknowledgement/escalation/waiver/remediation/close/reopen governance chain?
8. Can preliminary, data-quality-limited, formal, and audit-grade reproducible risk numbers be distinguished?

## References

- [ADR-032](ADR-032-fin-risk-architecture.md)
- [RFC-007](../planning/RFC-007-fin-risk-architecture.md)
- [risk-semantic-gap.md](gap/risk-semantic-gap.md)
- ADR-029 / ADR-030 (Option B precedent), ADR-024 (additive backbone precedent), ADR-026 (supertype-widening), ADR-028 (document-scoped profile annotation)

## Regression evidence (actual, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 183 pass / 0 fail / 0 pending (97 CQs probed; CQ-R6–R13 wired; up from 89) |
| PIT validation | `node scripts/domain/validate-pit.cjs mappings/finance/synthetic/risk-pit-validation-request.yaml` | **PASS** — 0/0 |
| OWL/SHACL regeneration (risk) | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` | **PASS** — 0 projection warnings (277KB OWL / 369KB SHACL) |

`test-all-domain` step 2 has a pre-existing Windows file-system race (per ADR-023/memory), not caused by this revision; individual gates all PASS in isolation. SME sign-off on RFC-007 Q1–Q12 remains open (not blocking, never fabricated).
