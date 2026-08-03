# Market Data Semantic Gap

**Module**: fin-market-data  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Models price, quote, trade, bar, and FX observations with stream role, revision, and three-axis temporal facts.
- Non-goal: a single nullable "MarketDataRecord" mega-type; implicit now() for as-of queries.
- Feeds strategy-research signals and risk mark inputs with PIT-safe observation semantics.

## Track B (reference/ alignment)

- FIBO MDR market data patterns and FIX market-data message semantics inform observation kinds and sides.
- NautilusTrader quote/trade/bar types and Lean `TradeBar`/`QuoteBar` inform event ordering, not type names.
- Vendor schema notes in bibliography support stream-role and revision-chain stories.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| MD-G1 | weak-cq | P1 | CQ-MD1 draft despite v03 fixtures | **Closed** - CQ-MD1-MD7 active; profile fixture staged |
| MD-G2 | broken-boundary | P1 | Quote paired vs bar partial-quote | **Closed** - quote-bar + partial-quote negatives |
| MD-G3 | shallow-definition | P2 | StreamRole vs source identity thin | **Closed** (v1.0.0) — stream-role-missing negative exists |
| MD-G4 | mapping-gap | P1 | OTC and FX mapping narratives partial | **Closed** - listed/OTC/FX v03 positive fixtures |
| MD-G5 | orphan-type | P2 | FxRateObservation consumer CQ | **Closed** (v1.0.0) — [MD-G5 FX to risk mark](../../planning/mapping-narratives/MD-G5-fx-rate-to-risk-mark.md) |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Observation identity via instrument+kind+interval |
| 2 | pass | MoneyType and QuantityType enforced in v03 shapes |
| 3 | pass | Observation kinds defined; stream role negatives |
| 4 | pass | v03 SHACL negatives linked to active CQs |
| 5 | pass | TemporalFact + PIT CQ-MD7 |
| 6 | pass | Seven active CQs; probes 0 pending |
| 7 | pass | FIBO MDR + FIX references present |
| 8 | pass | Listed/OTC/FX mapping fixtures in v03 runs |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)
