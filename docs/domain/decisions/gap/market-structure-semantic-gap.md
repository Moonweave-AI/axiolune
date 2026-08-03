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
