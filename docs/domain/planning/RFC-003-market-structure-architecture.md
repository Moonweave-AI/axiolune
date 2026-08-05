# RFC-003: `fin-market-structure` Architecture — Revise-in-Place vs. OTC Migration

**Status**: Proposed (open for SME discussion)
**Date**: 2026-08-04
**Scope**: `ontology/domain/finance/market-structure` module structure and v1.0.0 → next-version evolution
**Related**: [M2-REVIEW-ROUND-14](../decisions/M2-REVIEW-ROUND-14.md), [ADR-024](../decisions/ADR-024-market-structure-architecture.md) (Proposed), [RFC-001](RFC-001-m2-conformance-profile-and-domain-contract.md), [M2-PLAN §5.2](M2-PLAN.md), [ADR-020](../decisions/ADR-020-foundation-identity-architecture.md), [ADR-022](../decisions/ADR-022-market-data-architecture.md)

## Purpose

Decide the **structural** response to the Round-14 architecture review of `fin-market-structure` v1.0.0. The review confirmed eight P0 issues and eight P1 corrections (verified against `module.yaml` and `M2-PLAN`); it did **not** modify any file or run any validator. This RFC is the decision input for [ADR-024](../decisions/ADR-024-market-structure-architecture.md). Per the Moonweave baseline, no `module.yaml` edit proceeds until ADR-024 is Accepted, and the OTC migration option requires SME joint review.

