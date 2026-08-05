# ADR-021: Instruments Architecture (v2.0.0)

**Status**: Accepted  
**Date**: 2026-08-04  
**Context**: Independent read-only review of `fin-instruments` v1.0.0 (2026-08-04)  
**Related**: ADR-014 (release governance), ADR-017 (v1.0.0 completion), ADR-020 (foundation identity), M2-PLAN §5.2

## Context

An independent semantic review of `fin-instruments` v1.0.0 concluded: **retain the module, require architectural revision (Request changes)**. The review cross-checked the module against ISO 10962, ISO 6166, MiFIR Article 27 (ESMA), CME/Cboe quotation conventions, IFRS 9/13, FIBO, and ISDA, and identified six P0 issues.

The module is currently a narrow slice ("securities/equity + listing + direct unit price quotation") rather than the general financial-instrument core promised by its name and M2-PLAN. This ADR records the decisions and governs the v1.0.0 → **v2.0.0** major version bump per ADR-014.

### Module boundary (revised)

Instruments is a **thin general core** for stable financial-instrument identity, temporal classification, issuance/listing relationships, and quotation conventions. Complex product terms (derivatives, bonds, funds) are deferred to future modules (`fin-derivatives`, etc.). The module is not expanded into full FIBO, nor is it narrowed to "listed equity only."

Foundation owns: stable identity, identifier assignment, currency code/registry, evidence and three-axis time.  
Instruments owns: instrument reference data, classification, issuance/listing relationships, quotation conventions.  
Market Structure owns: venue, segment, OTC context, market calendar.  
Market Rules owns: tick/lot, rule applicability.  
Market Data owns: bid/ask/last/close observation values, not price values inside quotation conventions.

## Decisions

### D1. QuotationConvention — abstract quotation layer

**Problem**: `DirectUnitPriceQuotationContract` forces `contractMultiplier = 1` and forbids par, clean/dirty, accrued, inverse, notional-scaled, and index-point quotations. Market Data's Price/Quote/Trade/Bar all depend on it (12 downstream references). Real futures, options, bonds, FX, indices, yields, and spreads cannot be expressed by this single profile.

**Decision**: Introduce `QuotationConvention` as a new abstract object type — the parent of all quotation expression profiles. `DirectUnitPriceQuotationContract` becomes its first concrete subtype (its existing IRI is **retained**; `superTypes` is extended to include `QuotationConvention`). Future profiles (e.g., `YieldQuotationConvention`, `ParQuotationConvention`, `NotionalQuotationConvention`) can be added without breaking downstream references. The existing `contractMultiplier` and `quotationDenominatorUnit` attributes are **retained** on `DirectUnitPriceQuotationContract` but their semantics are scoped to the direct-unit profile only.

### D2. InstrumentClassificationAssertion — temporal CFI classification

**Problem**: M2-PLAN declares this module responsible for classification, and CFI was placed in the Identifier context, but the module has no CFI, classification code list, or classification assertion. CFI is a classification, not a persistent identity; the same instrument may need a new CFI after voting/rights changes (ISO 10962:2019, anchored by FIBO local reference EquityCFIClassificationIndividuals.rdf).

**Decision**: Introduce `InstrumentClassificationAssertion` as a new association type — a temporal fact asserting that a financial instrument is classified under a classification scheme (e.g., CFI) at a specific code, with a scheme release, an authority/source, and a valid-time interval. `EquitySecurity` is **retained** as a coarse-grained type but is no longer the sole classification mechanism. A `CFICategory` code list is introduced for the CFI asset-level categories. This is additive and does not replace the existing type hierarchy.

### D3. Instrument identity granularity — stable identity vs issue/series/tranche

**Problem**: `InstrumentIssuance` is defined as "bringing a Security into existence" but cannot distinguish first issuance, secondary offering, different share classes, series, or tranches. ANNA guidelines specify that different share classes or non-homogeneous trches may require different ISINs.

**Decision**: This ADR records the **identity-continuity rule**: `FinancialInstrument` represents the stable economic/legal instrument identity, independent of any particular issuance or listing. Issue/Series/Tranche granularity is **deferred** to a future ADR (when `fin-derivatives` or bond modules require it). The existing `InstrumentIssuance` IRI is **retained**; its semantic scope is clarified as a historical issuance fact anchoring the stable instrument identity, not as a per-share-class or per-tranche event.

### D4. SecurityOffering — source-record semantics

**Problem**: `SecurityOffering` can only point to a single `Security`, with no offeror, primary/secondary distinction, underwriter, jurisdiction, document, price, quantity, or offering leg. Real offerings may cover one or more securities and may be secondary issuances.

**Decision**: `SecurityOffering` is clarified as a **source-record/assertion** class, not a complete securities-offering business model. Its existing IRI is **retained**. A future `OfferingLeg` and full offering role system are **deferred** to when a capital-markets module requires them. The current single `offeredSecurity` relation is retained as the minimal viable link.

### D5. isTradedOn — rename to isAdmittedToTradingOn

