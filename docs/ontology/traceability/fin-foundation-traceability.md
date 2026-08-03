# fin-foundation Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| ISO 6166 / FIBO | ISIN + IdentifierScheme | checksum + scheme binding | CQ-F1 | foundation-duplicate-isin-negative | `validate-pit` PASS; semantic replay verified |
| GLEIF / FIBO | LEI + LegalEntity | entity identifier pattern | CQ-F1 | foundation-account-identity-positive | `test-all-domain` PASS |
| ISO 10383 | MIC + TradingVenue | venue identifier resolution | CQ-F3 | foundation-market-rules-contract | `validate-pit` PASS |
| FIBO | Currency + Jurisdiction | ISO 4217 eligibility | CQ-F2 | foundation-market-instrument-positive | semantic replay verified |
| M2-PLAN | IdentifierAssignment | uniqueness scope per scheme | CQ-F4 | foundation-duplicate-isin-negative | `validate-pit` PASS |
| ADR-012 | TemporalFact + availableFrom | fail-closed availability | CQ-F4 | foundation-account-identity-negative | pySHACL smoke (foundation shapes) |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ probe SPARQL results for cross-module identity joins.
