# ADR-033: `fin-strategy` Architecture Revision

**Status**: Proposed (v1.1.0 in-place additive revision implemented; SME joint review on RFC-008 Q1–Q14 outstanding; physical runtime-profile split deferred to follow-up ADR-034 candidate)
**Date**: 2026-08-05 (Proposed)
**Context**: Architecture review of `fin-strategy` v1.0.0 ([M2-REVIEW-ROUND-19](M2-REVIEW-ROUND-19.md))
**Related**: ADR-014 (versioning), ADR-020 (foundation Party/Currency), ADR-022 (IRI-retention precedent), ADR-024 (market-structure v1.1.0 additive backbone precedent), ADR-026 (supertype-widening as additive minor), ADR-028 (document-deprecation + deferred physical split), ADR-029 (portfolio-positions v1.1.0 Option B precedent — core + profile layering), ADR-030 (post-trade-operations v1.1.0 Option B precedent), ADR-032 (fin-risk v1.1.0 Option B precedent), M2-PLAN §5.2, RFC-001, RFC-008

## Context

An independent architecture review of `fin-strategy` v1.0.0 ([M2-REVIEW-ROUND-19](M2-REVIEW-ROUND-19.md)) concluded: **retain the module; architecture revision required (P0)**. The review verified eight P0 structural findings, one P0 internal contradiction, and ten P1 refinements against `module.yaml` (v1.0.0, 2445 lines) and the M2-PLAN; it modified no file and ran no validator (any execution result would be marked **unverified**). The review's only source of truth for the ontology was `module.yaml`; internet material (GIPS Standards Handbook, Bailey et al. PBO, IOSCO, SEC Rule 15c3-5, US Federal Reserve model-risk guidance) was used only to calibrate industry semantics, not as an ontology source of truth.

The module's backbone is sound — the versioned `SignalGenerator → FactorDefinition / StrategyDefinition` chain, frozen run inputs (parameters, ontology, mappings, calendar, compiler, seed, PIT), the half-open backtest interval with mutable state moved out, `FactorObservation` / `PerformanceObservation` supersession plus knowledge/availability closure, the Money/Quantity xone with controlled units, and the explicit look-ahead/backward-fill prohibition are all worth retaining. The problems are structural: "Strategy & Research" is expressed as a reproducibility-evidence layer (digests, locks, closures) rather than business semantics. Strategy is a "factor consumer with an implementation digest"; research questions, datasets, and outputs are hidden in URIs and digests; factors are force-fit to `FinancialInstrument`; backtest compresses market mechanics into unqueryable artifacts; performance has no measurement period, subject, return series, or convention; attribution does not point to the result it explains; live has no deployment governance; and `runStartedAt` (actual start) contradicts a first lifecycle state of `planned` (not started).

A genuine scope decision was required first. The user confirmed **Option B** (per the ADR-029/030/032 precedent) — retain the generic name, add a lightweight research/strategy/simulation/deployment business-semantic core, decompress digests into queryable business objects (keeping digests as their evidence), and downgrade the audit-grade digest/closure model to an optional `ValidatedReproducibleRun` profile (document-scoped, no physical module split). The user additionally chose the most-thorough path on three scope questions: **(1)** expand the simulated trading chain *inside* this module rather than narrowing scope, **(2)** add a full live deployment-governance layer, and **(3)** implement all P0 and P1 findings in place.

Round-12 v1.0.0 approval stands for the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This ADR addresses the stronger claim of a *semantically complete* Strategy & Research module, which the released module did not yet satisfy.

## Decision

