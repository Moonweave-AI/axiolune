# ADR-024: `fin-market-structure` Architecture Revision

**Status**: Accepted (v1.1.0 in-place backbone revision implemented and regression-verified; MS-A8 OTC cross-module migration deferred to SME / follow-up ADR)
**Date**: 2026-08-04 (Accepted); originally Proposed 2026-08-04
**Context**: Architecture review of `fin-market-structure` v1.0.0 ([M2-REVIEW-ROUND-14](M2-REVIEW-ROUND-14.md))
**Related**: ADR-014, ADR-017, ADR-020 (foundation, BusinessCalendar interface), ADR-021 (instruments, QuotationConvention), ADR-022 (market-data, IRI-retention precedent), ADR-023 (market-rules v1.1.0 precedent), M2-PLAN §5.2, RFC-001, RFC-003

## Context

An independent architecture review of `fin-market-structure` v1.0.0 ([M2-REVIEW-ROUND-14](M2-REVIEW-ROUND-14.md)) concluded: **retain the module; architecture revision required (P0)**. The review verified eight P0 issues and eight P1 corrections against `module.yaml` and the M2-PLAN; it modified no file and ran no validator (any execution result would be marked **unverified**).

The module's backbone is sound and is an M2 foundation module — `TradingFacility`/`TradingVenue`/`MarketSegment` as cross-module stable anchors, `MICRegistryEntry` as an independent temporal provenance-bearing fact (not a string on Venue), the `TradingCalendar` → `TradingSessionTemplate` → `TradingSessionOccurrence` → `TradingCalendarException` layering where templates are not mutated by exceptions, and local-clock templates with IANA time zones materialized as UTC half-open intervals. The problems are structural: the MIC target range excludes ISO 10383 reporting facilities; `MarketSegment` is over-typed as a facility; venue and operator are conflated; the MIC constraint compares a logical reference to an exact-version reference; the calendar identity key contradicts its attribute definition; session templates cannot deterministically materialize; "tradable window" conflicts with "cancelled scheduled window"; and `OTCTradingContext` mixes provider contract, currencies, counterparties, and execution semantics that are not stable market structure.

Round-12 v1.0.0 approval stands for the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This ADR addresses the stronger claim of a *semantically complete* stable-structure module, which the released module does not yet satisfy.

## Decision

**Option C — revise the backbone in place now (v1.1.0, additive, IRI-retentive); mark `OTCTradingContext` deprecated with a `NonVenueMarketContext` successor; defer the cross-module OTC migration to a follow-up ADR after P0 backbone closure and SME joint review.** (See [RFC-003](../planning/RFC-003-market-structure-architecture.md) for the full option comparison.) The seven backbone P0 revisions are prerequisite regardless of OTC migration; doing them once in place is cheaper than distributing the rebuild across a migrated OTC boundary. The OTC migration is genuinely cross-module (three downstream v1.0.0 modules reference `OTCTradingContext` as an association range) and is correctly a measured follow-up ADR, not an in-place edit.

Until this ADR is **Accepted** and SME evidence is recorded for the deferred items, no cross-module `OTCTradingContext` removal is authorized.

### D1. MIC target taxonomy (P0-1, MS-A1)

**Problem**: `MICRegistryEntryContract` forces OPRT ⇒ `TradingVenue` and SGMT ⇒ `MarketSegment`. ISO 10383 Operating MICs also identify trade reporting facilities, APAs, and ARMs; Segment MICs can be sections of a reporting facility.

**Decision**: Introduce `MICIdentifiedMarketInfrastructure` as a supertype above `TradingVenue`, and `TradeReportingFacility` as a sibling object type (with a hook for APA/ARM via the supertype). Broaden `MICRegistryEntryContract` so OPRT may identify a `TradeReportingFacility` as well as a `TradingVenue`, and SGMT may be a section of either. The existing `TradingVenue` and `MarketSegment` IRIs and supertypes are **retained**; the new supertype and sibling are additive. A `MICMarketCategory` code list records the ISO 10383 market category. SME confirmation (RFC-003 Q1) required before the APA/ARM subtypes are frozen.

### D2. MarketSegment part-of semantics (P0-2, MS-A2)

**Problem**: `MarketSegment` is a `TradingFacility` subtype and must belong to a `TradingVenue`. ISO 10383 semantics make a segment a *section* — a component, not necessarily an independent facility.

