# fin-post-trade-operations Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO / Lean | CorporateActionEvent | entitlement + three-axis | CQ-PTO1 | post-trade-closure-reconciliation-positive | `test-all-domain` PASS |
| BIAN | ReconciliationBreak | bilateral evidence required | CQ-PTO2 | post-trade-closure-reconciliation-negative | `validate-pit` PASS |
| FIBO Settlement | SettlementInstruction | execution linkage | CQ-PTO3 | post-trade-cq/graph.yaml | semantic replay verified |
| ISO 15022 | tender/spin-off/exchange kinds | exotic CA taxonomy (v1.0.0 CQs) | CQ-PTO4 | post-trade-typed-envelope-overlay | semantic replay verified |
| M2-PLAN | ExternalStatementLine | statement-side evidence | CQ-PTO2 | post-trade-non-record-classifications | `validate-pit` PASS |
| ADR-016 | deferred exotic CAs | availableFrom guard on holdings | CQ-PTO5 | post-trade-cq/pit-ledger.json | semantic replay verified |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: multi-event corporate action chain probes.