**Option B (per ADR-029/030/032 precedent) — retain the generic name; revise the backbone in place now (v1.1.0, additive, IRI-retentive); add a research business-semantic core (ResearchQuestion/Hypothesis/ResearchProtocol/DatasetSnapshot/WalkForwardFold/DatasetPartition/ModelSelectionDecision/StatisticalTestResult/ResearchFinding); add a strategy business-semantic core (UniverseDefinition/PortfolioConstructionPolicy/RebalancePolicy/RiskConstraintPolicy/ExecutionIntent/StrategyExecutionPackage) with `usesFactor` relaxed to 0..n; add a decision-time PIT core (PitAssessment with coverage scope); generalize the factor subject via a FactorSubject role family and a structured ObservationPeriod; resolve the factor-observation identity collision by incorporating `factorRunContext` into the logical key; add an in-module simulated trading chain (SimulatedOrder/SimulatedFill/SimulatedPortfolioState/SimulatedReturnSeries under a MarketSimulationPolicy) plus an `orders-execution` import; add performance measurement period/return-series/valuation-convention/subject and a versioned BenchmarkSpecification; link attribution to the result it explains via `attributionForPerformance` with an AttributionMethod and residual/reconciliation; resolve the `runStartedAt`-vs-`planned` contradiction by splitting plan/execution/status timing; add a full live deployment-governance layer (StrategyDeployment/PromotionDecision/LiveRun/MonitoringObservation/RollbackDecision); split SignalDirection into TargetExposureDirection + SignalActionIntent and add signal enrichment; split FactorCategory into FactorInputProvenance + FactorConstructionMethod; land numeric boundaries in contracts; fix optional-listing null-deref; add the formula artifact reference; enrich the status state machine; and downgrade audit-grade digest/closure to an optional `ValidatedReproducibleRun` profile (document-scoped, no physical module split).** The user confirmed this form (v1.1.0 additive, full resolution of all review opinions). The eight P0 findings, one P0 contradiction, and ten P1 refinements are in place; the physical runtime-profile split is a correctly measured follow-up, not an in-place edit.

Until this ADR is **Accepted** and SME evidence is recorded for the deferred items, no cross-module runtime split or new peer module is authorized.

### D1–D8. Research semantics (P0-3)

**Problem**: `ResearchRun` hid the research question, dataset, and output in URI/digest fields; no hypothesis, sample partition, train/validate/test, walk-forward, parameter search, candidate set, model selection, or negative conclusion.

**Decision**: Introduce `ResearchQuestion` (object: `researchQuestionText`, `hypothesisRef`/typed, `researchProtocolRef`/typed; digest retained as evidence), `Hypothesis` (object: `hypothesisStatement`, `hypothesisDirection`, `statisticalTestPlanRef`), `ResearchProtocol` (object: `modelSelectionCriteria`, digest), `WalkForwardFold` (object: training/test windows, anchor), `DatasetSnapshot` (object: digest + locator), and the associations `DatasetPartition` (partitionKind: train/validate/test/walkForwardOutSample/holdout), `ModelSelectionDecision` (selectedGenerator + selectionRunContext + score/basis), `StatisticalTestResult` (testStatistic/pValue/effectSize/conclusionDisposition: supported/refuted/inconclusive), and `ResearchFinding` (conclusionType + narrative). Relations `researchRunQuestion`, `researchQuestionHypothesis`, `researchQuestionProtocol` bind them. The artifact digests are retained as the evidence of these business objects, not their replacement. **SME Q1–Q3** on the research-object shape, the falsifiability boundary, and the dataset-partition shape.

### D9. Strategy business semantics (P0-1)

**Problem**: `StrategyDefinition` was modeled as a `SignalGenerator` subclass with `usesFactor` forced ≥ 1 and no universe, construction, rebalance, risk, leverage, financing, or execution intent; it degraded to a "factor consumer with an implementation digest" and could not express index tracking, execution algorithms, market making, arbitrage, option hedging, event-driven, or rule-based strategies.

**Decision**: Retain the `SignalGenerator` IRI (abstract) with a broadened definition (supertype-widening per ADR-026). **Relax `usesFactor` outbound cardinality from minCount 1 to 0** (additive relaxation); the at-least-one-factor requirement is enforced only in a factor-strategy profile via `StrategyMandateKind` (factorDriven/indexTracking/executionAlgorithm/marketMaking/arbitrage/optionHedging/eventDriven/ruleBased), not universally. Add optional strategy-profile object types wired from `StrategyDefinition` via new relations: `UniverseDefinition`, `PortfolioConstructionPolicy`, `RebalancePolicy`, `RiskConstraintPolicy`, `ExecutionIntent`. Add `strategyObjective` and `strategyMandateKind` attributes. **SME Q4** on the strategy-profile boundary.