**Decision**: Retain `MarketSegment`'s `TradingFacility` supertype (IRI stability — instruments, market-rules, market-data depend on it) but add a neutral `MarketInfrastructureComponent` abstract supertype naming the "section/component" semantics, and a `componentOf` functional part-of relation (logical reference) from a component to its operating entity. Scope-document `MarketSegment` as "a section of an operating entity, modeled as a facility subtype for shared reference range only; the `componentOf` relation carries the part-of semantics." SME confirmation (RFC-003 Q2) required before any re-parenting.

### D3. Venue operator separation (P0-3, MS-A3)

**Problem**: `TradingVenue` is defined as "operates a market" but has no `operatedBy` link; the venue and its operator legal entity are conflated.

**Decision**: Introduce `VenueOperation` (association type, temporal, provenanced — one logical `Party` operates one logical venue over a validity interval) and `operatedBy` (functional relation → `foundation/Party`, logical reference). `TradingVenue` is scoped in its definition as "the market system/venue" only; the operator is a separate temporal fact. Regulatory categorization (RM/MTF/OTF) becomes a temporal, evidenced `VenueRegulatoryClassification` fact (a `VenueOperation` attribute pointing to a `VenueCategory` code list), not a hardcoded global supertree. SME confirmation (RFC-003 Q3) required.

### D4. MIC logical/exact version bridging (P0-4, MS-A4)

**Problem**: `registryFacility` is an exact-version reference while `marketSegmentVenue` is a logical reference; the `MICRegistryEntryContract` compares them directly — a category error under strict temporal versioning.

**Decision**: Rewrite the `MICRegistryEntryContract` expression to bridge explicitly: compare `registryFacility.marketSegmentVenue` (logical) with `versionOf(operatingMICEntry.registryFacility)` (logical projection of the exact version), and require the SGMT entry's `registryFacility` to be an exact version whose logical identity is the operating MIC's logical venue. The OPRT facility must be an exact version of the logical venue identified by the segment's `marketSegmentVenue`. No IRI or cardinality change; constraint expression text updated against retained IRIs.

### D5. Calendar identity key consistency (P0-5, MS-A5)

**Problem**: `authorityCalendarId` claims uniqueness "within the authority" but the logical key is `(facility, authority, authorityCalendarId)` — a contradiction.

**Decision**: Redefine `authorityCalendarId`'s scope text to "unique within (authority, facility)" so the attribute definition matches the three-component logical key in `TradingCalendarIdentityContract`. No IRI, cardinality, or pattern change; definition/scope fix only. The `TradingCalendarIdentityContract` expression is retained.

### D6. Session template deterministic materialization (P0-6, MS-A6)

**Problem**: `sessionRecurrence` is called deterministic but is only a non-empty string; the occurrence constraint validates only the join and `start < end`. Materialization is not verifiable.

**Decision**: Add `authoritySessionId` (authority-scoped session identifier), a `ScheduledTradingPhase` code list (preOpen, openingAuction, continuousTrading, closingAuction, postClose, maintenance, reportingOnly), `endDayOffset` (integer, cross-midnight support), and a formal `recurrenceRule` (RFC 5545 RRULE-bounded subset, string with a tightened pattern) alongside the retained `sessionRecurrence`. Extend `TradingSessionOccurrenceContract` to require occurrence-recurrence/timezone/UTC consistency. The existing `sessionRecurrence` is **retained** (deprecated alias for `recurrenceRule`). SME confirmation (RFC-003 Q4) required before the recurrence grammar is frozen.

### D7. Scheduled vs effective tradable window (P0-7, MS-A7)

**Problem**: `TradingSessionOccurrence` is typed as a concrete tradable window, but holiday/closure "remove" it; multiple exceptions on one occurrence have no priority or synthesis rule.

**Decision**: Clarify `TradingSessionOccurrence` (IRI retained) as a *scheduled* window. Add `effectiveSessionStartUtc`/`effectiveSessionEndUtc` (optional instants) as the derived *effective tradable* interval, and a `TradingScheduleOverrideNotice` n-ary association so one announcement can adjust multiple occurrences with a `supersessionOrder` and a single final effective interval or cancellation result. Add a `CalendarExceptionSupersession` constraint requiring the final effective interval to be consistent with the applied notices. The existing `replacementSessionStartUtc`/`replacementSessionEndUtc` and `exceptionOccurrence` are **retained** (now read as single-occurrence shorthand for the n-ary notice). SME confirmation (RFC-003 Q5) required.

