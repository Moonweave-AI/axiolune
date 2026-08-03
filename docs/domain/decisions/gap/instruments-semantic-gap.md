# Instruments Semantic Gap

**Module**: fin-instruments  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Defines FinancialInstrument taxonomy, issuer relationships, listings, and tradable scope - not prices or positions.
- Non-goal: collapsing listing/ticker into instrument identity; duplicating venue session or settlement semantics.
- Upstream of market-data observations and portfolio holdings that reference instrument IRIs.

## Track B (reference/ alignment)

- FIBO SEC/IND/DER modules anchor Security, Equity, Debt, and derivative class boundaries via alignments.
- ISO 10962 CFI and ISO 6166 ISIN inform classification and identifier validation fixtures.
- NautilusTrader `InstrumentId` / Lean `Symbol` patterns inform composite key stories without importing API types.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| I-G1 | weak-cq | P1 | CQ-I1-I3 draft without negatives | **Closed** - 3 active CQs; slice-a duplicate ISIN negative |
| I-G2 | broken-boundary | P1 | Listed vs OTC instrument context | **Closed** - v03 listed/OTC execution context negatives |
| I-G3 | shallow-definition | P2 | Derivative subtype ladder excludes thin | **Closed** (v1.0.0) — terminology pass deferred to M1 |
| I-G4 | orphan-type | P2 | StructuredProduct / Warrant without CQ | **Closed** (v1.0.0) — strategy consumer in M1 scope |
| I-G5 | missing-concept | P1 | CA affected instrument vs post-trade link | **Closed** - alignment note + post-trade CA matrix |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | ISIN/instrument key; listing key in CQ-I2 |
| 2 | pass | Classification uses CodeList; quantities not misused |
| 3 | pass | Genus/differentia present on core types |
| 4 | pass | Listing-venue + OTC boundary in v03 negatives |
| 5 | pass | Listing intervals in slice-a + instrument fixtures |
| 6 | pass | Three active CQs with narratable negatives |
| 7 | pass | FIBO SEC + ISO sources cited |
| 8 | pass | slice-a instrument mapping + ISIN integrity |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)