This RFC is **not** a re-litigation of Round-12 v1.0.0 acceptance. Round-12 stands for the [RFC-001](RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This RFC addresses the stronger claim that market-structure is a *semantically complete* stable-structure module — which the released module does not yet satisfy, despite its correct backbone.

## Background

### Confirmed P0 issues (verified)

1. **MIC target range too narrow.** `MICRegistryEntryContract` forces OPRT ⇒ `TradingVenue` and SGMT ⇒ `MarketSegment`. ISO 10383 Operating MICs also identify trade reporting facilities, APAs, ARMs, and other market infrastructure; Segment MICs can be sections of a reporting facility, not only of a trading venue. The module claims broad ISO 10383 alignment while excluding standard objects.
2. **MarketSegment ontological bias.** `MarketSegment` is a `TradingFacility` subtype and must belong to a `TradingVenue`. ISO 10383 semantics make a segment a *section* of a market/exchange/reporting facility — a component, not necessarily an independent facility.
3. **Venue, market, and operator conflated.** `TradingVenue` is defined as "operates a market" but has no `operatedBy` link to a `Party`. A market system/venue and the legal entity operating it are not the same object (MiFID II distinguishes market operator from trading venue; RM/MTF/OTF are venue categories, SI is non-venue).
4. **MIC constraint conflates logical identity and exact version.** `registryFacility` is an exact-version reference while `marketSegmentVenue` is a logical reference; the `MICRegistryEntryContract` compares them directly, which is a category error under strict temporal versioning.
5. **Calendar identity key self-contradiction.** `authorityCalendarId` claims uniqueness "within the authority" but the logical key is `(facility, authority, authorityCalendarId)`. Same authority + same ID under different facilities yields multiple logical calendars, contradicting the attribute definition.
6. **Session template cannot deterministically materialize.** `sessionRecurrence` is called deterministic but is only a non-empty string; the occurrence constraint validates only the join and `start < end`. One cannot derive "does this business date have this session" or "is the UTC interval correctly produced from the local template and DST."
7. **"Tradable window" vs "cancelled scheduled window" conflict.** `TradingSessionOccurrence` is typed as a concrete tradable time window, but holiday/closure "remove" it; multiple exceptions on one occurrence have no priority or synthesis rule, so "deterministically alter" does not actually hold.
8. **OTCTradingContext severely out of scope.** It mixes provider/source contract, quote/settlement currency, reporting facility, concrete counterparty pair, and execution semantics. Its logical key is a provider contract — a data-extraction namespace, not an economic-entity identity. It is not stable market structure.

### Design-intent drift (confirmed)

[M2-PLAN §5.2](M2-PLAN.md) defines the module boundary as "交易场所、市场段、交易日历和交易时段的稳定结构" and explicitly excludes one-off rules and tickers. `OTCTradingContext` carries provider contracts, counterparties, and execution-adjacent semantics that belong to Layer 4 / `instruments` / `orders-execution` / `post-trade-operations`, not to stable structure. The venue/calendar/session backbone is on-plan; the OTC object is off-plan.

### Cross-module dependency (critical constraint)

`OTCTradingContext` is referenced as an association **range** by three downstream v1.0.0 modules:

| Downstream module | References to `OTCTradingContext` | Also references |
|---|---|---|
| `market-data` | 7 (observation context associations) | `TradingCalendar` |
| `instruments` | 2 (tradability context associations) | `TradingFacility` |
| `orders-execution` | 3 (execution context associations) | — |
| `post-trade-operations` | 0 | `TradingFacility`, `TradingCalendar` |
| `market-rules` (v1.1.0) | 0 | `MarketSegment`, `TradingFacility`, `TradingSessionTemplate`, `TradingSessionOccurrence`, `TradingCalendar` |

**Removing `OTCTradingContext` is therefore source-breaking across three released modules** and cannot be done as an additive in-place revision. Its migration is a cross-module change that requires its own ADR and coordinated SME review.

### What must be retained (non-negotiable)

- The `TradingFacility` / `TradingVenue` / `MarketSegment` venue hierarchy as a cross-module stable anchor (instruments, market-rules, market-data, orders-execution all depend on it).
- `MICRegistryEntry` as an independent, temporal, provenance-bearing fact (not a string attribute on Venue).
- The `TradingCalendar` → `TradingSessionTemplate` → `TradingSessionOccurrence` → `TradingCalendarException` layering; templates are **not** mutated by exceptions.
- Local-clock templates with IANA time zones; occurrences as UTC half-open intervals.
- All existing `market-structure` IRIs (object types, association types, relation types, attributes, code lists, constraints) — per the ADR-020/021/022 IRI-retention precedent.

## Option A — Revise in place (v1.1.0, additive)

Add the missing semantics to the single `market-structure` module as an additive, IRI-retentive revision.

### What changes (P0)

- **MS-A1 (MIC range):** Introduce `MICIdentifiedMarketInfrastructure` as a supertype above `TradingVenue`, plus `TradeReportingFacility` (and a hook for APA/ARM). Broaden `MICRegistryEntryContract` so OPRT may identify a `TradeReportingFacility` as well as a `TradingVenue`, and SGMT may be a section of a reporting facility. `TradingVenue` and `MarketSegment` IRIs retained; the new supertype is additive.
- **MS-A2 (Segment bias):** Retain `MarketSegment`'s `TradingFacility` supertype (IRI stability) but add a neutral `componentOf` part-of relation and scope-document the type as "a section/component of an operating entity, modeled as a facility subtype for shared reference range only." Add `MarketInfrastructureComponent` as an abstract supertype naming the section semantics.
- **MS-A3 (Venue/operator):** Introduce `VenueOperation` (association type, temporal, provenanced) and `operatedBy` (functional relation → `foundation/Party`). `TradingVenue` is scoped as "the market system/venue" only; regulatory categorization (RM/MTF/OTF) becomes a temporal, evidenced classification fact, not a hardcoded global supertree.
- **MS-A4 (MIC logical/exact bridge):** Rewrite the `MICRegistryEntryContract` expression to bridge logical and exact versions explicitly — compare `registryFacility.marketSegmentVenue` with `versionOf(operatingMICEntry.registryFacility)` and require the OPRT facility to be an exact version of the logical venue.
- **MS-A5 (Calendar key):** Redefine `authorityCalendarId`'s scope text to "unique within (authority, facility)" so the attribute definition matches the three-component logical key. No IRI or cardinality change; definition fix only.
- **MS-A6 (Session materialization):** Add `authoritySessionId`, a `ScheduledTradingPhase` code list (preOpen, openingAuction, continuousTrading, closingAuction, postClose, maintenance, reportingOnly), `endDayOffset` (cross-midnight), and a formal `recurrenceRule` (RFC 5545 RRULE-bounded or a versioned native grammar). Extend the occurrence constraint to require recurrence/timezone/UTC consistency.
- **MS-A7 (Tradable vs scheduled):** Clarify `TradingSessionOccurrence` as a *scheduled* window (IRI retained); add `effectiveSessionStartUtc`/`effectiveSessionEndUtc` as the derived *effective tradable* interval and a `TradingScheduleOverrideNotice` n-ary association so one announcement can adjust multiple occurrences with a supersession/announcement order and a single final effective interval or cancellation result.

### What is deferred (P0-8 OTC, cross-module)

- **MS-A8 (OTC out of scope):** `OTCTradingContext` is **retained** (IRI stability — three downstream modules reference it) but marked `deprecated: true`, `deprecatedSince: 1.1.0`, `replacedBy: NonVenueMarketContext` (a new stable non-venue market context that carries **only** the stable structure: a non-venue context identity and its market convention orientation). The provider contract / source mapping moves to Layer 4; the quote/settlement currency and quotation convention move to `instruments` (QuotationConvention, ADR-021); the counterparty pair, concrete execution, and reporting obligation move to `orders-execution` / `post-trade-operations`. The actual migration of downstream references is a **cross-module follow-up ADR** requiring SME joint review — it is **not** done in this revision.

### P1 corrections (additive where possible)

- Rename exception semantics to `earlyClose` / `lateOpen` (new code values; `earlySession`/`lateSession` retained as deprecated aliases); support both-ends adjustment, early open, late close, extra session, and segmented interrupt/resume.
- Separate "pre-announced schedule override" (this module) from real-time status/halt (`market-data` per ADR-022, `market-rules` for triggers, `instruments`/listing for instrument-level suspend).
- Reconcile `calendarJurisdiction` (direct relation) and `JurisdictionCalendarBinding` (association) as a single source of truth via a `CalendarJurisdictionConsistency` constraint.
- Add MIC lifecycle fields (`micOperationalStatus`, `effectiveFrom`, `effectiveTo`, `replacedBy`), `marketCategory`, and operator/LEI as optional fields; scope `MICRegistryEntry` as either a "minimal MIC identity slice" or a fuller ISO 10383 adapter (decision recorded in ADR-024).
- Add a versioned IANA tzdb reference (`tzdbRelease`) and a DST gap/fold interpretation policy (`DstOverlapPolicy`).

### Compatibility

- **Version**: 1.1.0 (additive within major; all existing IRIs retained, new attributes minCount 0, new code values appended). The fixture-impact check confirms fixtures use domain YAML vocabulary (`target: OTCTradingContext`, `counterpartyMode`) and SHACL path IRIs for violation checks — they do **not** reference the exact attribute set or any new type, so additions are non-breaking. This is consistent with the ADR-022 IRI-retention precedent and the market-rules v1.1.0 outcome.
- `OTCTradingContext` and its relations/attributes are **retained** (deprecated) — downstream modules continue to load.
- New supertypes (`MICIdentifiedMarketInfrastructure`, `MarketInfrastructureComponent`) are additive; existing subtypes keep their IRIs and supertypes.
- Deprecation markers on `OTCTradingContext` and the two exception-kind aliases carry `replacedBy` pointers.

### Pros

- Single module; simplest import DAG; no new registry entries beyond the version bump.
- Lowest migration cost; reuses existing CQs, fixtures, alignments, traceability.
- Does not block three downstream modules; OTC migration is a measured follow-up.

### Cons

- `OTCTradingContext` remains in the module (deprecated) until the cross-module migration ADR lands — the "out of scope" smell is documented but not physically removed this cycle.
- `MarketSegment` retains its `TradingFacility` supertype (IRI stability) even though the cleaner model would demote it to a part-of relation; the fix is by addition + scoping, not by re-parenting.
- Single module must host both the venue/MIC/calendar backbone and the (deprecated) OTC context for one cycle.

## Option B — Full OTC migration now (v2.0.0, cross-module)

Remove `OTCTradingContext` from `market-structure`, migrate its stable part to a new `NonVenueMarketContext`, and update all three downstream modules (`market-data`, `instruments`, `orders-execution`) to reference the new type. Move provider contract to Layer 4, currencies/convention to `instruments`, counterparties/execution/reporting to `orders-execution`/`post-trade-operations`.

### Compatibility

- **Version**: 2.0.0 (major) — `OTCTradingContext` IRI removed; downstream module IRIs updated; import-DAG revision for three modules; fixtures/probes rewritten.
- A migration/deprecation map and coordinated multi-module release are required.

### Pros

- Cleanest boundary: market-structure contains only stable structure; OTC execution/reporting semantics leave the module immediately.

### Cons

- Highest migration cost: three released downstream modules must change their association ranges in lockstep; fixture/probe/alignment rework across modules.
- Violates the review's own convergence order ("先做 ADR/RFC... 重构 MIC... 修复 Calendar... 最后补 lifecycle") — OTC migration is listed as a P0 but its cross-module impact makes it the *last* practical step, not the first.
- Requires SME joint review before execution; cannot be completed in this revision cycle without blocking the backbone fixes.

## Option C — Revise backbone in place now, defer OTC migration (recommended path)

Execute Option A's backbone P0 revisions (MS-A1..A7) and the P1 corrections as **v1.1.0** (additive, IRI-retentive). Mark `OTCTradingContext` deprecated and introduce `NonVenueMarketContext` as its stable-structure successor (additive). **Defer** the cross-module migration of downstream `OTCTradingContext` references (MS-A8) to a follow-up ADR requiring SME joint review. After P0 backbone closure and regression pass, re-evaluate the OTC migration with SME input.

### Rationale

- The review's own convergence order begins with "先做 ADR/RFC" and ends with the lifecycle/terminology cleanup; the OTC split is the cross-module step that depends on the backbone being correct first. Reversing that order risks rebuilding on a broken backbone.
- The seven backbone P0s (MIC range, segment bias, venue/operator, MIC version bridging, calendar key, session materialization, tradable-vs-scheduled) are prerequisite regardless of OTC migration; doing them once in place is cheaper than distributing the rebuild across a migrated OTC boundary.
- The OTC migration is genuinely cross-module (three downstream importers) and is correctly a *measured follow-up ADR*, not an in-place edit. This matches the ADR-023 / MR-A12 precedent (profile split deferred) and the ADR-022 precedent (Layer 4 physical fields deprecated, not removed, pending Layer 4 adoption).
- SME joint review is required for the OTC migration boundary and for confirming the external regulatory citations; it is not required to begin the additive backbone revision.

### Trade-off

- Accepts a deprecated `OTCTradingContext` remaining in the module for one revision cycle.
- Defers the physical removal of OTC execution/reporting semantics to a measured cross-module follow-up.

## Open questions for SME review

1. **MIC taxonomy.** Does the module become a "trading-venue MIC subset" (narrow) or a "general market infrastructure MIC adapter" (broad, adding `TradeReportingFacility` / APA / ARM)? If broad, what is the minimal `marketCategory` vocabulary? *(SME: market microstructure + reference data)*
2. **MarketSegment re-parenting.** Is `MarketSegment` retained as a `TradingFacility` subtype (IRI stability, scoping by documentation) or demoted to a `componentOf` part-of relation under a `MarketInfrastructureComponent`? Confirm ISO 10383 "section" semantics vs. FIBO `MarketSegmentLevelMarket`. *(SME: market microstructure)*
3. **Venue operator and regulatory category.** Confirm that `VenueOperation` (temporal, to `Party`) is the right shape for operator history, and that RM/MTF/OTF/SI categorization is a temporal evidenced fact (not a global supertree). Confirm MiFID II Article 4 scope. *(SME: market microstructure + regulation)*
4. **Session materialization grammar.** Is RFC 5545 RRULE (subset, versioned) adopted as the recurrence grammar, or a native Axiolune grammar? Confirm the cross-midnight `endDayOffset` and business-date / trade-date attribution rule for overnight sessions (NYSE extended-hours). *(SME: market microstructure)*
5. **Schedule override vs live status.** Confirm that pre-announced overrides live in `market-structure`, real-time venue/session/instrument status/halt lives in `market-data`, triggers/resume rules in `market-rules`, and instrument-level suspend in `instruments`/listing. Confirm FIX Open/Halted/Pre-Open/Closed status boundary. *(SME: market microstructure + market-data + market-rules)*
6. **OTC migration boundary.** Confirm the split of `OTCTradingContext`: provider contract + source mapping → Layer 4; quote/settlement currency + quotation convention → `instruments` (QuotationConvention); counterparty pair + execution + reporting obligation → `orders-execution` / `post-trade-operations`; stable non-venue context → `NonVenueMarketContext` in `market-structure`. Confirm the three downstream importers' migration order. *(SME: OTC + execution + reference data)*
7. **IANA tzdb versioning.** Confirm whether the calendar pins a `tzdbRelease` and which DST gap/fold policy (earlier/later/invalid) is canonical. *(SME: market microstructure + data engineering)*

External citations referenced by the review (to be confirmed by SME, **not** asserted as provenance): ISO 10383:2012 and its FAQ, MiFID II Article 4, RFC 5545, NYSE trading hours / extended-hours FAQ, FIX trading-session status/event vocabulary, ESMA Article 32.

## Versioning sub-decision (for ADR-024)

- Is the `OTCTradingContext` **deprecation** (not removal) source-compatible with existing fixtures/probes? Yes — fixtures use `target: OTCTradingContext` + `counterpartyMode` vocabulary and SHACL path IRIs; they do not enumerate the attribute set. → **1.1.0**.
- Are the new supertypes (`MICIdentifiedMarketInfrastructure`, `MarketInfrastructureComponent`, `TradeReportingFacility`, `NonVenueMarketContext`) additive? Yes — new IRIs, existing subtypes unchanged. → **1.1.0**.
- Are the calendar-key, MIC-constraint, and session-materialization changes source-compatible? The `authorityCalendarId` change is a definition/scope-text fix (no cardinality/IRI change); the constraint expressions are Custom/SPARQL text updates against retained IRIs; the new session attributes are minCount 0. → **1.1.0**.
- Is the exception-kind rename (`earlySession`→`earlyClose`, `lateSession`→`lateOpen`) breaking? The old values are **retained** as deprecated aliases; the constraint permits both during transition. → **1.1.0**.
- **Conclusion: v1.1.0 (additive minor)**, consistent with the ADR-022 IRI-retention precedent and the market-rules v1.1.0 outcome.

## Recommendation

**Option C** — revise the backbone in place now (v1.1.0, additive, IRI-retentive), mark `OTCTradingContext` deprecated with a `NonVenueMarketContext` successor, and defer the cross-module OTC migration to a follow-up ADR after backbone closure and SME joint review. This matches the review's own convergence order and the Moonweave baseline (major/cross-module changes via ADR/RFC, decisions written back to authoritative sources, no implementation before ADR acceptance, no cross-module breakage as an in-place edit).

## References

- [M2-REVIEW-ROUND-14](../decisions/M2-REVIEW-ROUND-14.md)
- [ADR-024](../decisions/ADR-024-market-structure-architecture.md) (Proposed)
- [RFC-001](RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](M2-PLAN.md)
- [ADR-020](../decisions/ADR-020-foundation-identity-architecture.md) (foundation v2.0.0, BusinessCalendar interface)
- [ADR-022](../decisions/ADR-022-market-data-architecture.md) (IRI-retention precedent, Layer 4 boundary)
- [market-structure-semantic-gap.md](../decisions/gap/market-structure-semantic-gap.md)
