# PriceKind ↔ FIBO SecurityPrice alignment (draft)

**Status**: draft  
**Evidence**: `reference/ontology-design-reference/fibo/FBC/FinancialInstruments/InstrumentPricing.rdf`  
**Lock**: `docs/ontology/references/references.lock.yaml` → `fibo-local-evidence`

| Axiolune | Relation | FIBO | Notes |
|----------|----------|------|-------|
| `PriceObservation` | rdfs:subClassOf (proposed) | `SecurityPrice` | Price is a temporal fact about a Security/listing context, not Instrument.currentPrice |
| `hasPriceValue` + `MonetaryAmount` | maps amount | SecurityPrice monetary facets | Prefer structured Money over bare decimal |
| `hasPriceKind` (Last/Bid/Ask/…) | closeMatch / specialized | SecurityPrice kinds / quote facets | Need controlled mapping table per venue feed |
| `observedInstrument` / listing role | related | `isPriceFor` Security | Round-2: Listing≠Instrument; Listing→Offering via `listsOffering` |

Open: ticker reassignment validity intervals; Offering vs Listing participant completeness.