### D8. OTC out-of-scope — deprecate, defer migration (P0-8, MS-A8)

**Problem**: `OTCTradingContext` mixes provider/source contract, quote/settlement currency, reporting facility, concrete counterparty pair, and execution semantics. Its logical key is a provider contract — a data-extraction namespace, not an economic-entity identity.

**Decision**: `OTCTradingContext` and all its relations/attributes are **retained** (IRI stability — `market-data`, `instruments`, `orders-execution` reference it as an association range) but marked `deprecated: true`, `deprecatedSince: 1.1.0`, `replacedBy: NonVenueMarketContext`. Introduce `NonVenueMarketContext` as a new object type carrying **only** stable non-venue structure: a non-venue context identity, a market-convention orientation, and a provider attribution — **no** counterparty pair, **no** concrete currencies, **no** source contract/digest. The provider contract / source mapping moves to Layer 4 (SemanticMappingDefinition, per ADR-022 D1); the quote/settlement currency and quotation convention move to `instruments` (QuotationConvention, per ADR-021); the counterparty pair, concrete execution, and reporting obligation move to `orders-execution` / `post-trade-operations`. The actual migration of the three downstream importers' association ranges is a **cross-module follow-up ADR** requiring SME joint review (RFC-003 Q6) — it is **not** done in this revision. This matches the ADR-023 / MR-A12 precedent (profile split deferred) and the ADR-022 precedent (Layer 4 physical fields deprecated, not removed, pending Layer 4 adoption).

### D9. Exception-kind rename and n-ary override (P1)

**Problem**: `earlySession` actually means early close, `lateSession` means late open — misleading names. An exception can attach to only one occurrence.

**Decision**: Add `earlyClose` and `lateOpen` as new `CalendarExceptionKind` values (the primary names); **retain** `earlySession`/`lateSession` as deprecated aliases. Add `earlyOpen`, `lateClose`, `extraSession`, and `segmentedInterrupt`/`segmentedResume` values to cover both-ends adjustment, early open, late close, extra session, and segmented interrupt/resume. Introduce the `TradingScheduleOverrideNotice` n-ary association (D7) so one announcement affects multiple occurrences. Add a `CalendarExceptionDateConsistency` constraint requiring `exceptionBusinessDate` to match the affected occurrence's `sessionBusinessDate`.

### D10. Jurisdiction single source of truth (P1)

**Problem**: `calendarJurisdiction` (direct relation) and `JurisdictionCalendarBinding` (association) are a double source of truth with no consistency constraint.

**Decision**: Retain both (the association carries independent temporal/audit semantics; the direct relation is the primary jurisdiction). Add a `CalendarJurisdictionConsistency` constraint requiring the direct `calendarJurisdiction` logical identity to match the active `JurisdictionCalendarBinding` for the same calendar version. SME confirmation (RFC-003 Q5) required on whether the direct relation should eventually be derived from the association.

### D11. MIC lifecycle and reference-data fields (P1)

**Problem**: If `MICRegistryEntry` is a full ISO 10383 adapter, it lacks `marketCategory`, status, effective/expiry times, operator/LEI, and location. If it is only an identity slice, its definition over-claims.

**Decision**: Scope `MICRegistryEntry` explicitly as a "minimal MIC identity slice" (identity, entry kind, authority, facility binding, lifecycle status) with **optional** lifecycle fields added additively: `micOperationalStatus` (active/updated/expired → new `MICOperationalStatus` code list), `micEffectiveFrom`, `micEffectiveTo`, `micReplacedBy`, `marketCategory` (D1). The source-artifact triple is retained. The definition is narrowed to match the slice scope. SME confirmation (RFC-003 Q1) required before fuller ISO 10383 fields are added.

### D12. IANA tzdb versioning and DST policy (P1)

**Problem**: `ianaTimeZone` regex checks form only; no tzdb release is pinned for materialization; no DST gap/fold policy.

**Decision**: Add `tzdbRelease` (optional versioned IANA tzdb reference) and a `DstOverlapPolicy` code list (earlierTime / laterTime / invalid) to `TradingCalendar`. The existing `ianaTimeZone` pattern is **retained**. SME confirmation (RFC-003 Q7) required on the canonical policy.

## Compatibility strategy

