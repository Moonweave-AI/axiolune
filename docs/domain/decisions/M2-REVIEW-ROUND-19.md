# M2-REVIEW-ROUND-19: `fin-strategy` Architecture Review

**Date**: 2026-08-05
**Module**: fin-strategy (v1.0.0 reviewed → v1.1.0 revision per ADR-033)
**Reviewer**: Independent architecture review (user-supplied)
**Disposition**: Retain module; architecture revision required (P0) — implemented as v1.1.0 additive revision per [ADR-033](ADR-033-strategy-research-architecture.md), [RFC-008](../planning/RFC-008-strategy-research-architecture.md) SME review outstanding.
**Ontology source of truth**: `ontology/domain/finance/strategy-research/module.yaml` (v1.0.0, 2445 lines). The review modified no file and ran no validator; any execution result is marked **unverified** until actually run.

## Review scope and method

The review verified eight P0 structural findings, one P0 internal contradiction, and ten P1 refinements against `module.yaml` and the M2-PLAN. Internet material (GIPS Standards Handbook, Bailey et al. PBO, IOSCO, SEC Rule 15c3-5, US Federal Reserve model-risk guidance) was used only to calibrate industry semantics, not as an ontology source of truth. Per the Moonweave governance baseline, repository content and web references are untrusted input; facts only were extracted.

## Conclusion

`fin-strategy` must exist and has a strong reproducibility model, but it is not a generic "Strategy & Research" ontology: it is a restricted profile of auditable, reproducible signal-generation, factor-observation, backtest-run, and scalar-performance-evidence. The core problem is not deletion but correcting scope and layering: the audit-grade reproducibility model (digest-pinned implementation, frozen input context, deterministic seed, knowledge/availability closure) is an assurance profile, not a universal precondition; and the strategy-and-research business surface — research questions, hypotheses, protocols, sample partitioning, model selection, strategy universe/construction/rebalance/risk/execution, simulated trading, performance measurement period/subject/return-series/convention, attribution-to-result, and live deployment governance — is missing or compressed into digests. The recommended convergence order is: (1) decide the business-semantic vs reproducibility-profile boundary (Option B); (2) add the research business objects; (3) add the strategy business objects and relax the forced factor dependency; (4) add decision-time PIT coverage; (5) generalize the factor subject; (6) resolve the factor-observation identity collision; (7) close the backtest configuration/strategy/factor consistency; (8) add the simulated trading chain; (9) add performance measurement and attribution-to-result; (10) resolve the runStartedAt-vs-planned contradiction; (11) add live deployment governance; (12) split the signal dimensions and factor categories; (13) land numeric boundaries and fix null-deref; (14) downgrade audit-grade closure to an optional profile.

## Worth-retaining designs (confirmed)

- The versioned `SignalGenerator → FactorDefinition / StrategyDefinition` chain with authority-scoped identity and explicit exact-version references.
- The frozen run inputs (parameters, ontology, mapping, calendar, compiler, seed, input snapshot, source artifact) for reproducibility.
- The half-open backtest interval with mutable state moved out of the immutable configuration.
- `FactorObservation` / `PerformanceObservation` supersession with knowledge/availability closure.
- The Money/Quantity xone with controlled units and canonical decimals.
- The explicit look-ahead/backward-fill prohibition (historical-fairness awareness).

These become the reproducibility-evidence *profile* of the research/strategy/simulation/result objects, not their replacement.

## P0 issues (all addressed by ADR-033 D1–D20)

