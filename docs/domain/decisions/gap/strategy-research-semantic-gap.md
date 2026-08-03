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
