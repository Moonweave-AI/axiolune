# RFC-008: `fin-strategy` Architecture

**Status**: Proposed — SME joint review outstanding (Q1–Q14 open, never fabricated as answered)
**Date**: 2026-08-05
**Module**: fin-strategy-research (v1.0.0 → v1.1.0 additive revision per [ADR-033](../decisions/ADR-033-strategy-research-architecture.md))
**Review**: [M2-REVIEW-ROUND-19](../decisions/M2-REVIEW-ROUND-19.md)

## Purpose

This RFC captures the open Subject-Matter-Expert (SME) questions raised by the v1.1.0 additive revision of `fin-strategy-research`. Per the Moonweave governance baseline, SME signatures are never fabricated; every question below is **open** and must be answered by a qualified SME before ADR-033 can move from **Proposed** to **Accepted**. No answer is recorded here.

The revision follows the established ADR-023→032 additive-revision precedent (Option B: retain the generic name, add a business-semantic core, downgrade audit-grade closure to an optional profile). The module backbone (versioned SignalGenerator, frozen run inputs, supersession closure, Money/Quantity xone, look-ahead prohibition) is retained; the revision adds research, strategy, simulation, performance, attribution, and deployment business semantics that the v1.0.0 reproducibility-evidence layer did not express.

## SME questions (open)

### Q1. Research-object shape
`ResearchQuestion` / `Hypothesis` / `ResearchProtocol` are introduced as separate object types bound by relations, with artifact digests retained as evidence. Is the three-object split (question / hypothesis / protocol) the right granularity, or should Hypothesis be folded into ResearchQuestion as an attribute family? What is the minimal set of required fields for a falsifiable research question?

### Q2. Research falsifiability boundary
`StatisticalTestResult` records testStatistic/pValue/effectSize/conclusionDisposition (supported/refuted/inconclusive) and `ResearchFinding` records conclusionType + narrative. Is this sufficient to express the sample-in / sample-out and candidate-selection falsifiability that the GIPS / PBO literature requires, or are additional objects (e.g. a dedicated `FalsifiabilityPlan`) needed? Where does the boundary between the research protocol and the statistical test result lie?

### Q3. Dataset-partition shape
`DatasetPartition` carries partitionKind (train/validate/test/walkForwardOutSample/holdout) over a DatasetSnapshot, with an optional WalkForwardFold. Is the partition vocabulary complete, and should the walk-forward fold be a role on DatasetPartition or a standalone object referenced by the partition?

### Q4. Strategy-profile boundary
`usesFactor` is relaxed to 0..n and the at-least-one-factor requirement is moved to a factor-strategy profile via `StrategyMandateKind` (factorDriven/indexTracking/executionAlgorithm/marketMaking/arbitrage/optionHedging/eventDriven/ruleBased). Is the mandate vocabulary complete, and is profile-scoping the factor requirement via the mandate the right mechanism, or should a dedicated constraint object enforce it?

### Q5. Decision-point PIT coverage vocabulary
`PitAssessment` carries `pitCoverageScope` (free text) and `pitAxisStatus` (valid/knowledge/availability/failed). The decision-point concepts (DecisionTime/SignalAsOf/FeatureAvailabilityCutoff/UniverseAsOf/OrderEligibleAt/ExecutionEligibleAt) are referenced in the `RunInputClosureContract` expression. Should these be typed objects or a closed code list, and what is the minimal coverage proof required under the `ValidatedReproducibleRun` profile?

### Q6. FactorSubject shape
The factor subject is generalized into an exclusive-choice role family (factorInstrument/factorListing/factorIssuer/factorIndex/factorCurrency/factorMarket/factorSector/factorPortfolio/factorUniverse) discriminated by `FactorSubjectKind`, with the `exactlyOneFactorSubject(...)` constraint. Is the role-family approach correct, or should a single generalized `FactorSubject` object with a kind discriminator be preferred? Are the nine subject kinds complete?

