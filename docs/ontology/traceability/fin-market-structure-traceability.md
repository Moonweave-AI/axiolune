# fin-market-structure Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO / ISO 10383 | TradingVenue + MIC | venue identity binding | CQ-MS1 | market-structure-positive | `test-all-domain` PASS |
| FIBO | MarketSegment | segment MIC 4+4 pattern | CQ-MS2 | market-structure-positive | semantic replay verified |
| FIBO | TradingCalendar | venue session schedule | CQ-MS3 | slice-a/cq-v03/market-structure-plan | semantic replay verified |
| M2-PLAN | TradingSession | session type enumeration | CQ-MS3 | market-structure-negative | `validate-pit` PASS |
| ISO 10383 | MIC identifier | active venue lookup | CQ-MS1 | foundation-market-rules-contract | `validate-pit` PASS |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: venue-segment cross-venue rule applicability probes.
