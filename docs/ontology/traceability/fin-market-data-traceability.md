# fin-market-data Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO / ADR-012 | PriceObservation + TemporalFact | three-axis + availableFrom | CQ-MD1 | market-data-v03-price-listed | pySHACL smoke PASS |
| FIBO | TradeObservation | valid interval ordering | CQ-MD2 | market-data-v03-trade | pySHACL smoke PASS |
| ADR-012 | revision chain | knowledge-time reproducibility | CQ-MD3 | factor-obs-revision-chain-positive | semantic replay verified |
| FIX / nautilus | QuoteObservation | bid or ask required | CQ-MD4 | market-data-v03-quote-paired | pySHACL smoke PASS |
| M2-PLAN | Bar | OHLCV interval semantics | CQ-MD5 | market-data-v03-trade-bar | pySHACL smoke PASS |
| ADR-012 | availableFrom fail-closed | future data leakage guard | CQ-MD1 | market-data-v03-neg-missing-availability | pySHACL smoke PASS |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ-MD6 cross-listing price kind probes.