### D10. Decision-time PIT (P0-2)

**Problem**: `RunInputClosureContract` only required `inputContext.completedAt < runStartedAt`, proving the run's input was complete at run time, not that a 2018 historical decision point did not consume later-published, revised, or back-filled data.

**Decision**: Introduce `PitAssessment` (association: `assessmentRunContext` + `supersedesPitAssessment`; `pitAssessmentRef`/`digest`, `pitCoverageScope`, `pitAxisStatus`: valid/knowledge/availability/failed). `RunInputClosureContract` enhanced to require, under the `ValidatedReproducibleRun` profile, that the PIT assessment covers each historical decision point (DecisionTime/SignalAsOf/FeatureAvailabilityCutoff/UniverseAsOf/OrderEligibleAt/ExecutionEligibleAt), not only that the input context preceded the run. The strict prior-completed input context remains the first profile; the hard requirement is profile-scoped (D20). **SME Q5** on the decision-point coverage vocabulary.

### D11. Factor subject generalization (P0-4)

**Problem**: `FactorCategory` admitted `macro` but `FactorObservation` forced a `FinancialInstrument` subject, forcing macro, industry, country, market-breadth, curve, and portfolio factors to masquerade as instruments.

**Decision**: Generalize `factorInstrument` into an exclusive-choice **FactorSubject** role family: `factorInstrument`/`factorListing`/`factorIssuer`/`factorIndex`/`factorCurrency`/`factorMarket`/`factorSector`/`factorPortfolio`/`factorUniverse` (existing `factorInstrument` IRI retained as one branch), discriminated by the `FactorSubjectKind` code list (instrument/listing/issuer/index/currency/market/sector/portfolio/universe/globalScope). The `exactlyOneFactorSubject(...)` constraint enforces exactly one subject branch. Add `market-structure` to the module imports to support the TradingVenue/MarketSegment subject branches. Upgrade `reportingPeriodKey` from a free string to an optional structured `ObservationPeriod` reference (`observationPeriodRef`). **SME Q6** on the FactorSubject shape.

### D12. Factor-observation identity collision (P0-5)

**Problem**: `sourceFactorId` treated the run as scope, but `FactorRevisionContract`'s logical key excluded `factorRunContext` and treated it as version content, so observations of the same factor and subject in different runs would collide.

**Decision**: Resolve the dual interpretation by incorporating `factorRunContext` into the `FactorObservation` logical key (`logicalKey(observedFactor, factorSubject, sourceFactorId, reportingPeriodKey, factorRunContext)`), making a factor observation a run-specific materialization. The "version content, not part of logical key" clause is removed. `sourceFactorId` is defined to match. **SME Q7** on the logical-key resolution and any fixture/data migration.

### D13. Backtest configuration closure (P0-6)

**Problem**: `BacktestRun` bound an exact `StrategyDefinition` and an independent `codeDefinitionDigest`, but `BacktestConfigurationContract` only checked field presence, not that the strategy, implementation, factor-dependency closure, and input contract were mutually consistent, allowing "declare strategy A, run digest of strategy B".

**Decision**: Introduce `StrategyExecutionPackage` (object: binds the exact strategy, its executable implementation, factor-dependency closure, and input contract; `factorDependencyClosureDigest`). `BacktestRun` gains a `backtestExecutionPackage` role. `BacktestConfigurationContract` enhanced to require `executionPackageConsistentWith(package, backtestStrategy, codeDefinitionDigest, factorDependencyClosure, inputContract)` when an execution package is present. `codeDefinitionDigest` retained as compatibility evidence. **SME Q8** on the execution-package shape.

### D14. Simulated trading chain — in module (P0-7)

**Problem**: Backtest compressed fees, slippage, fills, and corporate actions into unqueryable artifacts; `orders-execution` was not imported; the Decision→SimulatedOrder→SimulatedFill→PortfolioState→ReturnSeries chain was unexpressed.