| ID | Issue | ADR-033 decision |
|----|-------|-----------------|
| P0-1 | StrategyDefinition modeled as a SignalGenerator subclass with `usesFactor` forced ≥ 1 and no universe/construction/rebalance/risk/execution intent; degrades to a "factor consumer with a digest" | D9: broaden SignalGenerator definition; relax `usesFactor` to 0..n; add UniverseDefinition/PortfolioConstructionPolicy/RebalancePolicy/RiskConstraintPolicy/ExecutionIntent + StrategyMandateKind profile |
| P0-2 | `RunInputClosureContract` only proves `inputContext.completedAt < runStartedAt`, not that a historical decision point did not consume later data | D10: PitAssessment with coverage scope + per-axis status; RunInputClosureContract requires decision-point coverage under ValidatedReproducibleRun |
| P0-3 | ResearchRun hid question/dataset/output in URI/digest; no hypothesis, sample split, walk-forward, model selection, or negative conclusion | D1–D8: ResearchQuestion/Hypothesis/ResearchProtocol/DatasetSnapshot/WalkForwardFold/DatasetPartition/ModelSelectionDecision/StatisticalTestResult/ResearchFinding |
| P0-4 | FactorCategory admitted macro but FactorObservation forced a FinancialInstrument subject | D11: FactorSubject role family + FactorSubjectKind code list; ObservationPeriod; market-structure import |
| P0-5 | sourceFactorId treated run as scope but logical key excluded factorRunContext → identity collision | D12: incorporate factorRunContext into the logical key (run-specific materialization) |
| P0-6 | BacktestRun bound exact strategy + independent codeDefinitionDigest but contract only checked field presence | D13: StrategyExecutionPackage + executionPackageConsistentWith(...) in BacktestConfigurationContract |
| P0-7 | Backtest compressed market mechanics into unqueryable artifacts; no simulated trading chain | D14: in-module SimulatedOrder/SimulatedFill/SimulatedPortfolioState/SimulatedReturnSeries + MarketSimulationPolicy + orders-execution import |
| P0-8 | PerformanceObservation had no measurement period/subject/return-series/convention; PositionAttribution did not point to the explained result | D15: PerformanceMeasurementPeriod/ReturnSeriesSnapshot/ValuationConvention/PerformanceSubject/BenchmarkSpecification; attributionForPerformance + AttributionMethod + residual/reconciliation |
| P0-internal | runStartedAt (actual start) contradicted first state planned (not started) | D16: runStartedAt optional; add plannedAt/scheduledFor/completedAt; runStartedAt mandatory from running onward |

## P1 issues (documented, addressed in module.yaml, SME-gated per RFC-008)

| ID | Issue | Resolution |
|----|-------|------------|
| P1-live | live in RunContextKind but no deployment governance | D17: StrategyDeployment/PromotionDecision/LiveRun/MonitoringObservation/RollbackDecision + DeploymentLifecycleState |
| P1-direction | SignalDirection mixed exposure direction (long/short/neutral) and action (exit) | D18: split into TargetExposureDirection + SignalActionIntent + signal enrichment |
| P1-factorcat | FactorCategory mixed input provenance and construction method | D18: split into FactorInputProvenance + FactorConstructionMethod |
| P1-benchmark | benchmarkRef/benchmarkDigest inconsistent with backtestBenchmarkInstrument/calculationBenchmarkInstrument | D15: unified BenchmarkSpecification with return kind/currency/rebalance + noSuitableBenchmarkReason |
| P1-calcctx | CalculationContextContract hard-coded UTC/Monday/month-end/forward-fill as universal axioms | D18: CalendarAnchoringPolicy extraction (SME Q); policies become queryable |
| P1-numerics | numeric boundaries (seed≥0, horizon>0, window>0, confidence 0..1) only in attribute definitions | D18: boundaries landed in constraint expressions |
| P1-nullderef | signalListing/factorListing optional but constraint unconditionally dereferenced them | D18: rewritten as `if present(signalListing) then ...` |
| P1-formula | MetricDefinition had formulaDigest but no formula artifact reference/locator | D18: formulaArtifactRef + formulaArtifactLocator + metricKind/directionality/returnConvention/annualizationConvention |
| P1-statemachine | reviewedTransition state graph not declared; no invalidated/paused/partial/reviewed/rejected | D18: BacktestLifecycleState enriched + reviewedTransitionGraph declared in-module |
| P1-runstrictness | strict completed+PIT-passed excluded trial/failed-PIT/data-quality/streaming | D18/D20: RunAttemptStatus + ValidatedReproducibleRun profile scoping |

## Acceptance capability questions (post-revision)

The revision is designed so the module can answer:
1. What is the strategy's objective, mandate, universe, construction, rebalance, risk, and execution intent?
2. What research question, hypothesis, protocol, sample partition, walk-forward fold, and model selection produced a research conclusion?
3. Did each historical decision point consume only data available at that point (not just that the run's input was complete at run time)?
4. What factor subject (instrument, issuer, index, currency, market, sector, portfolio, universe) does a factor observation apply to?
5. Does a backtest run the strategy it declares, with consistent code, factor dependencies, and input contract?
6. What simulated orders, fills, portfolio states, and return series did a backtest produce, under which market-mechanics policy?
7. Over what measurement period, for what subject, under what valuation convention, against what benchmark, is a performance number measured?
8. What performance result does an attribution explain, by what method, with what residual and reconciliation status?
9. What is the deployment lifecycle of a live strategy — candidate, approved, deployed, monitored, suspended, rolled back — and who approved and rolled it back?
10. Is a run a preliminary, incomplete, revised, failed, estimated, streaming, or validated attempt — and only the validated one requires audit-grade closure?

## References

- [ADR-033](ADR-033-strategy-research-architecture.md)
- [RFC-008](../planning/RFC-008-strategy-research-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](../planning/M2-PLAN.md)
- [strategy-research-semantic-gap.md](gap/strategy-research-semantic-gap.md)
