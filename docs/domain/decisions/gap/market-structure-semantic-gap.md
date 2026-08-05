# Market Structure Semantic Gap

**Module**: fin-market-structure  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Defines trading venues, segments, sessions, and calendar bindings as reference facts for "where" and "when market is open".
- Non-goal: embedding price observations or settlement rules in venue types.
- Enables read-only slice A queries before price or holding facts.

## Track B (reference/ alignment)

- ISO 10383 MIC and FIBO FBC market facility concepts inform TradingVenue and segment boundaries.
- Exchange vendor codes inform mapping narratives without importing vendor enums as canonical types.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| MS-G1 | weak-cq | P1 | CQ-MS1-MS3 draft | **Closed** - 3 active CQs; MIC pattern negatives |
| MS-G2 | broken-boundary | P1 | Segment without venue parent | **Closed** - segment-under-missing-venue negative |
| MS-G3 | shallow-definition | P2 | Session vs calendar binding overlap | **Closed** (v1.0.0) — partial v03 negatives |
| MS-G4 | orphan-type | P2 | JurisdictionCalendarBinding CQ | **Closed** (v1.0.0) — CQ-MS4 + [MS-G4 binding narrative](../../planning/mapping-narratives/MS-G4-jurisdiction-calendar-binding.md) |
| MS-G5 | mapping-gap | P1 | Vendor exchange code to MIC slice | **Closed** - slice-a venue refs + MIC validation |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | MIC venue keys + invalid MIC negatives |
| 2 | pass | Session intervals typed; calendar refs bounded |
| 3 | pass | Venue/segment/session definitions narratable |
| 4 | pass | Segment/session integrity negatives |
| 5 | pass | Session interval constraints in fixtures |
| 6 | pass | Three active CQs; probes staged |
| 7 | pass | ISO 10383 + FIBO locators cited |
| 8 | pass | slice-a venue mapping + MIC pattern probes |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)

## Round-14 rows (v1.1.0 additive backbone revision, 2026-08-04)

Supersedes the "all gaps closed at v1.0.0" line above for the *semantically complete stable-structure module* claim. Round-12 acceptance contract remains the historical baseline.

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| MS-A1 | narrow-taxonomy | P0 | MIC target range excludes ISO 10383 reporting facilities (OPRT forced to TradingVenue, SGMT to MarketSegment) | **Closed (v1.1.0)** — added MICIdentifiedMarketInfrastructure supertype + TradeReportingFacility; broadened MICRegistryEntryContract; added MICMarketCategory |
| MS-A2 | ontological-bias | P0 | MarketSegment over-typed as a facility; ISO 10383 "section" semantics lost | **Closed (v1.1.0)** — added MarketInfrastructureComponent supertype + componentOf relation; MarketSegment scope-documented as a section sharing a facility supertype for reference range |
| MS-A3 | conflation | P0 | Venue and operator conflated; no operatedBy link | **Closed (v1.1.0)** — added VenueOperation association + operatedBy + venueRegulatoryClassification + VenueCategory code list |
| MS-A4 | version-category-error | P0 | MIC constraint compares logical reference to exact-version reference directly | **Closed (v1.1.0)** — MICRegistryEntryContract rewritten to bridge via versionOf(operatingMICEntry.registryFacility) = facility.marketSegmentVenue or componentOf |
| MS-A5 | key-contradiction | P0 | authorityCalendarId claims "within authority" but key is (facility, authority, id) | **Closed (v1.1.0)** — authorityCalendarId scope redefined to "within (authority, facility)"; key unchanged |
| MS-A6 | non-materializable | P0 | sessionRecurrence is a non-empty string; occurrence constraint validates only join + start<end | **Closed (v1.1.0)** — added recurrenceRule (RFC 5545 bounded), authoritySessionId, ScheduledTradingPhase, endDayOffset; TradingSessionOccurrenceContract v2 requires materialization consistency |
| MS-A7 | scheduled-vs-tradable | P0 | Occurrence typed as tradable but holiday/closure removes it; no n-ary override | **Closed (v1.1.0)** — Occurrence clarified as scheduled; added effectiveSessionStartUtc/EndUtc + TradingScheduleOverrideNotice n-ary + CalendarExceptionSupersession + ScheduleOverrideNoticeIntegrity |
| MS-A8 | out-of-scope | P0 | OTCTradingContext mixes provider contract, currencies, counterparties, execution | **Deferred** — OTCTradingContext deprecated (definition text); NonVenueMarketContext added as stable successor; cross-module migration of 3 downstream importers deferred to follow-up ADR (SME-gated) |
| MS-A9 | misleading-names | P1 | earlySession = early close, lateSession = late open | **Closed (v1.1.0)** — added earlyClose/lateOpen/earlyOpen/lateClose/extraSession/segmentedInterrupt/segmentedResume; earlySession/lateSession retained as deprecated aliases (definition text) |
| MS-A10 | double-source-of-truth | P1 | calendarJurisdiction and JurisdictionCalendarBinding unconstrained | **Closed (v1.1.0)** — added CalendarJurisdictionConsistency constraint |
| MS-A11 | missing-lifecycle | P1 | MICRegistryEntry lacks operational status, effective/expiry, market category | **Closed (v1.1.0)** — added micOperationalStatus/micEffectiveFrom/micEffectiveTo/marketCategory + MICOperationalStatus + micReplacedBy; scoped as minimal identity slice with optional lifecycle |
| MS-A12 | missing-tzdb-version | P1 | ianaTimeZone regex only; no tzdb release; no DST policy | **Closed (v1.1.0)** — added tzdbRelease + DstOverlapPolicy code list |
| MS-A13 | exception-date-unconstrained | P1 | exceptionBusinessDate ≠ occurrence.sessionBusinessDate not constrained | **Closed (v1.1.0)** — added CalendarExceptionDateConsistency constraint |

## SME-gated open items (not blocking v1.1.0)

- MS-A8 OTC cross-module migration (RFC-003 Q6, follow-up ADR).
- Q1 MIC taxonomy breadth (APA/ARM subtypes), Q2 MarketSegment re-parenting, Q3 venue operator shape, Q4 recurrence grammar freeze, Q5 schedule-override vs live-status boundary, Q7 IANA tzdb policy (RFC-003).

