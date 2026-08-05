# Market Data Semantic Gap

**Module**: fin-market-data  
**Version**: 2.0.0  
**Date**: 2026-08-04  
**Round-12**: prior gaps closed at v1.0.0; v2.0.0 adds new gaps below

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
| MD-G2 | broken-boundary | P1 | Quote paired vs bar partial-quote | **Closed** - quote-bar + complete paired L1 snapshot negatives |
| MD-G3 | shallow-definition | P2 | StreamRole vs source identity thin | **Closed** (v1.0.0) — stream-role-missing negative exists |
| MD-G4 | mapping-gap | P1 | OTC and FX mapping narratives partial | **Closed** - listed/OTC/FX v03 positive fixtures |
| MD-G5 | orphan-type | P2 | FxRateObservation consumer CQ | **Closed** (v1.0.0) — [MD-G5 FX to risk mark](../../planning/mapping-narratives/MD-G5-fx-rate-to-risk-mark.md) |
| MD-G6 | boundary-clarity | P2 | Layer 4 boundary not explicit in sidecar docs | **Open** (v2.0.0) — physical field mapping belongs to Layer 4 SemanticMappingDefinition; thin core must not inline physical column names |
| MD-G7 | missing-abstraction | P2 | QuotationConvention abstraction not referenced | **Open** (v2.0.0) — quote/price conventions belong to fin-instruments QuotationConvention layer; market-data references it, not redefines it |
| MD-G8 | scope-ambiguity | P2 | Quote scope not stated | **Open** (v2.0.0) — QuoteObservation is a complete paired top-of-book L1 snapshot, not a partial or multi-level quote |
| MD-G9 | identity-drift | P1 | Observation identity via instrument+kind+interval is wrong | **Open** (v2.0.0) — actual identity is stream + provider observation ID; instrument and kind are scoping, not identity |
| MD-G10 | threshold-gap | P2 | Bar threshold vs interval branch untested | **Open** (v2.0.0) — BarSpecification requires exactly one of barInterval (time) or barThreshold (non-time); negative fixtures needed |
| MD-G11 | semantic-clarity | P2 | FX semantics (base/quote, dimensionless ratio) not in gap doc | **Open** (v2.0.0) — FXRateObservation carries fxRate as strictly positive dimensionless quantity with base/quote currency roles |
| MD-G12 | temporal-semantics | P2 | PIT vs event time distinction not explicit | **Open** (v2.0.0) — observedAt is the event time; PIT as-of parameters filter by valid/knowledge/availability intervals, not by observedAt alone |
| MD-G13 | mapping-gap | P2 | streamPurpose mapping to record kinds not documented | **Open** (v2.0.0) — streamPurpose is a closed vocabulary; mapping from stream purpose to admitted observation kinds needs traceability |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Observation identity via stream + provider observation ID |
| 2 | pass | MoneyType and QuantityType enforced in v03 shapes |
| 3 | pass | Observation kinds defined; stream role negatives |
| 4 | pass | v03 SHACL negatives linked to active CQs |
| 5 | pass | TemporalFact + PIT CQ-MD7 |
| 6 | pass | Seven active CQs; probes 0 pending |
| 7 | pass | FIBO MDR + FIX references present |
| 8 | pass | Listed/OTC/FX mapping fixtures in v03 runs |

P0/P1/P2 status: prior gaps closed (Round-12 v1.0.0 2026-08-03); v2.0.0 adds MD-G6 through MD-G13 as open gaps for next review.
