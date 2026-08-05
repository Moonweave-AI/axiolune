# Strategy Research Semantic Gap

**Module**: fin-strategy-research  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Models trading signals, factor observations, backtest runs, and performance metrics as reproducible research facts.
- Non-goal: embedding strategy execution engines or live order placement in M2.

## Track B (reference/ alignment)

- Qlib factor/alpha patterns and RD-Agent research loops inform signal and performance boundaries.
- Lean algorithm framework and Lumibot strategy lifecycle inform backtest run semantics only.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| SR-G1 | weak-cq | P1 | CQ-SR1-SR8 draft vs fixtures | **Closed** - 8 active CQs; strategy positive/negative YAML |
| SR-G2 | mapping-gap | P1 | Factor field to Signal mapping narrative | **Closed** - factor revision CQ chain + signal fixtures |
| SR-G3 | broken-boundary | P1 | Performance metric without backtest run | **Closed** - performance negatives + CQ-SR3 |
| SR-G4 | shallow-definition | P2 | Signal direction enum excludes | **Closed** - direction negative + CQ-SR7 |
| SR-G5 | orphan-type | P2 | Advanced performance variants | **Closed** (v1.0.0) — Sharpe CQ-SR6 sufficient; M1 extensions only |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Signal/backtest/performance identity keys |
| 2 | pass | Numeric metrics typed; availability enforced |
| 3 | pass | Signal/strategy/backtest definitions narratable |
| 4 | pass | Missing instrument/direction/run negatives |
| 5 | pass | knowledgeTo supersession in CQ-SR8 |
| 6 | pass | Eight active CQs; probes 0 pending |
| 7 | pass | Qlib + engine references in bibliography |
| 8 | pass | Factor revision + signal mapping fixtures |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)

---

## v1.1.0 revision section (Round-19, 2026-08-05)

An independent architecture review ([M2-REVIEW-ROUND-19](../M2-REVIEW-ROUND-19.md)) found the v1.0.0 module expressed a reproducibility-evidence layer rather than Strategy & Research business semantics, and required a P0 architecture revision. The revision is implemented as an additive v1.1.0 in-place edit per [ADR-033](../ADR-033-strategy-research-architecture.md), with SME questions open on [RFC-008](../../planning/RFC-008-strategy-research-architecture.md).

### New gaps closed by v1.1.0

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| SR-G6 | shallow-definition | P0 | Strategy as factor consumer; no universe/construction/rebalance/risk/execution | D9: strategy-profile object types + usesFactor relaxed to 0..n + StrategyMandateKind |
| SR-G7 | shallow-definition | P0 | Research question/dataset/output hidden in digests | D1–D8: ResearchQuestion/Hypothesis/ResearchProtocol/DatasetSnapshot/WalkForwardFold/DatasetPartition/ModelSelectionDecision/StatisticalTestResult/ResearchFinding |
| SR-G8 | broken-boundary | P0 | Factor forced to FinancialInstrument; macro/sector/curve unexpressable | D11: FactorSubject role family + FactorSubjectKind + ObservationPeriod |
| SR-G9 | orphan-type | P0 | Factor-observation identity collision across runs | D12: factorRunContext in logical key (run-specific materialization) |
| SR-G10 | shallow-definition | P0 | Backtest config not closed against strategy/implementation/factor consistency | D13: StrategyExecutionPackage + executionPackageConsistentWith |
| SR-G11 | broken-boundary | P0 | No simulated trading chain; market mechanics compressed | D14: SimulatedOrder/Fill/PortfolioState/ReturnSeries + MarketSimulationPolicy + orders-execution import |
| SR-G12 | shallow-definition | P0 | Performance without measurement period/subject/return-series/convention | D15: PerformanceMeasurementPeriod/ReturnSeriesSnapshot/ValuationConvention/PerformanceSubject/BenchmarkSpecification |
| SR-G13 | broken-boundary | P0 | Attribution did not explain a result; no method/residual/reconciliation | D15: attributionForPerformance + AttributionMethod + residual/reconciliation |
| SR-G14 | internal-contradiction | P0 | runStartedAt (actual start) vs planned (not started) | D16: runStartedAt optional; plannedAt/scheduledFor/completedAt |
| SR-G15 | shallow-definition | P0 | No decision-time PIT coverage proof | D10: PitAssessment with coverage scope + per-axis status |
| SR-G16 | shallow-definition | P1 | live without deployment governance | D17: StrategyDeployment/PromotionDecision/LiveRun/MonitoringObservation/RollbackDecision |
| SR-G17 | shallow-definition | P1 | SignalDirection mixed exposure + action; no enrichment | D18: TargetExposureDirection + SignalActionIntent + enrichment |
| SR-G18 | shallow-definition | P1 | FactorCategory mixed provenance + construction | D18: FactorInputProvenance + FactorConstructionMethod |
| SR-G19 | shallow-definition | P1 | MetricDefinition formula not locatable; no kind/directionality/convention | D18: formulaArtifactRef/Locator + metricKind/directionality/returnConvention/annualizationConvention |
| SR-G20 | shallow-definition | P1 | Status state machine not declared; missing states | D18: BacktestLifecycleState enriched + reviewedTransitionGraph |
| SR-G21 | broken-boundary | P1 | Audit-grade closure mandatory for all runs | D20: ValidatedReproducibleRun profile + RunAttemptStatus |

### SME-deferred items (open, not blocking)

- RFC-008 Q1–Q14 (research-object shape, falsifiability, dataset-partition, strategy-profile, decision-point PIT, FactorSubject, logical-key, execution-package, simulation-chain boundary, performance measurement, attribution residual, deployment lifecycle, signal/RunAttempt split, FactorCategory split).
- Physical runtime-profile split — ADR-034 candidate, gated on ADR-033 Acceptance.

### v1.1.0 regression evidence (actual, 2026-08-05)

- `validate-m2-core --all --strict` → PASS (10 modules, 0 errors)
- `run-domain-shacl.cjs` → PASS
- `run-all-cq-probes.cjs` → PASS (199 pass / 0 fail / 105 CQs; CQ-SR9–SR16 added covering research-to-conclusion, strategy business surface, execution-package closure, simulated trading chain, performance context, attribution-to-result, deployment governance, generalized factor subject)
- `validate-pit.cjs` → PASS (0/0)
- `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (strategy) → PASS (0 projection warnings; 405KB OWL / 510KB SHACL)
- Terminology cards: 8 → 19 (v1.1.0 cards added per ADR-032 precedent)

P0/P1 status: v1.1.0 revision implemented (Round-19 2026-08-05); SME review open per RFC-008.