**Decision**: Add `orders-execution` to the module imports (an already-approved module; satisfies the DAG). Add in-module simulation object types `SimulatedOrder`, `SimulatedFill`, `SimulatedPortfolioState`, `SimulatedReturnSeries` and the relations `simulatedOrderBacktest`, `simulatedFillOrder`, `simulatedPortfolioStateFill`, `simulatedReturnSeriesState`. Add `MarketSimulationPolicy` (object: `cashPolicyRef`/`financingPolicyRef`/`stockBorrowPolicyRef`/`taxPolicyRef`/`fxPolicyRef`/`liquidityCapacityPolicyRef`/`suspensionPolicyRef`/`survivorshipPolicyRef`) and the `backtestSimulationPolicy` relation, so cash, financing, stock borrow, tax, FX, liquidity/capacity, suspension, and survivorship rules are queryable rather than compressed into a digest. Fee/slippage/fill assumptions remain as evidence but are now also queryable via the policy. The pure return-simulation path remains valid as the first profile (additive). **SME Q9** on the simulation-chain boundary vs `orders-execution` and the MarketSimulationPolicy vocabulary.

### D15. Performance & attribution (P0-8)

**Problem**: `PerformanceObservation` had no measurement period, subject, return series, gross/net, TWR/MWR, currency, or result package; `PositionAttribution` did not point to the explained performance result and lacked method, residual, and reconciliation.

**Decision**: Add `PerformanceMeasurementPeriod` (measurementPeriodFrom/To, measurementAsOf), `ReturnSeriesSnapshot` (digest; scalar remains the first profile), `ValuationConvention` (`netGrossConvention`: gross/netOfFees/netOfFeesAndTax), `PerformanceSubject`, and `BenchmarkSpecification` (benchmarkReturnKind: totalReturn/price/excessReturn; benchmarkCurrency; benchmarkRebalance; `noSuitableBenchmarkReason` — also fixes the P1 benchmark inconsistency). `PerformanceObservation` gains optional roles to these. `PositionAttribution` gains `attributionForPerformance` (→ `PerformanceObservation`) and `attributionMethod` (→ `AttributionMethod` with `attributionComponentType`: allocation/selection/interaction, `attributionAggregationScope`: perPeriod/cumulative/annualized, `attributionReconciliationRule`), plus `attributionResidual` and `attributionReconciliationStatus` (reconciled/unreconciledResidual/notAssessed). Attribution now explains a result, not just carries a number. **SME Q10–Q11** on the performance-measurement boundary and the attribution residual/reconciliation rule.

### D16. runStartedAt vs planned (P0 internal contradiction)

**Problem**: `RunContext` mandated `runStartedAt` as the actual start instant, but `BacktestStatusContract` required the first state to be `planned` (execution not started), a contradiction.

**Decision**: Broaden `runStartedAt` from minCount 1 to **0 (optional)**; add optional `plannedAt`, `scheduledFor`, `completedAt`. `RunInputClosureContract` requires `plannedAt <= runStartedAt <= completedAt` when present, and `runStartedAt` becomes mandatory from the `running` lifecycle state onward (enforced in `BacktestStatusContract`). `planned` first event uses `plannedAt`, not `runStartedAt`. Resolves the contradiction additively (cardinality relaxation + new optional fields).

### D17. Live deployment governance (P1)

**Problem**: `live` was in `RunContextKind` but there was no LiveRun, deployment approval, promotion, suspension, rollback, monitoring, drift, or human-takeover model.

**Decision**: Add `StrategyDeployment` (object: `deploymentLifecycleState`: candidate/approved/deployed/monitoring/suspended/rolledBack/retired), `LiveRun` (RunContext subclass, `runContextKind=live`), and the associations `PromotionDecision` (candidate + deployment + approver Party + criteria), `MonitoringObservation` (deployment + runContext + driftIndicator: noDrift/minorDrift/significantDrift), `RollbackDecision` (deployment + approver Party + reason). Relations `deploymentStrategy` and `liveRunDeployment` bind them. `live` is now semantically backed by the deployment model. **SME Q12** on the deployment-governance lifecycle.

### D18. P1 documented corrections