- All existing `market-structure` IRIs are **retained** (object types, association types, relation types, attribute types, code lists, constraints) per the ADR-020/021/022/023 IRI-retention precedent.
- New attributes are optional (minCount 0) so existing data continues to load.
- New supertypes (`MICIdentifiedMarketInfrastructure`, `MarketInfrastructureComponent`, `TradeReportingFacility`, `NonVenueMarketContext`) are additive; existing subtypes keep their IRIs and supertypes.
- `OTCTradingContext` and its relations/attributes are retained with deprecation markers; downstream `market-data`, `instruments`, `orders-execution` continue to load.
- The `earlySession`/`lateSession` exception-kind values are retained as deprecated aliases; the constraint permits both during transition.
- `sessionRecurrence` is retained as a deprecated alias for `recurrenceRule`.
- Module version → **1.1.0** (additive minor), consistent with the ADR-022 / ADR-023 precedent and the fixture-impact check (fixtures use domain YAML vocabulary and SHACL path IRIs, not the exact attribute set).
- Downstream modules reviewed for IRI stability; no downstream IRI change is expected because all existing IRIs are retained. The `OTCTradingContext` migration is deferred.

## Cross-module impact

| Downstream / peer module | References into market-structure | Impact of v1.1.0 |
|---|---|---|
| `market-data` | `OTCTradingContext` (7), `TradingCalendar` (1) | None (IRIs retained; OTC deprecated not removed). Benefits from D6/D7 session semantics when adopted. |
| `instruments` | `TradingFacility` (3), `OTCTradingContext` (2) | None (IRIs retained). Benefits from D1/D3 venue taxonomy when adopted. |
| `orders-execution` | `OTCTradingContext` (3) | None (IRIs retained). OTC migration deferred to follow-up ADR. |
| `post-trade-operations` | `TradingFacility` (1), `TradingCalendar` (1) | None (IRIs retained). |
| `market-rules` (v1.1.0) | `MarketSegment`, `TradingFacility`, `TradingSessionTemplate`, `TradingSessionOccurrence`, `TradingCalendar` | None (IRIs retained). Benefits from D6/D7 richer session semantics. |
| `foundation` (v2.0.0, ADR-020) | `TradingCalendar` as BusinessCalendar specialization | None; D5 calendar-key fix aligns with the foundation BusinessCalendar interface. |

## Required evidence before Acceptance

- [x] Backbone P0 revision implemented (MS-A1..A7) in `module.yaml`.
- [x] Fixture-impact check confirms additive/non-breaking → v1.1.0 (D-version sub-decision resolved).
- [x] Regression gates run (validate-m2-core, run-domain-shacl, run-all-cq-probes) with actual results recorded below.
- [ ] SME joint review (market microstructure + reference data + OTC/execution) on RFC-003 open questions Q1–Q7.
- [ ] SME confirmation or rejection of the external regulatory citations as evidence pointers.
- [ ] Cross-module OTC migration follow-up ADR (MS-A8) — deferred, not blocking this revision.

## Sidecar fixes (at implementation time, post-acceptance)

1. **CQs**: review/add CQs for MIC reporting-facility identification, venue operator history, schedule override n-ary, cross-midnight session; version probes to match.
2. **Terminology**: add cards for `MICIdentifiedMarketInfrastructure`, `TradeReportingFacility`, `MarketInfrastructureComponent`, `VenueOperation`, `NonVenueMarketContext`, `TradingScheduleOverrideNotice`, `ScheduledTradingPhase`; fix `MarketSegment`/`TradingVenue` per D2/D3; deprecate `OTCTradingContext` card.
3. **Alignments**: version bump; align new venue taxonomy to FIBO/ISO 10383; align session materialization to RFC 5545; align operator to W3C ORG.
4. **Traceability**: add rows for new object types/associations; version bump.
5. **Gap doc**: add Round-14 P0/P1 rows; supersede the "all gaps closed at v1.0.0" line for the semantically-complete claim.
6. **M2-PLAN**: update §5.2 market-structure responsibility row to reflect the MIC/venue/operator/session/override boundary and the OTC deprecation.
7. **Registry**: bump `fin-market-structure` version in `module-registry.yaml` at implementation time.

## Status

**Accepted (v1.1.0).** The in-place backbone revision (Option C) is implemented in `ontology/domain/finance/market-structure/module.yaml` and regression-verified. The cross-module OTC migration (MS-A8) remains deferred per [RFC-003](../planning/RFC-003-market-structure-architecture.md). Items requiring SME input remain open and are not blocking:

