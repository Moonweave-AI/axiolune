# Risk Semantic Gap

**Module**: fin-risk  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Separates risk measure definitions, limits, exposure observations, scenarios, and limit breaches as reproducible facts.
- Non-goal: embedding calculation engines or conflating measure spec with a single computed result.
- Depends on portfolio-positions and market-data for inputs; feeds post-trade and governance breach narratives.

## Track B (reference/ alignment)

- FIBO FND/FBC risk and limit concepts inform RiskLimit and measure specification boundaries.
- Lean `PortfolioTarget`/`MaximumDrawdownPercent` and NautilusTrader risk modules inform limit-evaluation ordering only.
- Basel/internal risk policy docs cited terminology-only where public locators exist in bibliography.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| R-G1 | weak-cq | P0 | Stub CQ file vs 63+ types | **Closed** - 5 active CQs (CQ-R1-R5) |
| R-G2 | shallow-definition | P1 | Measure vs observation vs evaluation excludes | **Closed** - risk-v03 contract negatives |
| R-G3 | broken-boundary | P1 | Breach chain end-to-end | **Closed** - positive + negative breach chain fixtures |
| R-G4 | mapping-gap | P1 | Portfolio to exposure mapping slice | **Closed** - risk-v03 MaterializationRun fixtures |
| R-G5 | orphan-type | P2 | ScenarioDefinition / StressTestRun | **Closed** - CQ-R5 + ScenarioDefinition/StressTestRun types + stress fixtures |
| R-G6 | weak-cq | P0 | Empty staging fake PASS | **Closed** - probe loads risk records; CQ-R4 cross-module slice |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Measure/limit IDs + breach key in risk-v03 chain |
| 2 | pass | Money/Quantity/bucket schema enforced |
| 3 | pass | Definition vs measurement excludes in contract |
| 4 | pass | Breach counterexamples in risk-v03 cases |
| 5 | pass | TemporalFact demonstrated in fixtures |
| 6 | pass | Six active CQs (CQ-R1-R5); probes 110/0/0 |
| 7 | pass | FIBO FBC + engine locators in bibliography |
| 8 | pass | risk-v03 mapping + CQ-R4 execution trace slice |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)

## v1.1.0 revision track (Round-18, ADR-032)

An independent architecture review ([M2-REVIEW-ROUND-18](../M2-REVIEW-ROUND-18.md)) found the v1.0.0 "all gaps closed" claim held for the RFC-001 reproducibility contract but not for the stronger claim of a *semantically complete* risk module. The review raised nine P0 and eight P1 issues; all are resolved by the v1.1.0 additive revision (Option B) per [ADR-032](../ADR-032-fin-risk-architecture.md), with [RFC-007](../../planning/RFC-007-fin-risk-architecture.md) SME questions outstanding.

| ID | Class | Severity | Description | Resolution (ADR-032) |
|----|-------|----------|-------------|------------|
| R-G7 | missing-core | P0 | No risk core (categories/sources/factors/exposures/scope/appetite) | D1: RiskCategory/RiskSource/RiskFactor/RiskExposure/RiskScopeDefinition/RiskAppetite/RiskTolerance |
| R-G8 | shallow-definition | P0 | Measure business semantics hidden in methodRef/digest | D2: RiskMeasureSpecification + CalculationProfile + ImplementationVersion + RiskCalculationRun; RiskMeasureKind |
| R-G9 | unqueryable-input | P0 | Inputs/factors/exposures compressed to digest | D3: RiskInputSet + RiskCalculationContext; queryable roles on RiskMeasurement |
| R-G10 | broken-boundary | P0 | Scope too narrow + "same scope" undefined | D4: RiskScopeDefinition vs RiskScopeSnapshot; scopeMatchRule |
| R-G11 | shallow-definition | P0 | Bucket result vs bucket limit conflated; comparison undefined | D5: bucketSetPurpose; RiskLimitComparisonPolicy; RiskDimension/BucketDefinition |
| R-G12 | shallow-definition | P0 | Limit hardcoded to single upper bound; no lifecycle | D6: RiskLimitRule + ComparisonOperator/LimitSeverity/RiskLimitLifecycleStatus; effectiveAt |
| R-G13 | broken-boundary | P0 | LimitBreach has no governance case | D7: RiskLimitBreachCase + BreachAcknowledgement/LimitWaiver/RemediationAction/EscalationEvent |
| R-G14 | shallow-definition | P0 | Scenario opaque; run does not prove application | D8: ScenarioShock + ScenarioApplicationEvidence; strengthened StressTestRunContract |
| R-G15 | over-constraint | P0 | Audit-grade closure mandatory for all facts | D9: ValidatedReproducibleRiskMeasurement profile; RiskMeasurementStatus |
| R-G16 | weak-identity | P1 | Authority not in logical keys | P1-1: definitionAuthority/scenarioAuthority/runAuthority in keys |
| R-G17 | shallow-definition | P1 | methodDigest vs implementationDigest overlap | P1-2: ImplementationVersion separates executable |
| R-G18 | broken-boundary | P1 | confidenceLevel VaR-specific | P1-4: method-specified probability/quantile per riskMeasureKind |
| R-G19 | broken-boundary | P1 | RiskBucketSet "current" conflicts with replay | P1-5: membership frozen at as-of/context |
| R-G20 | broken-boundary | P1 | shockParameterDigest ↔ sourceArtifactDigest vague | P1-6: shockCanonicalizationRef |
| R-G21 | weak-identity | P1 | approvedBy vs limitOwner inconsistent | P1-7: approver Party role |
| R-G22 | missing-core | P1 | No reporting view | P1-8: RiskReport lightweight hook |

v1.1.0 status: implemented (2026-08-05); SME sign-off on RFC-007 Q1–Q12 outstanding; SHACL regression pending actual run.