Ten P1 items implemented as lighter additive edits with SME questions: SignalDirection split into `TargetExposureDirection` (long/short/neutral) + `SignalActionIntent` (enter/exit/hold/adjust) plus signal enrichment (`signalRank`/`expectedReturn`/`alphaScore`/`signalConfidenceInterval`/`targetWeight`/`positionChange`), `signalStrength` optional (Q13); FactorCategory split into `FactorInputProvenance` + `FactorConstructionMethod` (Q14); numeric boundaries landed in constraints (`deterministicSeed >= 0`, `signalHorizon > 0`, `calculationWindow > 0`, `0 <= confidenceLevel <= 1`); optional-listing null-deref rewritten as `if present(signalListing) then ...`; `MetricDefinition` formula artifact reference/locator added plus `metricKind`/`metricDirectionality`/`returnConvention`/`annualizationConvention`; `BacktestLifecycleState` enriched with invalidated/paused/partial/reviewed/rejected and the `reviewedTransitionGraph` declared in-module; `RunAttemptStatus` (preliminary/incomplete/revised/failed/estimated/streaming/validated) for the RunAttempt/ValidatedRunContext/CompletedRunEvidence layering (Q13).

### D20. Audit-grade closure → optional profile (P0/P1)

**Problem**: The audit-grade digest/contract/closure/PIT-passed requirements were mandatory for all run facts, excluding preliminary, late-data, fallback, revised, data-quality-limited, and streaming results.

**Decision**: Introduce the `ValidatedReproducibleRun` profile marker (document-scoped, no new YAML key, per ADR-028/029/032 convention) and the `RunAttemptStatus` code list. The audit-grade digest/contract/closure/PIT-passed requirements become **profile-Mandatory, core-optional**: on `SignalGenerator` (implementation/contract/tool/runtime digests, source-artifact), `RunContext` (input-context/PIT/calendar/compiler closure), `BacktestRun` (config digests), `MetricDefinition` (formula/implementation/contract digests), `CalculationContext` (implementation/parameter-snapshot). Core constraints (identity, xone, scope, representation compatibility, supersession, half-open interval, look-ahead prohibition, exactly-one factor subject) stay Mandatory. The physical runtime-profile split is deferred to a follow-up ADR-034 candidate (gated on SME Q).

## Compatibility strategy (mirrors ADR-029/030/032)

- All existing `fin-strategy` IRIs are **retained** (8 objectTypes, 5 associationTypes, 11 relationTypes, ~60 attributeTypes, 6 codeLists, 15 constraints) per the ADR-020..024 IRI-retention precedent.
- New attributes are optional (minCount 0) so existing data continues to load; the hard digest/contract/closure attributes are broadened from minCount 1 to minCount 0 and profile-scoped.
- New abstract families and concrete types are additive; the existing single-strategy/single-instrument/return-simulation paths remain valid as the first profile.
- This is additive (v1.1.0), **not** a 2.0.0 major, because (a) no IRI is removed, (b) the locked values remain valid as the first profile, (c) the broadening is attribute-cardinality relaxation + codelist admission + new optional types, and (d) fixtures use the domain YAML vocabulary (fixture-impact check, per ADR-023).
- `orders-execution` and `market-structure` added to imports are new imports of **already-approved** modules (satisfy the DAG; no forward reference).

## Cross-module impact

