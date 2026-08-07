# ADR-022: Market Data Architecture (v2.0.0)

**Status**: Accepted  
**Date**: 2026-08-04  
**Context**: Independent read-only review of `fin-market-data` v1.0.0 (2026-08-04)  
**Related**: ADR-014, ADR-017, ADR-020 (foundation), ADR-021 (instruments), M2-PLAN §5.2, M3 ADR-011 (SemanticMappingDefinition single truth source)

## Context

An independent semantic review of `fin-market-data` v1.0.0 concluded: **retain the module, require architectural revision (Request changes)**. The review cross-checked the module against ISO 10383, FIX Protocol, MiFIR Article 2, ESMA reference data, ECB FX reference rates, FIBO, W3C PROV-O, IFRS 13, and Nautilus/Lean/Qlib references, and identified eight P0 issues.

The module's core design — Price/Quote/Trade/Bar/FX/QualityFinding as separate temporal facts, MarketDataStream as source boundary, three-axis PIT — is sound. The problems are: (1) physical data-mapping fields intrude into Layer 4's domain; (2) all prices are locked to DirectUnitPrice; (3) QuoteObservation is named too broadly for what it models (complete paired L1 snapshot); (4) observation identity lacks session/channel/update-action; (5) Bar thresholds are dimensionally incorrect; (6) FX lacks rate kind and value date; (7) three-axis PIT and market-event time are conflated; (8) streamPurpose lacks mandatory type mapping.

## Decisions

### D1. Layer 4 boundary — MarketDataStream physical mapping fields deprecated

**Problem**: MarketDataStream directly carries sourceApiIdentifier, sourceSchemaIdentifier, sourceSchemaVersion, observationIdFieldLocator, sourceRevisionFieldLocator, orderingTransformRef, orderingTransformDigest, sourceContractRef, sourceContractDigest. M3 ADR-011 declares SemanticMappingDefinition as the ONLY truth source for physical-to-semantic mapping, and only Layer 4 may reference physical data structures.

**Decision**: The physical-mapping attributes on MarketDataStream are **retained** (no IRI removed) but marked `deprecated: true`, `deprecatedSince: 2.0.0`, `replacedBy: SemanticMappingDefinition` (Layer 4). MarketDataStream retains its domain-semantic role: provider, stream purpose, revision policy, and provenance. The physical field-locators, schema versions, and transform digests are documented as belonging to SemanticMappingDefinition / SourceBinding / TransformationDefinition in Layer 4. Downstream modules and future M1 materialization should reference these via Layer 4, not via MarketDataStream.

### D2. QuotationConvention — abstract quotation layer (joint with ADR-021)

**Problem**: PriceObservation, QuoteObservation, TradeObservation, TradeBar, QuoteBar all require `quotationContract` pointing to DirectUnitPriceQuotationContract with multiplier=1. Bond percent-of-par, clean/dirty, yield, spread, futures index points, and inverse FX cannot be expressed. FIX PriceType explicitly covers per-unit, percent-of-par, yield, spread, and basis points.

**Decision**: The `quotationContract` participant role's range is **broadened** from `DirectUnitPriceQuotationContract` to `QuotationConvention` (the abstract parent introduced in ADR-021 D1). DirectUnitPriceQuotationContract remains a valid QuotationConvention subtype, so all existing data and downstream references continue to work. Future quotation profiles (yield, par, notional-scaled, index-point) can be added in instruments or a future quotation module without changing market-data. The existing constraint `ObservationContextQuotationContract` is **retained** but its expression is generalized: the `quotationKind = directUnitPrice and contractMultiplier = 1` sub-expression applies only when the quotationContract is a DirectUnitPriceQuotationContract, not as a universal rule.

### D3. QuoteObservation scope — explicitly L1 paired snapshot

**Problem**: QuoteObservation requires bid price, bid size, ask price, ask size ALL present. But the CQ and terminology card write "at least one side." Real feeds have single-side updates, empty books, depth, auction indications, and non-firm quotes. FIX Market Data Incremental Refresh carries multiple entry types.

**Decision**: QuoteObservation is **retained with its current IRI** but explicitly scoped as a **complete paired top-of-book (L1) snapshot**. Its name in documentation and terminology is clarified. Single-side updates, order-book depth, auction indications, and non-firm quotes are **deferred** to future quote profiles (e.g., QuoteSideUpdate, OrderBookSnapshot). The CQ-MD4 is corrected to require both sides (matching the model), not "at least one." The existing four-field constraint (QuoteObservationContract) is **retained**.

### D4. Observation identity — session, channel, update action

**Problem**: The logical key is `(stream, providerObservationId|sourceTradeId)`. Exchange IDs often partition by trading day, session, or channel. The revision chain cannot express New/Change/Delete, trade breaks, cancels, or snapshot resets. Nasdaq ITCH broken trades reference original match numbers.

**Decision**: New optional attributes are **added** (additive, no existing key changed): `sourceSessionId`, `sourceChannelId`, `updateAction` (New/Change/Delete/Correct), `correctsRef` (reference to the observation being corrected). The existing logical key is **retained**. The new attributes enrich the identity and update lifecycle without breaking existing data. A new `UpdateAction` code list is introduced.

### D5. Bar threshold — strongly typed variants

**Problem**: barThreshold is a QuantityValue for tick, volume, notional, range, and renko. Only volume naturally fits QuantityValue; notional should be MonetaryAmount; range/renko should be a price difference; tick is a count.

