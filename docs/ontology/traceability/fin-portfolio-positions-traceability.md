# fin-portfolio-positions Traceability Matrix

**Status**: review (v1.1.0)
**Date**: 2026-08-05
**Not a release sign-off**
**Related**: ADR-029, M2-REVIEW-ROUND-16

## v1.0.0 backbone (retained)

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO | Portfolio + Account | membership closure | CQ-PP1 | portfolio-v03-positive-portfolio | pySHACL smoke PASS |
| FIBO / ADR-012 | HoldingSnapshot | three-axis quantity fact | CQ-PP2 | portfolio-v03-positive-holding | pySHACL smoke PASS |
| M2 market-data | PositionValuation → price | usesPriceObservation XOR external basis | CQ-PP4 | portfolio-v03-positive-valuation-holding | pySHACL smoke PASS |
| FIBO | ManagementMandate | manager party required | CQ-PP1 | portfolio-v03-positive-management-mandate | pySHACL smoke PASS |
| ADR-012 | TemporalFact | mutable knowledge-end guard | CQ-PP2 | portfolio-v03-negative-position-mutable-knowledge-end | pySHACL smoke PASS |
| M2-PLAN | ExternalCostBasis | observation stream binding | CQ-PP6 | portfolio-v03-positive-external-cost-basis | semantic replay verified |

## v1.1.0 additions (generic core + profile layering, ADR-029)

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| ADR-029 D1 | Portfolio + portfolioIdentifyingAuthority | PortfolioContract (v2) | CQ-PP1, CQ-PP8 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D2 | PositionScope + BalanceDimension | PositionBalanceDimensionCardinality / HoldingSnapshotBalanceDimensionCardinality | CQ-S3, CQ-PP3 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D3 | ValuationMethodFamily + DirectUnitValuationProfile | ValuationCalculationDefinitionContract (v2) | CQ-S4, CQ-PP5 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D3 | PortfolioValuationSummary | PortfolioValuationSummaryContract | CQ-PP5 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D4 | PositionChange + PositionChangeKind | PositionChangeContract | CQ-PP6, CQ-PP9 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D4 | LotAdjustment + LotAdjustmentKind | LotAdjustmentContract | CQ-PP10 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D4 | LotRealization | LotRealizationContract | CQ-PP11 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D4 | PositionLot.lotSourceKind + derivedFromChange | PositionLotContract (v2) | CQ-PP6 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D5 | ReconciliationComparison + ReconciliationComparisonResult | ReconciliationComparisonContract | CQ-PP12, CQ-PP13 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D5 | ReconciliationResolution + ResolutionKind | ReconciliationResolutionContract | CQ-PP12 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D5 | ExternalCostBasisObservation.externalBasisMethod/MappingStatus | ExternalCostBasisObservationContract (v2) | CQ-PP13 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D6 | execution-and-reproducibility profile annotations | (document-scoped, no physical split) | — | — | document-scoped |
| ADR-029 D7 | PortfolioConstituent + Sleeve + PortfolioConstituentKind | PortfolioConstituentContract | CQ-PP14 | portfolio-positions-v11-positive | validate-m2-core PASS |
| ADR-029 D10 | FXConversion.rateSource/quoteTime/rateDate/rateFinality/crossRatePath | FXConversionContract (retained) | CQ-PP15 | portfolio-positions-v11-positive | validate-m2-core PASS |

## Regression gate results (2026-08-05, actual)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | PASS — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | PASS |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | PASS — 152 pass / 0 fail / 0 pending (80 CQs probed; PP8–PP15 wired) |
| PIT validation (new fixtures) | `node scripts/domain/validate-pit.cjs` (positive + negative) | PASS — 14 positive / 7 negative |
| OWL regeneration | `generate-m2-owl.cjs` (portfolio-positions) | PASS — 0 projection warnings |
| SHACL regeneration | `generate-m2-shacl.cjs` (portfolio-positions) | PASS — 0 projection warnings |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: full SPARQL evaluation of CQ-PP8..PP15 query patterns (staged counts are reported by the honesty probes; SPARQL evaluation requires a pinned engine). The generic fixture-to-TTL converter skips object-valued quantity fields, so full SHACL enforcement of new association types via the generic converter is pending; structural/cardinality enforcement is verified by validate-m2-core --strict.
