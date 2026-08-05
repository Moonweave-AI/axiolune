# Foundation Semantic Gap

**Module**: fin-foundation
**Version**: 2.0.0
**Date**: 2026-08-04
**Round-12**: all gaps closed at v1.0.0; **reopened and re-closed at v2.0.0** per ADR-020

## Track A (M2-PLAN scope)

- Provides cross-module identity vocabulary (Party, LegalEntity, identifiers, currency, jurisdiction, calendar interface) without redefining M3 value types.
- Non-goal: portfolio holdings, order lifecycle, market observations, or broker-specific status codes.
- v2.0.0: Foundation provides a thin `BusinessCalendar` interface; `fin-market-structure` provides the concrete `TradingCalendar` and `JurisdictionCalendarBinding` (per ADR-020 D6).

## Track B (reference/ alignment)

- FIBO FND/BE anchors for LegalEntity, Currency, and identifier schemes (ISIN, LEI, MIC) via terminology cards.
- ISO 6166 / ISO 10383 / GLEIF LEI govern identifier validation rules.
- NautilusTrader and Lean party/account identifiers inform internal key shapes but are not copied as canonical types.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| F-G1 | weak-cq | P1 | Core CQs draft without staging | **Closed** v1.0.0; **re-closed** v2.0.0 — CQ version 2.0.0, CQ-F1 reworded (issuer resolution), CQ-F4 IRI fixed |
| F-G2 | shallow-definition | P1 | Party/LegalEntity boundary negatives | **Closed** v1.0.0 |
| F-G3 | broken-boundary | P2 | Assignment interval vs subject | **Closed** v1.0.0; **re-closed** v2.0.0 — logical-identity anchoring added (ADR-020 D4) |
| F-G4 | mapping-gap | P1 | ISIN/LEI mapping slice | **Closed** v1.0.0 |
| F-G5 | orphan-type | P2 | JurisdictionCalendarBinding CQ | **Closed** v1.0.0 — CQ-MS4 + [MS-G4](../../planning/mapping-narratives/MS-G4-jurisdiction-calendar-binding.md); v2.0.0 ADR-020 D6 records Foundation interface vs market-structure specialization |
| F-G6 | orphan-terminology | P0 | MonetaryAmount/QuantityValue/hasCurrencyCode in terminology cards conflict with M3 boundary | **Closed** v2.0.0 — orphan entries removed from fin-foundation-terms.yaml |
| F-G7 | identity-key | P0 | IdentifierValue authority-scoped key missing namespace dimension | **Closed** v2.0.0 — IdentifierNamespace introduced (ADR-020 D1) |
| F-G8 | scheme-release-conflation | P0 | Scheme identity conflated with scheme release/version | **Closed** v2.0.0 — IdentifierSchemeRelease introduced (ADR-020 D2) |
| F-G9 | authority-role-incomplete | P0 | IdentifierAuthorityRole only has assigningAuthority | **Closed** v2.0.0 — extended to 6 roles + AuthorityRoleAssignment (ADR-020 D3) |
| F-G10 | iso4217-incomplete | P0 | ISO 4217 entry kind/publication/minor-unit not modeled | **Closed** v2.0.0 — ISO4217RegistryPublication/EntryKind/ListCategory introduced (ADR-020 D5) |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | ISIN/LEI keys + conflict/duplicate negatives (CQ-F4) |
| 2 | pass | Money/Quantity via M3; currency jurisdiction CQ-F2; orphan terminology removed (v2.0.0) |
| 3 | pass | Terminology cards + account-identity negatives |
| 4 | pass | Cross-entity integrity via slice-a conflict cases |
| 5 | pass | TemporalFact on assignments in foundation fixtures |
| 6 | pass | Four active CQs; version 2.0.0; CQ-F1 reworded; CQ-F4 IRI fixed |
| 7 | pass | FIBO/ISO locators in bibliography |
| 8 | pass | slice-a ISIN mapping + identity materialization plan |

P0/P1/P2 status: closed (v2.0.0 2026-08-04 per ADR-020)