**Decision**: A new `BarThresholdKind` code list is introduced (eventCount / volume / notional / priceRange / renkoBrick). The existing `barThreshold` attribute is **retained** (QuantityValue) but its applicability is clarified: it serves volume and renko thresholds. For notional, a new `barThresholdNotional` attribute (MonetaryAmount) is added. For price range, a new `barThresholdPriceRange` (MonetaryAmount) is added. For event count, a new `barThresholdEventCount` (integer) is added. The BarSpecificationContract constraint is updated to enforce the correct threshold type per BarThresholdKind.

### D6. FX rate semantics — convention, kind, value date

**Problem**: FXRateObservation models the base/quote equation correctly but lacks rate kind (spot/forward/NDF), value date, tenor, fixing/reference, precision, and market pair identity. It forces listing or OTC context, but ECB reference rates are non-tradable public reference values. It is consumed directly by Portfolio for valuation.

**Decision**: New optional attributes are **added**: `fxRateConvention` (spot/forward/NDF/swaption → new code list), `fxRateKind` (tradeable/reference/fixing/benchmark → new code list), `fxValueDate` (date). The existing base/quote Currency roles and listing/OTC XOR are **retained** but the XOR is relaxed: a new optional `fxReferenceContext` allows FX rate observations without a listing or OTC context (e.g., ECB reference rates). The FXRateObservationContract is **retained** and extended.

### D7. Three-axis PIT vs market-event time

**Problem**: CQ-MD2 orders by validFrom but the model orders by observedAt + sourceOrderKey. Bar intervals are not aligned with TemporalFact valid intervals. The three-axis PIT (validFrom/knowledgeFrom/availableFrom) is conflated with the market event clock (execution, order-book entry, publication, dissemination).

**Decision**: The three-axis PIT model is **retained** as the platform's reproducibility/replay mechanism. A new optional `marketEventAt` attribute (instant) is **added** to observations to carry the source-declared market event timestamp (execution time, quote time), distinct from the TemporalFact validFrom (business validity). The existing `observedAt` (from TemporalObservation pattern) is clarified as the source-declared observation timestamp, which may equal marketEventAt for trade observations. The three-axis PIT constraint is **retained**. The relationship between observedAt, marketEventAt, validFrom, and the three axes is documented but not over-constrained: observedAt and marketEventAt are source-declared; validFrom/knowledgeFrom/availableFrom are platform-assigned per TemporalFact.

### D8. streamPurpose — mandatory type mapping

**Problem**: streamPurpose declares that a stream "admits only one record type" but there is no constraint enforcing QuoteObservation → quoteObservation stream, TradeBar → tradeBar stream, etc. A Quote could theoretically hang on a trade stream. FIX incremental messages can carry quote, trade, status, and statistics entries.

**Decision**: A new `StreamPurposeCompatibilityContract` constraint is introduced, enforcing that the observation/bar type matches the stream's declared purpose. The existing streamPurpose code list and observation types are **retained**. For multi-type feeds (where one physical stream carries multiple record types), the recommended pattern is to define separate MarketDataStream instances per normalized record type, each with its own streamPurpose, linked via Layer 4 SemanticMappingDefinition to the same raw feed.

## Compatibility strategy

- All existing market-data IRIs are **retained**.
- New attributes are optional (minCount 0) so existing data continues to work.
- quotationContract range broadened from DirectUnitPriceQuotationContract to QuotationConvention (supertype).
- Module version bumps to **2.0.0** (major).
- Downstream modules (5 references) do not require IRI changes.
- Deprecated physical-mapping fields on MarketDataStream are retained with deprecation markers.

## Cross-module impact

| Downstream module | References | Impact |
|---|---|---|
| portfolio-positions | 2 | None (IRIs retained) |
| post-trade-operations | 2 | None |
| risk | 1 | None |

## Sidecar fixes

1. **CQ**: version → 2.0.0; MD4 → both sides required; MD5 → TradeBar/QuoteBar; MD2 → observedAt ordering; IRI-form dependsOnElements.
2. **Terminology**: remove `Bar` orphan; fix PriceKind Bid/Ask; add MarketDataStream/BarSpecification/TradeBar/QuoteBar/FXRateObservation/MarketDataQualityFinding.
3. **Alignment**: version → 2.0.0; fix FIX::Quote non-canonical IRI; weaken TradeObservation ↔ FIBO Trade.
4. **Traceability**: fix partial quote; add Stream/revision/FX/quality; version → 2.0.0.
5. **Gap doc**: fix observation identity; fix partial quote closed; add v2.0.0 gaps.
6. **FX mapping narrative**: FxRateObservation → FXRateObservation; remove hasPriceValue.
7. **M2-PLAN**: scope row updated.

## References

- [FIX Protocol — Market Data Incremental Refresh](https://www.fixtrading.org/) — multi-type feed entries
- [FIX PriceType](https://www.fixtrading.org/) — per-unit, percent-of-par, yield, spread
- [ISO 10383](https://www.iso.org/standard/62067.html) — listing vs execution vs reporting facility
- [MiFIR Article 2](https://eur-lex.europa.eu/) — market data time distinctions
- [ECB FX Reference Rates](https://www.ecb.europa.eu/) — non-tradable reference values
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) — activity-input-output derivation chain
- [IFRS 13](https://www.ifrs.org/) — fair value as measurement fact, not recent close
- [M3 Layer 4 data binding](../../../ontology/meta/data-binding-meta-model.yaml) — SemanticMappingDefinition single truth source