| Downstream / peer module | References into/ from strategy | Impact of v1.1.0 |
|---|---|---|
| `orders-execution` | NEW import; SimulatedOrder/Fill reference its order/fill semantics | New optional import; orders-execution IRIs unchanged; simulation uses typed refs. |
| `market-structure` | NEW import; TradingVenue/MarketSegment used as factor subjects | New optional import; market-structure IRIs unchanged. |
| `portfolio-positions` | Portfolio/PositionSnapshot/PositionLot used by backtest/attribution/simulation | None (IRIs retained; new optional roles only). |
| `instruments` | FinancialInstrument/InstrumentListing used by signal/factor/benchmark | None (IRIs retained; FactorSubject generalizes, doesn't remove). |
| `market-data` | (price observations for simulation) | None hard; optional simulation-policy refs. |
| `foundation` | Party (authority/approver) | None (new Party roles only). |
| `risk` | (no direct import) | None. |

## Required evidence before Acceptance (never fabricated)

- [x] P0 revisions implemented (D1–D17) in `module.yaml`; P1 documented (D18); audit-grade closure downgraded to profile (D20); internal cross-check passes (0 dangling valueType/role/range/binding references; YAML valid).
- [x] Fixture-impact check confirms additive/non-breaking → v1.1.0 (new attributes minCount 0; new types optional; hard locks broadened not removed; `usesFactor` relaxed not removed).
- [x] New CQ probes CQ-SR9..SR16 added (research-to-conclusion, strategy business surface, execution-package closure, simulated trading chain, performance context, attribution-to-result, deployment governance, generalized factor subject) with staging fixtures in `tests/m2/fixtures/positive/strategy-research-positive.yaml` (strategy-positive-008..015), runner blocks wired in `run-all-cq-probes.cjs`, and expected bindings in `tests/m2/cq/strategy-research/expected-bindings.json` — per the ADR-032 precedent (fin-risk added CQ-R6–R13 in its v1.1.0).
- [x] Terminology cards added (v1.0.0: 8 → v1.1.0: 19) in `docs/ontology/terminology/fin-strategy-research-terms.yaml` per the ADR-032 precedent.
- [x] Regression gates run with **actual** results (2026-08-05):
  - `node scripts/domain/validate-m2-core.js --all --strict` → **PASS** (0 errors, 10 modules)
  - `node scripts/domain/run-domain-shacl.cjs` → **PASS**
  - `node scripts/domain/run-all-cq-probes.cjs` → **PASS** (199 pass / 0 fail / 0 pending; 105 CQs probed; CQ-SR9–SR16 wired)
  - `node scripts/domain/validate-pit.cjs tests/m2/cq/strategy-research/pit-requests.json` → **PASS** (0/0)
  - `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (strategy) → **PASS** (0 projection warnings; 405KB OWL / 510KB SHACL)
- [ ] SME joint review on [RFC-008](../planning/RFC-008-strategy-research-architecture.md) Q1–Q14 — **open, not blocking**, never marked PASS without execution.
- [ ] SME confirmation of external citations (GIPS Standards Handbook, Bailey et al. PBO, IOSCO, SEC Rule 15c3-5, US Federal Reserve model-risk guidance) as evidence pointers.
- [ ] Physical runtime-profile split deferred-design ADR authored (ADR-034 candidate) — gated on ADR-033 Acceptance.

## Status

**Proposed (v1.1.0).** The in-place additive revision (Option B) is implemented in `ontology/domain/finance/strategy-research/module.yaml`. Items requiring SME input remain open and are not blocking; the physical runtime-profile split is deferred per [RFC-008](../planning/RFC-008-strategy-research-architecture.md).

### Regression evidence (actual, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 199 pass / 0 fail / 0 pending (105 CQs probed; CQ-SR9–SR16 wired) |
| PIT validation | `node scripts/domain/validate-pit.cjs tests/m2/cq/strategy-research/pit-requests.json` | **PASS** — 0/0 (no findings) |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (strategy) | **PASS** — 0 projection warnings (405KB OWL / 510KB SHACL) |

Per memory, `test-all-domain` step 2 has a pre-existing Windows concurrent-IO race (documented in ADR-023 and memory) that intermittently fails unmodified modules; the individual gates above all PASS in isolation with exit 0.

## References

- [M2-REVIEW-ROUND-19](M2-REVIEW-ROUND-19.md)
- [RFC-008](../planning/RFC-008-strategy-research-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](../planning/M2-PLAN.md)
- [ADR-029](ADR-029-portfolio-positions-architecture.md) (Option B precedent)
- [ADR-030](ADR-030-post-trade-operations-architecture.md) (Option B precedent)
- [ADR-032](ADR-032-fin-risk-architecture.md) (Option B precedent)
- [ADR-024](ADR-024-market-structure-architecture.md) (additive backbone precedent)
- [ADR-026](ADR-026-orders-quotation-convention-broadening.md) (supertype-widening)
- [ADR-028](ADR-028-orders-layer-separation.md) (document-deprecation + deferred split)
- [strategy-research-semantic-gap.md](gap/strategy-research-semantic-gap.md)
