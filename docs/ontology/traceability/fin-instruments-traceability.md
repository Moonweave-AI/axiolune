# fin-instruments Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO / IAS 32 | FinancialInstrument | instrument identity contract | CQ-I1 | instrument-inheritance | `test-all-domain` PASS |
| FIBO | InstrumentListing | listing ≠ instrument | CQ-I2 | instrument-listing-quote-currency | `validate-pit` PASS |
| ISO 10962 | EquitySecurity | CFI equity classification | CQ-I3 | positive-market-instrument-contract | semantic replay verified |
| FIBO | Issuer + isIssuedBy | issuer relationship integrity | CQ-I1 | slice-a/cq-v03/foundation-market-instrument-graph | semantic replay verified |
| M2-PLAN | SecuritiesOffering | offering distinct from listing | CQ-I2 | instrument-listing-quote-currency-negative | `validate-pit` PASS |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: multi-listing instrument resolution probes.
