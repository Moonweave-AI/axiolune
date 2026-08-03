# Slice A Traceability Matrix (v1.0.0)

**Status**: review v1.0.0 — proves linkage skeleton for Instrument → Price → Holding → Valuation  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| ISO 6166 / FIBO | ISIN + FinancialInstrument | identifier pattern | CQ-S1 | slice-a-source-contract instruments | `test-all-domain` presence + PIT suite |
| M2 market-data | PriceObservation + TemporalFact | three-axis + availableFrom | CQ-S2 | market-data-positive/negative | `validate-pit` PASS (machine) |
| M2 portfolio | HoldingSnapshot | three-axis | CQ-S3 | portfolio-positions-* | `validate-pit` PASS (machine) |
| M2 portfolio | PositionValuation → price | usesPriceObservation | CQ-S4 | portfolio + slice-a mapping | semantic replay verified via `run-slice-a.cjs` |
| ADR-011/012 | MaterializationRun + PITValidationRequest | replay digests | CQ-S5 | slice-a-materialization-run | semantic replay verified via `run-slice-a.cjs` |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ probe SPARQL results, promotion ledger digests, OWL DL consistency.
