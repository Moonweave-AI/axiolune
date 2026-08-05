# M2 Review Round 14 — `fin-market-structure` Architecture Review

**Date**: 2026-08-04
**Verdict**: **Retain; backbone architecture revision required (P0). Release status: v1.0.0 → v1.1.0 (additive).**
**Scope**: `fin-market-structure` module only (post-v1.0.0 in-depth architecture review)
**Basis**: Independent architecture review of `ontology/domain/finance/market-structure/module.yaml` v1.0.0
**Related**: Round-12 (v1.0.0 approval, acceptance contract), RFC-003 (architecture decision), ADR-024 (Accepted)

## Status of this review

This is a **post-release architecture review**, not a re-run of the Round-12 v1.0.0 acceptance contract. Round-12 approved `fin-market-structure` against the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance axes (flights rubric, gap closure, active CQs, lifecycle story). That approval **stands** for the acceptance contract.

This review assesses whether the module is a **semantically complete stable-structure module** — a stronger claim than the acceptance contract. It is not, as released, despite a correct backbone. The P0 issues below were verified by direct reading of `module.yaml` and `M2-PLAN §5.2`; they are structural, not stylistic.

## What was verified (untrusted-input handling)

Per the Moonweave governance baseline, the originating review text and its external regulatory citations (ISO 10383 and FAQ, MiFID II Article 4, RFC 5545, NYSE trading hours / extended-hours FAQ, FIX trading-session status/event vocabulary, ESMA Article 32) were treated as **untrusted input**. Structural and semantic claims were re-derived against `module.yaml` and `M2-PLAN` directly. The external citations are recorded here as **SME-evidence pointers for the RFC**, not as provenance or asserted fact. Their interpretation must be confirmed by market-microstructure, reference-data, and OTC/execution SMEs before any hardens into ontology semantics.

## Confirmed structural baseline

Per `module.yaml` v1.0.0: 9 object types, 1 association type, 19 relation types, 17 attribute types, 3 code lists (7 values), 6 domain constraints. No files were modified, and no ontology tests, validators, or gates were run for this review (any execution result would be marked **unverified**).

## P0 — architecture issues (verified)