### Q7. Factor-observation logical-key resolution
`factorRunContext` is incorporated into the `FactorObservation` logical key, making a factor observation a run-specific materialization (the review's option 2). Does this require migrating existing factor-observation fixtures/data that assumed a cross-run logical identity, and is the run-specific materialization the correct interpretation over the cross-run domain-fact interpretation?

### Q8. Strategy execution package shape
`StrategyExecutionPackage` binds the exact strategy, executable implementation, factor-dependency closure, and input contract, and `BacktestConfigurationContract` requires mutual consistency. Is the consistency predicate `executionPackageConsistentWith(...)` implementable as a Custom expression, or does it need a SHACL SPARQL constraint? What fields must the package carry to close the "declare strategy A, run digest of strategy B" gap?

### Q9. Simulated trading chain boundary vs orders-execution
The simulated trading chain (SimulatedOrder/SimulatedFill/SimulatedPortfolioState/SimulatedReturnSeries) is placed *inside* `fin-strategy` with an `orders-execution` import, rather than narrowed out of scope or placed in `orders-execution`. Is the in-module placement correct, and what is the boundary between a `SimulatedOrder` and the `orders-execution` `OrderIntent`/`ExternalOrder` semantics it references? Is the `MarketSimulationPolicy` vocabulary (cash/financing/stockBorrow/tax/fx/liquidityCapacity/suspension/survivorship) complete?

### Q10. Performance measurement boundary
`PerformanceMeasurementPeriod` / `ReturnSeriesSnapshot` / `ValuationConvention` / `PerformanceSubject` / `BenchmarkSpecification` are added as optional roles on `PerformanceObservation`. Is scalar-result-as-first-profile the right compatibility boundary, and does the GIPS period/benchmark/fee/method-consistency requirement need additional objects beyond these?

### Q11. Attribution residual / reconciliation rule
`PositionAttribution` gains `attributionForPerformance` (→ PerformanceObservation), `attributionMethod`, `attributionResidual`, and `attributionReconciliationStatus` (reconciled/unreconciledResidual/notAssessed). Is the residual/reconciliation vocabulary sufficient, and should the reconciliation be a hard constraint (residual must be zero within tolerance) or a documented status?

### Q12. Deployment-governance lifecycle
`StrategyDeployment` / `PromotionDecision` / `LiveRun` / `MonitoringObservation` / `RollbackDecision` with `DeploymentLifecycleState` (candidate/approved/deployed/monitoring/suspended/rolledBack/retired) are added. Is the lifecycle complete, and what are the required transitions (e.g. must a rollback be preceded by a monitoring observation)? Is the approver Party role sufficient, or is a multi-approver quorum needed?

### Q13. Signal direction split and RunAttempt layering
`SignalDirection` is split into `TargetExposureDirection` (long/short/neutral) + `SignalActionIntent` (enter/exit/hold/adjust) with signal enrichment (rank/expectedReturn/alphaScore/confidenceInterval/targetWeight/positionChange). Is the split correct and is the enrichment vocabulary complete? Separately, `RunAttemptStatus` (preliminary/incomplete/revised/failed/estimated/streaming/validated) layers RunAttempt/ValidatedRunContext/CompletedRunEvidence — is this layering the right model for trial, failed-PIT, data-quality-pending, and streaming runs?

### Q14. FactorCategory split
`FactorCategory` is split into `FactorInputProvenance` (fundamental/technical/alternative/macro) + `FactorConstructionMethod` (statistical/deterministic/composite). Is the split correct, and should the two be composable (a factor has one provenance and one construction method) or unified?

## Out of scope (deferred)

- Physical runtime-profile split (ValidatedReproducibleRun as a separate module) — deferred to ADR-034 candidate, gated on ADR-033 Acceptance.
- Full GIPS compliance reporting aggregation — out of scope; the BenchmarkSpecification and ValuationConvention are lightweight hooks.
- Detailed risk semantics — defined in `fin-risk` and referenced, not re-defined here.

## References

- [ADR-033](../decisions/ADR-033-strategy-research-architecture.md)
- [M2-REVIEW-ROUND-19](../decisions/M2-REVIEW-ROUND-19.md)
- [RFC-001](RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](M2-PLAN.md)