**Problem**: `isTradedOn` derives from listings and conflates admission, listing, suspension, trading-session eligibility, and actual tradeability. MiFIR Article 27 distinguishes "admitted to trading" (regulated markets, defined-list instruments) from "traded on a trading venue" (MTFs/OTFs/SIs, triggered by orders/quotes); instrument lifecycle end is handled via a "Termination date" field, not a "suspended" or "excluded" status.

**Decision**: `isTradedOn` is **renamed** to `isAdmittedToTradingOn` (the old IRI is retained as a deprecated alias with `replacedBy: isAdmittedToTradingOn`). The derivation semantics are clarified: the relation holds when an instrument has at least one point-in-time-eligible active listing at the given as-of time. Actual tradeability depends on listing, segment, trading-status, calendar, and market rules — not on this relation alone.

### D6. QuotationKind — sub-type entailment rather than classification

**Problem**: `QuotationKind` has only `directUnitPrice` as a member, providing no classification value.

**Decision**: `QuotationKind` is **retained** but its role is redefined as a sub-type entailment marker within `QuotationConvention`. When `DirectUnitPriceQuotationContract` is used, `quotationKind = directUnitPrice` is a tautological entailment of the sub-type, not a classification choice. Future quotation profiles will extend this code list. No existing IRI is removed.

### D7. Currency/Unit bridge — deferred to Foundation ADR-020

**Problem**: M3 `MonetaryAmount` uses three-letter currency strings, while listing/quotation uses `Currency` entities; there is no traceable temporal mapping between them. `quotationDenominatorUnit` is a bare URI with an unverifiable controlled-unit registry.

**Decision**: The Currency-to-code bridge (`CurrencyCodeAssertion`) is owned by Foundation per ADR-020 D5. The controlled-unit registry for quotation denominator units is **deferred** to when a dedicated unit-ontology module is introduced. The existing `quotationDenominatorUnit` URI attribute and `normalizationContractRef`/`normalizationContractDigest` pair are **retained** as the minimal viable anchors.

## Compatibility strategy

- All existing instruments IRIs are **retained**.
- `DirectUnitPriceQuotationContract` gains `QuotationConvention` as a super-type; downstream references (12 in market-data/orders/portfolio) continue to work.
- `isTradedOn` IRI retained as deprecated alias for `isAdmittedToTradingOn`.
- Module version bumps to **2.0.0** (major).
- Downstream modules do not require IRI changes.

## Cross-module impact

| Downstream module | References | Impact of v2.0.0 |
|---|---|---|
| market-data | 16 | None (IRIs retained; DirectUnitPriceQuotationContract still valid) |
| market-rules | 6 | None |
| orders-execution | 7 | None |
| portfolio-positions | 17 | None |
| post-trade-operations | 10 | None |
| strategy-research | 8 | None |

## Sidecar fixes (non-breaking, accompany v2.0.0)

1. **CQ**: version → 2.0.0; CQ-I1 `Issuer`/`isIssuedBy` → `InstrumentIssuance`/`issuer`, conditionalized; CQ-I2 cross-module as-of join clarified; CQ-I3 `EquityInstrument` → `EquitySecurity`; IRI-form `dependsOnElements`.
2. **Terminology**: remove `Issuer`, `SecuritiesOffering`; add `InstrumentIssuance`, `DirectUnitPriceQuotationContract`; weaken Equity voting/dividend assertions.
3. **Alignment**: version → 2.0.0; CFI alignment sourceRelease → ISO 10962:2019 (FIBO-anchored Fourth edition), bibliographyRef → iso-10962-cfi.
4. **Gap doc**: Derivative/StructuredProduct/Warrant → "explicitly deferred"; classification → "v2.0.0 introduced."
5. **Traceability**: `Issuer + isIssuedBy` → `InstrumentIssuance + issuer`.
6. **M2-PLAN**: instruments scope row updated.

## References

- [ISO 10962:2019](https://www.iso.org/standard/72273.html) — CFI classification codes (6-layer, Fourth edition 2019-10, FIBO-anchored)
- [ISO 6166:2021](https://www.iso.org/standard/78502.html) — ISIN covers financial and referential instruments
- [MiFIR Article 27 (ESMA)](https://www.esma.europa.eu/) — "admitted to trading" (RMs) vs "traded on a trading venue" (MTFs/OTFs/SIs); instrument lifecycle end via Termination date (RTS 23 = Commission Delegated Regulation (EU) 2017/585, Annex Table 3)
- [CME Contract Specifications](https://www.cmegroup.com/) — futures quotation conventions (multiplier, unit, pricing)
- [Cboe Option Specifications](https://www.cboe.com/) — option quotation conventions
- [IFRS 9](https://www.ifrs.org/issued-standards/list-of-standards/ifrs-9-financial-instruments/) — classification depends on holder's business model
- [IFRS 13](https://www.ifrs.org/issued-standards/list-of-standards/ifrs-13-fair-value-measurement/) — fair value is a measurement fact
- [FIBO Financial Instruments](https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/) — instrument/issuance/listing separation