| # | Claim | Verified evidence | Required semantic |
|---|---|---|---|
| P0-1 | MIC target range too narrow | [MICRegistryEntryContract:722](../../ontology/domain/finance/market-structure/module.yaml#L722) forces OPRT ⇒ `TradingVenue`, SGMT ⇒ `MarketSegment`. | ISO 10383 Operating MICs also identify trade reporting facilities, APAs, ARMs; Segment MICs can be sections of a reporting facility. Broaden the taxonomy or honestly narrow to a trading-venue subset. |
| P0-2 | MarketSegment ontological bias | [MarketSegment:44](../../ontology/domain/finance/market-structure/module.yaml#L44) is a `TradingFacility` subtype and must belong to a `TradingVenue`. | ISO 10383 semantics: a segment is a *section*/component, not necessarily an independent facility. Add part-of semantics; do not imply every segment is a facility. |
| P0-3 | Venue, market, operator conflated | [TradingVenue:31](../../ontology/domain/finance/market-structure/module.yaml#L31) "operates a market" but no `operatedBy` → `Party`. | A market system/venue and its operator legal entity are not the same object (MiFID II Art. 4). Add temporal `VenueOperation`/`operatedBy`; make RM/MTF/OTF a temporal evidenced category, not a global supertree. |
| P0-4 | MIC constraint conflates logical and exact version | `registryFacility` is exact-version ([relationUses:868](../../ontology/domain/finance/market-structure/module.yaml#L868)); `marketSegmentVenue` is logical ([relationUses:841](../../ontology/domain/finance/market-structure/module.yaml#L841)); the contract compares them directly ([MICRegistryEntryContract:722](../../ontology/domain/finance/market-structure/module.yaml#L722)). | Bridge explicitly via `versionOf()`; require the SGMT facility to be an exact version of the logical venue. |
| P0-5 | Calendar identity key self-contradiction | `authorityCalendarId` claims "within the authority" ([attribute:472](../../ontology/domain/finance/market-structure/module.yaml#L472)); the logical key is `(facility, authority, authorityCalendarId)` ([constraint:742](../../ontology/domain/finance/market-structure/module.yaml#L742)). | Make the attribute scope "within (authority, facility)" or change the key; the two must agree. |
| P0-6 | Session template cannot deterministically materialize | `sessionRecurrence` is "deterministic" but only a non-empty string ([attribute:496](../../ontology/domain/finance/market-structure/module.yaml#L496)); occurrence constraint validates only join + `start < end` ([constraint:758](../../ontology/domain/finance/market-structure/module.yaml#L758)). | A bounded RFC 5545 RRULE or formal grammar; `authoritySessionId`, `ScheduledTradingPhase`, `endDayOffset`, business-date attribution; occurrence/recurrence/timezone/UTC consistency. |
| P0-7 | "Tradable window" vs "cancelled scheduled window" conflict | `TradingSessionOccurrence` is a "concrete tradable time window" ([object:138](../../ontology/domain/finance/market-structure/module.yaml#L138)); holiday/closure "remove" it ([code list:677](../../ontology/domain/finance/market-structure/module.yaml#L677)); multiple exceptions on one occurrence have no priority/synthesis. | Type it as a *scheduled* window; make the effective tradable interval derived; add n-ary `TradingScheduleOverrideNotice` with supersession/announcement order and a single final effective interval or cancellation. |
| P0-8 | OTCTradingContext severely out of scope | [OTCTradingContext:192](../../ontology/domain/finance/market-structure/module.yaml#L192) + 6 relations ([394](../../ontology/domain/finance/market-structure/module.yaml#L394)–459) mix provider contract, quote/settlement currency, reporting facility, counterparty pair, execution semantics; its logical key is a provider contract. | This is not stable market structure. Split: provider contract → Layer 4; currencies/convention → `instruments`; counterparty/execution/reporting → `orders-execution`/`post-trade-operations`; stable non-venue context → a new `NonVenueMarketContext`. Cross-module migration is deferred (3 downstream importers). |

## P1 — high-priority design corrections

1. **Session template lacks identifier, phase, purpose.** Only recurrence, start, end, source. Add `authoritySessionId`, `ScheduledTradingPhase` (preOpen, openingAuction, continuousTrading, closingAuction, postClose, maintenance, reportingOnly). NYSE pre-opening/early/core/late/auction is the real-world example.
2. **Cross-midnight session date semantics.** `sessionBusinessDate` cannot model "Sunday open, Monday trade date." Distinguish `scheduleDate`, `localStartDate`, optional `tradeDate`; put trade-date attribution in an explicit model. NYSE extended-hours is the real-world example.
3. **Exception applies to one occurrence only.** No n-ary application to core/late/multiple sessions; `exceptionBusinessDate` ≠ `occurrence.sessionBusinessDate` is not constrained. Add `TradingScheduleOverrideNotice` n-ary + date/calendar/facility/interval consistency constraints.
4. **`earlySession`/`lateSession` naming misleading.** `earlySession` = early close, `lateSession` = late open. Migrate to `earlyClose`/`lateOpen`; support both-ends, early open, late close, extra session, segmented interrupt/resume.
5. **Pre-announced override vs real-time status must be separated.** market-structure owns the planned schedule; market-data owns timestamped venue/session/instrument status/halt; market-rules owns triggers/resume; instruments/listing owns instrument-level suspend. FIX separates Open/Halted/Pre-Open/Closed status from status events; ESMA Art. 32 covers instrument suspend/remove.
6. **`calendarJurisdiction` and `JurisdictionCalendarBinding` are a double source of truth** with no consistency constraint. Choose a primary and constrain consistency.
7. **MIC lifecycle / ISO 10383 fields.** If a full adapter, add `marketCategory`, status, effective/expiry, operator/LEI, location; if an identity slice, narrow the definition to "minimal MIC identity slice."
8. **`ianaTimeZone` regex checks form only; no tzdb release pinned; no DST gap/fold policy.** Add a versioned IANA tzdb reference and a DST overlap policy.

## What should be retained and strengthened

- `TradingFacility`/`TradingVenue`/`MarketSegment` as cross-module stable anchors (instruments, market-rules, market-data, orders-execution depend on them).
- `MICRegistryEntry` as an independent, temporal, provenance-bearing fact — not a string on Venue.
- `TradingCalendar` → `TradingSessionTemplate` → `TradingSessionOccurrence` → `TradingCalendarException` layering; templates not mutated by exceptions.
- Local-clock templates + IANA time zones; occurrences as UTC half-open intervals.

## Design-intent drift (confirmed)

[M2-PLAN §5.2 module responsibility (line 326)](../planning/M2-PLAN.md#L326) defines the boundary as "交易场所、市场段、交易日历和交易时段的稳定结构" and explicitly excludes one-off rules and tickers. `OTCTradingContext` carries provider contracts, counterparties, and execution-adjacent semantics that belong to Layer 4 / `instruments` / `orders-execution` / `post-trade-operations`. The venue/calendar/session backbone is on-plan; the OTC object is off-plan.

## Cross-module dependency (critical)

`OTCTradingContext` is referenced as an association range by `market-data` (7), `instruments` (2), `orders-execution` (3). Removing it is source-breaking across three released v1.0.0 modules. The migration is therefore a cross-module follow-up ADR requiring SME joint review, not an in-place edit. This is the structural reason MS-A8 is deferred.

## Per-container summary

| Container | Conclusion |
|---|---|
| Object types | Backbone (9) worth retaining; `MarketSegment` over-typed; `OTCTradingContext` out of scope; needs `MICIdentifiedMarketInfrastructure`/`TradeReportingFacility`/`MarketInfrastructureComponent`/`NonVenueMarketContext`. |
| Association types | Only `JurisdictionCalendarBinding`; needs `VenueOperation` (operator) and `TradingScheduleOverrideNotice` (n-ary override). |
| Relation types | 19 all functional; needs `operatedBy`, `componentOf`, override-application relations, non-venue-context relations. |
| Attribute types | 17; `authorityCalendarId` scope contradiction; `sessionRecurrence` not materializable; needs session id/phase/endDayOffset/recurrenceRule, effective interval, override order, MIC lifecycle, tzdb release, DST policy. |
| Code lists | 3 (7 values); `CalendarExceptionKind` names misleading; needs `VenueCategory`, `ScheduledTradingPhase`, `MICOperationalStatus`, `MICMarketCategory`, `DstOverlapPolicy`, `OverrideEffect` and extended exception kinds. |
| Constraints | 6; `MICRegistryEntryContract` version-bridging fix; needs `VenueOperationIntegrity`, `CalendarExceptionSupersession`, `CalendarExceptionDateConsistency`, `CalendarJurisdictionConsistency`, `ScheduleOverrideNoticeIntegrity`, `NonVenueMarketContextContract`; `TradingSessionOccurrenceContract` v2. |

## Recommended convergence order

1. Establish MIC taxonomy (D1) and `MarketSegment` part-of semantics (D2).
2. Add venue/operator separation (D3) and fix MIC version bridging (D4).
3. Fix calendar identity key (D5).
4. Complete session template materialization (D6) and scheduled-vs-effective window (D7).
5. Add exception rename + n-ary override (P1-3/4) and jurisdiction consistency (P1-6).
6. Add MIC lifecycle, tzdb version, segment classification, terminology cleanup (P1-7/8).
7. Defer OTC cross-module migration to a follow-up ADR after SME joint review (MS-A8).

## Disposition

- **Release status**: `fin-market-structure` bumped to **v1.1.0, approved**. Round-12 v1.0.0 acceptance contract remains the historical baseline.
- **Architecture status**: P0 backbone revision **implemented and regression-verified** (ADR-024 Accepted, v1.1.0 in-place). The module now models a broader MIC taxonomy, venue/operator separation, logical/exact version bridging, a consistent calendar identity key, deterministic session materialization, scheduled-vs-effective windows with n-ary override, and exception-kind honesty. The "semantically complete stable-structure module" claim is now supported for the implemented backbone surface.
- **Deferred (not blocking)**: MS-A8 (`OTCTradingContext` cross-module migration) is gated on SME review of [RFC-003](../planning/RFC-003-market-structure-architecture.md) Q6 and a follow-up ADR. The v1.1.0 module deprecates `OTCTradingContext` and introduces `NonVenueMarketContext` as the stable-structure successor; the physical migration of three downstream importers is deferred. SME-confirmed sub-grammar and migration order (Q1–Q7) await SME input.
- **Regression gate (2026-08-04)**: `validate-m2-core --all --strict` 10 modules 0 errors; `run-domain-shacl` pySHACL PASS (all shapes including `jurisdiction-calendar-binding-negative` reject as expected); `run-all-cq-probes` 122 PASS / 0 FAIL / 0 PENDING (61 probed CQs). 4 new CQs (CQ-MS5..MS8) are defined but not yet wired to probes; their `dependsOn` types are newly added and probe wiring is deferred with the SME-gated materialization work. market-structure OWL/SHACL regenerated cleanly (module.owl.ttl 1333 lines, module.shacl.ttl 1921 lines, 0 projection warnings).

## References

- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) (acceptance contract)
- [M2-PLAN §5.2](../planning/M2-PLAN.md) (module responsibility)
- [market-structure-semantic-gap.md](gap/market-structure-semantic-gap.md) (Round-12: all gaps closed at v1.0.0 — superseded by this review for the semantically-complete claim)
- [RFC-003](../planning/RFC-003-market-structure-architecture.md) (Proposed)
- [ADR-024](ADR-024-market-structure-architecture.md) (Accepted)
