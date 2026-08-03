# fin-portfolio-positions Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO | Portfolio + Account | membership closure | CQ-PP1 | portfolio-v03-positive-portfolio | pySHACL smoke PASS |
| FIBO / ADR-012 | HoldingSnapshot | three-axis quantity fact | CQ-S3 | portfolio-v03-positive-holding | pySHACL smoke PASS |
| M2 market-data | PositionValuation → price | usesPriceObservation XOR external basis | CQ-S4 | portfolio-v03-positive-valuation-holding | pySHACL smoke PASS |
| FIBO | ManagementMandate | manager party required | CQ-PP5 | portfolio-v03-positive-management-mandate | pySHACL smoke PASS |
| ADR-012 | TemporalFact | mutable knowledge-end guard | CQ-PP2 | portfolio-v03-negative-position-mutable-knowledge-end | pySHACL smoke PASS |
| M2-PLAN | ExternalCostBasis | observation stream binding | CQ-PP6 | portfolio-v03-positive-external-cost-basis | semantic replay verified |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ-PP7 multi-portfolio aggregation probes.
