# RFC-007: `fin-risk` Architecture — SME Review

**Status**: Awaiting SME signatures
**Date**: 2026-08-05
**ADR**: [ADR-032](../decisions/ADR-032-fin-risk-architecture.md)
**Review**: [M2-REVIEW-ROUND-18](../decisions/M2-REVIEW-ROUND-18.md)

This RFC records the open questions requiring Subject-Matter-Expert (SME) joint review before ADR-032 can move from **Proposed** to **Accepted**. The v1.1.0 module records recommended answers as scaffolding; **the SME signatures below are the authoritative acceptance** and are not fabricated.

## SME panel required

- Market risk (VaR/ES, sensitivities, FRTB terminology)
- Credit risk (PFE, counterparty, concentration)
- Liquidity risk (liquidity gap, horizon)
- Limit governance (limit setting, breach workflow, escalation)
- Stress testing (scenario design, application, reverse stress)
- Model risk / model governance (validation, implementation versioning)
- Risk data aggregation / BCBS 239 (reporting, scope rollup)
- Data engineering (input sets, valuation as-of, data quality)

## Open questions

### Q1. RiskFactor vs research FactorDefinition boundary (D1)

Is `RiskFactor` (a risk-management concept: what a measure is sensitive to) correctly distinct from strategy-research `FactorDefinition` (a research signal generator), linked only optionally via `riskFactorResearchRef`? Should a `RiskFactor` carry a typed relation to `FactorDefinition` (requiring an import) or remain a uri cross-link (current scaffold, no hard import)?

**Recommended answer**: Distinct concepts; uri cross-link, no hard import (keeps the module DAG stable; a research factor is not always a risk factor and vice versa).

### Q2. Measure spec / profile / implementation split (D2)

Is the three-way `RiskMeasureSpecification` (business semantics) / `CalculationProfile` (method+parameters) / `ImplementationVersion` (executable+digest) split correct, with `RiskMeasureDefinition` retained as the compatibility binding? Should a limit anchor to the `RiskMeasureSpecification` (survives implementation upgrades) rather than the `RiskMeasureDefinition`?

**Recommended answer**: Three-way split correct; limit anchors to `RiskMeasureSpecification`; `RiskMeasureDefinition` retained for compatibility and as the first concrete binding.

### Q3. Input-set shape (D3)

Is `RiskInputSet` (multiple PositionSnapshot/MarketDataStream roles + `inputValuationAsOf`/`inputDataQualityStatus`/`inputParameterSetRef`/`fxPolicyRef`/`valuationPolicyRef`) the right granularity, or should curves/volatility surfaces/FX rates be first-class typed members rather than uri refs? Should `inputDataQualityStatus` be a closed code list or a string?

**Recommended answer**: First-class typed members deferred (the hooks are uri refs for v1.1.0); `inputDataQualityStatus` closed code list in a follow-up once the vocabulary is stable.

### Q4. Scope-match rule (D4)

Is the `ScopeMatchRule` set (exactMatch / approvedRollup / contains) complete? Should `approvedRollup` require a reference to the approved aggregation rule, or is the rollup implicit? Is a measurement at a finer scope evaluated against a coarser-scope limit permitted by default?

**Recommended answer**: Set complete as scaffolded; `approvedRollup` requires an explicit reference to the approved aggregation; finer-vs-coarser permitted only under `approvedRollup` or `contains`, not by default.

### Q5. Comparison-policy vocabulary (D5)

Is the `BucketComparisonMode` (perBucket/aggregate/perBucketAndAggregate/anyBucket/allBuckets) and `MissingBucketHandling` (failClosed/treatAsZero/ignore/indeterminate) set complete? Should `comparisonTolerance` be Money or Quantity, and how is it typed when the comparison crosses Money/Quantity? Should `RiskDimension`/`BucketDefinition` be required when a schema is bucketed, or optional upgrades?

**Recommended answer**: Sets complete; `comparisonTolerance` carries the same value-kind as the compared branch (Money or Quantity), with a unit-conversion policy when crossing; `RiskDimension`/`BucketDefinition` optional upgrades (free-text key remains valid).

### Q6. Limit rule / severity / lifecycle (D6)

Is the `ComparisonOperator` set (le/ge/lt/gt/withinBand/outsideBand/absoluteValueLe/absoluteValueGe) complete for real limit forms? Should `limitSeverity` (warning/soft/hard) be a property of the rule or of the limit, and should a hard breach always escalate? Is the lifecycle (effective/suspended/superseded) sufficient, or should it include `draft`/`pendingApproval`?