- **MS-A8** — `OTCTradingContext` cross-module migration is gated on SME review of [RFC-003](../planning/RFC-003-market-structure-architecture.md) Q6 and a follow-up ADR. The v1.1.0 module deprecates `OTCTradingContext` and introduces `NonVenueMarketContext` as the stable-structure successor; the physical migration of three downstream importers is deferred.
- **Q1–Q7** — MIC taxonomy breadth, `MarketSegment` re-parenting, venue operator shape, session grammar, schedule-override vs live-status boundary, OTC migration boundary, and IANA tzdb policy remain SME-confirmed. The v1.1.0 module records the additive scaffolding and deprecation; the frozen sub-grammar and migration order await SME.

### Implementation record (2026-08-04, v1.1.0)

Added object types: `MICIdentifiedMarketInfrastructure`, `TradeReportingFacility`, `MarketInfrastructureComponent`, `NonVenueMarketContext`. Added association types: `VenueOperation`, `TradingScheduleOverrideNotice`. Added relation types: `operatedBy`, `venueRegulatoryClassification`, `componentOf`, `overrideAppliesToOccurrence`, `overrideForCalendar`, `overrideForFacility`, `nonVenueContextConvention`, `nonVenueContextProvider`. Added attribute types: `venueCategory`, `venueOperationValidFrom`, `venueOperationValidTo`, `authoritySessionId`, `scheduledTradingPhase`, `endDayOffset`, `recurrenceRule`, `effectiveSessionStartUtc`, `effectiveSessionEndUtc`, `overrideAnnouncementOrder`, `overrideSupersessionOrder`, `overrideReplacementStartUtc`, `overrideReplacementEndUtc`, `micOperationalStatus`, `micEffectiveFrom`, `micEffectiveTo`, `micReplacedBy`, `marketCategory`, `tzdbRelease`, `dstOverlapPolicy`. Added code lists: `VenueCategory`, `ScheduledTradingPhase`, `MICOperationalStatus`, `MICMarketCategory`, `DstOverlapPolicy`, `OverrideEffect`. Extended `CalendarExceptionKind` with `earlyClose`, `lateOpen`, `earlyOpen`, `lateClose`, `extraSession`, `segmentedInterrupt`, `segmentedResume` (legacy `earlySession`/`lateSession` retained as deprecated aliases). Added constraints: `MICRegistryEntryContract` (v2, version-bridged), `VenueOperationIntegrity`, `CalendarExceptionSupersession`, `CalendarExceptionDateConsistency`, `CalendarJurisdictionConsistency`, `ScheduleOverrideNoticeIntegrity`, `NonVenueMarketContextContract`. Updated `TradingSessionOccurrenceContract` (v2, materialization consistency). Redefined `authorityCalendarId` scope (D5). Marked `OTCTradingContext` + its 6 relations + `OTCTradingContextContract`/`OTCTradingContextReferenceContract` deprecated (`replacedBy: NonVenueMarketContext`). Marked `sessionRecurrence` deprecated (`replacedBy: recurrenceRule`). All existing IRIs retained.

### Regression evidence (actual, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** — all shapes including `jurisdiction-calendar-binding-negative` reject as expected |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **122 PASS / 0 FAIL / 0 PENDING** (61 probed CQs); 4 new CQs (CQ-MS5..MS8) defined but not yet wired to probes — their dependsOn types are newly added and probe wiring is deferred with the SME-gated materialization work |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (market-structure) | **PASS** — module.owl.ttl 1333 lines, module.shacl.ttl 1921 lines, 0 projection warnings |

`test-all-domain` step 2 has a pre-existing environment-specific concurrent-IO race on Windows (documented in ADR-023 and memory) that is not caused by this revision and is not a validation/semantic failure.

## References

- [M2-REVIEW-ROUND-14](M2-REVIEW-ROUND-14.md)
- [RFC-003](../planning/RFC-003-market-structure-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](../planning/M2-PLAN.md)
- [ADR-020](ADR-020-foundation-identity-architecture.md) (foundation v2.0.0, BusinessCalendar interface)
- [ADR-021](ADR-021-instruments-architecture.md) (QuotationConvention)
- [ADR-022](ADR-022-market-data-architecture.md) (IRI-retention + Layer 4 precedent)
- [ADR-023](ADR-023-market-rules-architecture.md) (v1.1.0 additive-revision precedent)
- [market-structure-semantic-gap.md](gap/market-structure-semantic-gap.md)
