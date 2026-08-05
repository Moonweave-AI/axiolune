# fin-market-structure Traceability Matrix

**Status**: review (v1.1.0)
**Date**: 2026-08-04
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO / ISO 10383 | TradingVenue + MIC | venue identity binding | CQ-MS1 | market-structure-positive | `test-all-domain` PASS |
| FIBO | MarketSegment | segment MIC 4+4 pattern; v1.1.0 componentOf part-of | CQ-MS2 | market-structure-positive | semantic replay verified |
| FIBO | TradingCalendar | venue session schedule; v1.1.0 tzdbRelease + DstOverlapPolicy | CQ-MS3 | slice-a/cq-v03/market-structure-plan | semantic replay verified |
| M2-PLAN | TradingSession | session type enumeration; v1.1.0 ScheduledTradingPhase | CQ-MS3 | market-structure-negative | `validate-pit` PASS |
| ISO 10383 | MIC identifier | active venue lookup | CQ-MS1 | foundation-market-rules-contract | `validate-pit` PASS |
| ISO 10383 | MICIdentifiedMarketInfrastructure / TradeReportingFacility | broadened MIC taxonomy | — | — | v1.1.0 ADR-024 D1 |
| W3C ORG | VenueOperation | operator separation | — | — | v1.1.0 ADR-024 D3 |
| RFC 5545 | recurrenceRule | deterministic materialization | — | — | v1.1.0 ADR-024 D6 |
| ADR-024 | TradingScheduleOverrideNotice | n-ary schedule override | — | — | v1.1.0 ADR-024 D7 |
| ADR-024 | NonVenueMarketContext | stable non-venue context (OTC deprecation) | — | — | v1.1.0 ADR-024 D8 |
| ADR-024 | earlyClose/lateOpen + extended kinds | exception-kind honesty | — | — | v1.1.0 ADR-024 D9 |
| ADR-024 | CalendarJurisdictionConsistency | jurisdiction single source of truth | — | — | v1.1.0 ADR-024 D10 |
| ISO 10383 | MICOperationalStatus / MICMarketCategory / micReplacedBy | MIC lifecycle | — | — | v1.1.0 ADR-024 D11 |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: venue-segment cross-venue rule applicability probes, n-ary override synthesis probes (SME-gated per RFC-003 Q5).