**Recommended answer**: Operator set complete; severity on the rule (a limit may have multiple rules of differing severity); hard breach escalates by default via D7; lifecycle sufficient (draft/pendingApproval are pre-approval states modeled in the approval record, not the live rule).

### Q7. Breach-case workflow (D7)

Is the `BreachCaseStatus` chain (open→acknowledged→remediated/waived/escalated→closed→reopened) correct and monotonic? Should `LimitWaiver` and `RemediationAction` be mutually exclusive or may both occur on one case? Is `EscalationEvent` a state transition or an independent auditable event?

**Recommended answer**: Chain correct and monotonic; waiver and remediation may both occur (a breach can be waived AND remediated); escalation is an independent auditable event that may co-occur with other dispositions.

### Q8. Shock / application-evidence shape (D8)

Is `ScenarioShock` (shockType/magnitude/unit/propagationRule + shockTargetFactor) the right granularity, or should shock targets include MacroVariable and Exposure (not only RiskFactor)? Is `ScenarioApplicationEvidence` a proof object or a binding assertion, and should `applicationProofDigest` be mandatory?

**Recommended answer**: Targets include RiskFactor now (MacroVariable/Exposure deferred); `ScenarioApplicationEvidence` is a binding assertion; `applicationProofDigest` optional in v1.1.0 (mandatory under the high-assurance profile).

### Q9. ValidatedReproducibleRiskMeasurement profile boundary (D9)

Which exact fields are purely audit-evidence (optional in the generic core) vs domain-closure (Mandatory)? Should `closureCompleted`/`bucketValueCount`/`bucketValueSetDigest` stay Mandatory (domain closure) or move entirely to the profile? Is the physical `fin-risk-runtime` split (ADR-033 candidate) the right eventual home for the profile?

**Recommended answer**: `implementationDigest`/`inputContractDigest`/`outputContractDigest`/`evaluatorDigest`/source-artifact evidence move to the profile; `closureCompleted`/`bucketValueCount`/`bucketValueSetDigest` stay Mandatory as domain closure when a bucket set claims completeness, but a preliminary set may omit them; physical split to `fin-risk-runtime` gated on this question.

### Q10. confidenceLevel interpretation (P1-4)

Is "method-specified probability/quantile parameter, interpreted per `riskMeasureKind`" the right definition (decoupling it from the VaR-specific "probability the result falls in an interval")? Should the allowed range and unit be constrained by `riskMeasureKind`?

**Recommended answer**: Decoupled definition correct; range/unit constraints per `riskMeasureKind` deferred to a follow-up once per-kind semantics are SME-confirmed.

### Q11. shockParameterDigest ↔ sourceArtifactDigest canonicalization (P1-6)

Is `shockCanonicalizationRef` (an explicit reference to the canonicalization mapping the source document to the shock-parameter payload) sufficient, or should the canonicalization itself be a typed object with its own digest? Should the relationship be required (mandatory) or optional?

**Recommended answer**: Sufficient as a uri ref for v1.1.0; typed canonicalization object deferred; required when both digests are present, optional otherwise.

### Q12. RiskReport boundary (P1-8)

Is `RiskReport` (reportAsOf/reportAudience) the right lightweight hook, or should it be deferred entirely to a future `fin-risk-reporting` module? Should `RiskReportSection` be introduced now or deferred? Is the BCBS 239 aggregation boundary correctly out of scope?

**Recommended answer**: Lightweight hook correct; `RiskReportSection` deferred; full BCBS 239 aggregation/reporting infrastructure out of scope and deferred to a future reporting module.

## Sign-off table

| Question | SME area | Recommended answer accepted? | SME signature | Date |
|---|---|---|---|---|
| Q1 | Market/credit risk | _awaiting_ | | |
| Q2 | Model governance | _awaiting_ | | |
| Q3 | Data engineering | _awaiting_ | | |
| Q4 | Risk data aggregation | _awaiting_ | | |
| Q5 | Market risk | _awaiting_ | | |
| Q6 | Limit governance | _awaiting_ | | |
| Q7 | Limit governance | _awaiting_ | | |
| Q8 | Stress testing | _awaiting_ | | |
| Q9 | Data engineering | _awaiting_ | | |
| Q10 | Market risk | _awaiting_ | | |
| Q11 | Stress testing | _awaiting_ | | |
| Q12 | Risk data aggregation | _awaiting_ | | |

## References

- [ADR-032](../decisions/ADR-032-fin-risk-architecture.md)
- [M2-REVIEW-ROUND-18](../decisions/M2-REVIEW-ROUND-18.md)
- [RFC-005](RFC-005-portfolio-positions-architecture.md) (SME-question precedent)
- [RFC-006](RFC-006-post-trade-operations-architecture.md) (SME-question precedent)
