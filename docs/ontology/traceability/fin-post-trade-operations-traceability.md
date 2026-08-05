# fin-post-trade-operations Traceability Matrix

**Status**: review (v1.1.0 additive revision per ADR-030; v1.0.0 Round-12 acceptance contract stands)
**Date**: 2026-08-05 (v1.1.0), 2026-08-03 (v1.0.0)
**Not a release sign-off** — SME sign-off on RFC-006 Q1–Q13 outstanding; physical runtime-profile split (ADR-031) deferred.

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO / Lean | CorporateActionEvent | entitlement + three-axis | CQ-PTO1 | post-trade-closure-reconciliation-positive | `test-all-domain` PASS |
| BIAN | ReconciliationFinding | bilateral evidence required | CQ-PTO2 | post-trade-closure-reconciliation-negative | `validate-pit` PASS |
| FIBO Settlement | SettlementInstruction | execution linkage | CQ-PTO3 | post-trade-cq/graph.yaml | semantic replay verified |
| ISO 15022 | tender/spin-off/exchange kinds | exotic CA taxonomy (v1.0.0 CQs) | CQ-PTO6/7/8 | post-trade-typed-envelope-overlay | semantic replay verified |
| M2-PLAN | ExternalSettlementStatementLine | statement-side evidence | CQ-PTO2 | post-trade-non-record-classifications | `validate-pit` PASS |
| ADR-019 | deferred exotic CAs | availableFrom guard on holdings | CQ-PTO5 | post-trade-cq/pit-ledger.json | semantic replay verified |
| BIS/CPMI-IOSCO PFMI | SettlementFinalityEvent / SimpleDvpFopSettlementProfile | finality vs settled; DvP/DvD/PvP boundary | CQ-PTO11, CQ-PTO13 | post-trade-v11-additive | `run-all-cq-probes` PASS (staged) |
| ISO 15022 MT548/564/565/566/567 | SettlementStatus breadth / CorporateActionOption lifecycle | status lifecycle; option lifecycle | CQ-PTO12, CQ-PTO16 | post-trade-v11-additive | `run-all-cq-probes` PASS (staged) |
| DTCC / SEC T+1 | confirmation/affirmation/clearing/netting hooks | out-of-scope boundary | CQ-PTO3 (hooks) | post-trade-v11-additive | `run-all-cq-probes` PASS (staged) |
| ADR-030 D5 | ReconciliationMatchGroup | multi-cardinality matching | CQ-PTO14 | post-trade-v11-additive | `run-all-cq-probes` PASS (staged) |
| ADR-030 D6 | MissingSideAssertion / IncompleteSourceCoverageAssertion | one-sided absence vs unknown coverage | CQ-PTO15 | post-trade-v11-additive (+ negative) | `run-all-cq-probes` PASS (staged) |
| ADR-030 D9 | SettlementLegAllocation | cash/fee/tax economic allocation | CQ-PTO17 | post-trade-v11-additive (+ negative) | `run-all-cq-probes` PASS (staged) |
| ADR-030 D10 P1-c | CustodySettlementAccountBridge chain | multi-hop custody | CQ-PTO18 | post-trade-v11-additive | `run-all-cq-probes` PASS (staged) |
| ADR-030 D10 P1-d | ExternalSettlementStatement shape | multi-day + correction/reversal | CQ-PTO19 | post-trade-v11-additive | `run-all-cq-probes` PASS (staged) |
| ADR-030 D10 P1-f | ReconciliationDisposition | finding-level disposition | CQ-PTO14 | post-trade-v11-additive (+ negative) | `run-all-cq-probes` PASS (staged) |

## v1.1.0 regression gate (actual, 2026-08-05, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 170 pass / 0 fail / 0 pending (89 CQs probed; PTO11–19 wired) |
| PIT validation | `node scripts/domain/validate-pit.cjs mappings/finance/synthetic/post-trade-pit-validation-request.yaml` | **PASS** — 0/0 |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (post-trade) | **PASS** — 0 projection warnings |

v1.1.0 staging fixtures (`tests/m2/fixtures/positive/post-trade-v11-additive.yaml` and `tests/m2/fixtures/negative/post-trade-v11-additive-negative.yaml`) wire the new types into the CQ probes; the probes report staged counts. Full SHACL enforcement of the new association types via the generic fixture-to-TTL converter remains pending (the converter skips object-valued quantity fields); structural/cardinality enforcement is verified by `validate-m2-core --strict` and the generated SHACL. Multi-event corporate action chain probes against a pinned SPARQL/SHACL engine over staging graphs remain unverified.
