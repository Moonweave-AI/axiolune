# Foundation Semantic Gap

**Module**: fin-foundation  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Provides cross-module identity vocabulary (Party, LegalEntity, identifiers, currency, jurisdiction, calendar interfaces) without redefining M3 value types.
- Non-goal: portfolio holdings, order lifecycle, market observations, or broker-specific status codes.

## Track B (reference/ alignment)

- FIBO FND/BE anchors for LegalEntity, Currency, and identifier schemes (ISIN, LEI, MIC) via terminology cards.
- ISO 6166 / ISO 10383 / GLEIF LEI govern identifier validation rules.
- NautilusTrader and Lean party/account identifiers inform internal key shapes but are not copied as canonical types.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| F-G1 | weak-cq | P1 | Core CQs draft without staging | **Closed** - CQ-F1-F4 active; slice-a + duplicate-isin negatives |
| F-G2 | shallow-definition | P1 | Party/LegalEntity boundary negatives | **Closed** - foundation-account-identity + conflict cases |
| F-G3 | broken-boundary | P2 | Assignment interval vs subject | **Closed** (v1.0.0) ? partial v03 negatives; M1 polish only |
| F-G4 | mapping-gap | P1 | ISIN/LEI mapping slice | **Closed** - slice-a s5 mapping + identity plan fixtures |
| F-G5 | orphan-type | P2 | JurisdictionCalendarBinding CQ | **Closed** (v1.0.0) ? CQ-MS4 + [MS-G4](../../planning/mapping-narratives/MS-G4-jurisdiction-calendar-binding.md) |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | ISIN/LEI keys + conflict/duplicate negatives (CQ-F4) |
| 2 | pass | Money/Quantity via M3; currency jurisdiction CQ-F2 |
| 3 | pass | Terminology cards + account-identity negatives |
| 4 | pass | Cross-entity integrity via slice-a conflict cases |
| 5 | pass | TemporalFact on assignments in foundation fixtures |
| 6 | pass | Four active CQs; probes 108/0/0 |
| 7 | pass | FIBO/ISO locators in bibliography |
| 8 | pass | slice-a ISIN mapping + identity materialization plan |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)
