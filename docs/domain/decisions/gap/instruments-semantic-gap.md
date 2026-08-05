# Instruments Semantic Gap

**Module**: fin-instruments
**Version**: 2.0.0
**Date**: 2026-08-04
**Round-12**: all gaps closed at v1.0.0; **reopened and re-closed at v2.0.0** per ADR-021

## Track A (M2-PLAN scope)

- Defines FinancialInstrument identity, classification, issuance, listings, and quotation conventions — not prices, positions, or market-data observations.
- Non-goal: collapsing listing/ticker into instrument identity; duplicating venue session or settlement semantics; full derivative/bond/fund product terms (deferred to fin-derivatives).
- Upstream of market-data observations and portfolio holdings that reference instrument IRIs.
- v2.0.0: QuotationConvention abstract layer introduced; InstrumentClassificationAssertion (CFI) introduced; isTradedOn renamed to isAdmittedToTradingOn.

## Track B (reference/ alignment)

- FIBO FBC/SEC modules anchor FinancialInstrument, Security, and Listing via alignments.
- ISO 10962:2019 CFI (Fourth edition, FIBO-anchored) informs InstrumentClassificationAssertion and EquitySecurity classification.
- ISO 6166:2021 ISIN informs identifier validation (owned by fin-foundation).
- NautilusTrader `InstrumentId` / Lean `Symbol` patterns inform composite key stories without importing API types.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| I-G1 | weak-cq | P1 | CQ-I1-I3 draft without negatives | **Closed** v1.0.0; **re-closed** v2.0.0 — CQ version 2.0.0, CQ-I1 conditionalized, CQ-I3 EquityInstrument→EquitySecurity |
| I-G2 | broken-boundary | P1 | Listed vs OTC instrument context | **Closed** v1.0.0 |
| I-G3 | shallow-definition | P2 | Derivative subtype ladder | **Deferred** — derivative/bond/fund product terms explicitly deferred to fin-derivatives (ADR-021) |
| I-G4 | orphan-type | P2 | StructuredProduct / Warrant | **Deferred** — explicitly deferred to fin-derivatives (ADR-021) |
| I-G5 | missing-concept | P1 | CA affected instrument vs post-trade link | **Closed** v1.0.0 |
| I-G6 | missing-classification | P0 | No CFI, classification code list, or classification assertion | **Closed** v2.0.0 — InstrumentClassificationAssertion + CFICategory introduced (ADR-021 D2) |
| I-G7 | quotation-bottleneck | P0 | DirectUnitPriceQuotationContract forces single profile, blocks futures/options/bonds | **Closed** v2.0.0 — QuotationConvention abstract layer introduced (ADR-021 D1) |
| I-G8 | cq-orphan-iri | P0 | CQ-I1 references Issuer/isIssuedBy, CQ-I3 references EquityInstrument | **Closed** v2.0.0 — CQ rewritten with actual IRIs |
| I-G9 | terminology-orphan | P0 | Terminology has Issuer, SecuritiesOffering (nonexistent) | **Closed** v2.0.0 — orphans removed, InstrumentIssuance/DirectUnitPriceQuotationContract/isAdmittedToTradingOn added |
| I-G10 | alignment-drift | P0 | Alignment version 0.3.0, CFI sourceRelease=ISO-6166 | **Closed** v2.0.0 — version 2.0.0, CFI sourceRelease=ISO-10962 |
| I-G11 | isTradedOn-semantics | P0 | isTradedOn conflates admission with tradeability | **Closed** v2.0.0 — renamed to isAdmittedToTradingOn (ADR-021 D5) |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | ISIN/instrument key; listing key in CQ-I2; conditionalized issuer in CQ-I1 |
| 2 | pass | Classification via InstrumentClassificationAssertion (CFI); quantities not misused |
| 3 | pass | Genus/differentia present on core types; Equity voting/dividend weakened |
| 4 | pass | Listing-venue + OTC boundary in v03 negatives |
| 5 | pass | Listing intervals in slice-a + instrument fixtures |
| 6 | pass | Three active CQs v2.0.0 with actual IRIs; CQ-I3 includes CFI |
| 7 | pass | FIBO FBC/SEC + ISO 10962/6166 sources cited |
| 8 | pass | slice-a instrument mapping + ISIN integrity |

P0/P1/P2 status: closed (v2.0.0 2026-08-04 per ADR-021)
