# fin-market-data Traceability Matrix

**Status**: review (v2.0.0)  
**Date**: 2026-08-04  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO / ADR-012 | PriceObservation + TemporalFact | three-axis + availableFrom | CQ-MD1 | market-data-v03-price-listed | pySHACL smoke PASS |
| FIBO | TradeObservation | valid interval ordering | CQ-MD2 | market-data-v03-trade | pySHACL smoke PASS |
| ADR-012 | revision chain | knowledge-time reproducibility | CQ-MD3 | factor-obs-revision-chain-positive | semantic replay verified |
| FIX / nautilus | QuoteObservation | complete paired top-of-book L1 snapshot (bid + ask required) | CQ-MD4 | market-data-v03-quote-paired | pySHACL smoke PASS |
| M2-PLAN | TradeBar / QuoteBar + BarSpecification | OHLCV interval semantics | CQ-MD5 | market-data-v03-trade-bar | pySHACL smoke PASS |
| ADR-012 | MarketDataStream + providerObservationId | stream-level provenance and audit trail | CQ-MD6 | market-data-v03-stream-provenance | pySHACL smoke PASS |
| ADR-012 | availableFrom fail-closed | future data leakage guard | CQ-MD1 | market-data-v03-neg-missing-availability | pySHACL smoke PASS |
| ADR-012 | MarketDataStream | identity contract (provider, source contract, purpose, revision mode) | CQ-MD6 | market-data-v03-stream-identity | pySHACL smoke PASS |
| M2-PLAN | BarSpecification | aggregation branch (time interval or non-time threshold) + price basis | CQ-MD5 | market-data-v03-bar-specification | pySHACL smoke PASS |
| FIBO / ADR-012 | FXRateObservation | base/quote currency + fxRate dimensionless ratio + three-axis | CQ-MD1 | market-data-v03-fx-rate | pySHACL smoke PASS |
| ADR-012 | MarketDataQualityFinding | closed predicate set (crossedQuote, duplicateConflict, orderingCollision) | CQ-MD4 | market-data-v03-quality-finding | pySHACL smoke PASS |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ-MD6 stream-level provenance and cross-stream observation-identity probes.
