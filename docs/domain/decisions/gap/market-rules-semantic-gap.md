# Market Rules Semantic Gap

**Module**: fin-market-rules  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Captures versioned trading, settlement, and admission rules with applicability scope and evidence - not static venue attributes.
- Non-goal: encoding rule calculation engines or implicit "current rule" without revision axis.

## Track B (reference/ alignment)

- FIBO FBC regulatory rule patterns and exchange rule bulletins inform RuleApplicability and evidence locators.
- Lean / RQAlpha market rule hooks inform ordering only, not canonical rule types.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| MR-G1 | weak-cq | P1 | CQ-MR1-MR3 draft | **Closed** - 3 active CQs; availability negatives |
| MR-G2 | broken-boundary | P1 | Expired rule interval vs query | **Closed** - CQ-MR2-neg interval rejection |
| MR-G3 | shallow-definition | P2 | Admission vs trading rule distinction | **Closed** (v1.0.0) — terminology polish in M1 |
| MR-G4 | orphan-type | P2 | RuleRevision without dedicated CQ | **Closed** - CQ-MR3 revision query + NoFutureKnowledge neg |
| MR-G5 | mapping-gap | P2 | Bulletin to RuleApplicability slice | **Closed** (v1.0.0) — [MR-G5 mapping narrative](../../planning/mapping-narratives/MR-G5-rule-bulletin-to-applicability.md) + bulletin YAML |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Rule identity + applicability scope keys |
| 2 | pass | Evidence locators on rule applications |
| 3 | pass | Trading/settlement/admission kinds defined |
| 4 | pass | Availability + interval negatives |
| 5 | pass | Three-axis temporal facts on applications |
| 6 | pass | Three active CQs with narratable negatives |
| 7 | pass | FIBO + exchange bulletin references |
| 8 | pass | rule-app positive/negative fixtures staged |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)

## Round-13 (2026-08-04) — executable-ontology architecture gaps

The Round-12 "closed" status applies to the [RFC-001](../../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract only. [M2-REVIEW-ROUND-13](../M2-REVIEW-ROUND-13.md) assessed the stronger claim of a *general, executable* Market Rules ontology and found six P0 architecture gaps plus six P1 corrections, all verified against `module.yaml` and [M2-PLAN §5.2/§5.3](../../planning/M2-PLAN.md). These rows supersede the closed status for the executable-ontology claim; resolution is [ADR-023](../ADR-023-market-rules-architecture.md) (Accepted, v1.1.0 in-place revision) via [RFC-002](../../planning/RFC-002-market-rules-architecture.md).

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| MR-A1 | missing-semantics | P0 | Price limits uncomputable: `PriceLimitClause` has percentage/amount only; reference-price method named but not modeled | **Closed (v1.1.0)** — ADR-023 D3: `ReferencePriceSpecification` + `priceLimitReferencePrice` relation + `PriceBandSide` + `PriceLimitReferencePriceBinding` constraint |
| MR-A2 | missing-semantics | P0 | Circuit breaker values only: no monitor/direction/window/tiering/resume/propagation | **Closed (v1.1.0)** — ADR-023 D4: `circuitBreakerMonitor`/`direction`/`tier`/`triggerCount`/`resumeMechanism` attributes + `CircuitBreakerEffectCompleteness` constraint |
| MR-A3 | missing-semantics | P0 | Rule selection models no-winner only; no ResolvedSelection/NoApplicableRule | **Closed (v1.1.0)** — ADR-023 D1: `RuleSelectionOutcome` hierarchy + `ResolvedSelection`/`NoApplicableRule`/`UnsupportedSelection`/`IndeterminateSelection`; `RuleConflict` aligned by value; `RuleSelectionOutcomeIntegrity` constraint |
| MR-A4 | weak-identity | P0 | Precedence binds rules not applicability; clause has no unique-owner relation; no logical identity for Set/Rule/Clause/Parameter/Method | **Closed (v1.1.0)** — ADR-023 D5: `clauseOwnerRule` functional relation + `ClauseOwnerUniqueness` constraint; logical identity via existing authority-scoped identifiers retained |
| MR-A5 | shallow-definition | P0 | RuleClause over-generalizes sequence/inclusivity; tick/lot/duration/business-day/percentage use generic QuantityValue | **Closed (v1.1.0)** — ADR-023 D2: `RangeClause`/`TriggerClause` families; inclusivity fields relaxed to optional on `RuleClause`; `RangeClauseGapPolicyApplicability` constraint scopes gap policy to range clauses |
| MR-A6 | broken-boundary | P0 | Calendar/session/cutoff stored as SHA-256 digests while importable TradingCalendar/TradingSession* exist | **Closed (v1.1.0)** — ADR-023 D6: `settlementCycleCalendar`/`scheduleCalendar` relations to `market-structure` `TradingCalendar`; digests retained as audit evidence |
| MR-A7 | design-drift | P1 | RuleApplicability scope missing session/phase/instrument-class/investor-category/order-type; plan requires InstrumentClass/InvestorCategory, module rejects them | **Closed (v1.1.0)** — ADR-023 D7: `ScopeExpression`/`ScopeTerm` + `scopeTradingSession`/`scopeTradingPhase`/`scopeInstrumentClassification` roles + `applicabilityInvestorCategory`/`orderType`/`orderSide`/`marketModel` attributes; `RuleApplicabilityRequiresExplicitScope` v2 admits them |
| MR-A8 | naming-honesty | P1 | rightsIssue labeled "Rights issue" but restricted to non-transferable direct subscription | **Deferred to SME (RFC-002 Q4)** — transferable-rights profile boundary remains open; non-transferable direct subscription retained as-is pending SME |
| MR-A9 | shallow-definition | P1 | RuleType breadth insufficient for generic "Market Rules" label | **Deferred to SME (RFC-002 Q5)** — module definition broadened to name selection semantics; new RuleType values deferred pending SME |
| MR-A10 | weak-constraint | P1 | RuleParameter has no role; parameterClauseReference has no cycle/self-reference guard | **Closed (v1.1.0)** — ADR-023 D11: `RuleParameterRoleBinding` constraint adds acyclicity + non-self-reference guard; `RuleParameter` retained (additive) rather than removed |
| MR-A11 | missing-semantics | P1 | "sole evidence" too strong; no RulePublication/NormativeSource/precedenceBasis; no structured RuleExpression | **Closed (v1.1.0)** — ADR-023 D10: `NormativeSource` + `normativeSourceForRule`/`normativeSourceForRuleSet` relations + `NormativeSourceRole` code list; `PrecedenceBasis` code list added |
| MR-A12 | design-drift | P1 | Corporate-action profile not isolated from core rule model | **Deferred to follow-up ADR** — profile split deferred per RFC-002 Option C; corporate-action semantics retained in single module with documented boundary |

Round-13 P0 status: **closed (v1.1.0)** — MR-A1…A7, A10, A11 implemented and regression-verified. P1 deferred: MR-A8/A9 gated on SME (RFC-002 Q4/Q5); MR-A12 gated on the profile-split follow-up ADR. Regression (2026-08-04): `validate-m2-core --all --strict` 10 modules 0 errors; `run-domain-shacl` pySHACL PASS; `run-all-cq-probes` 122/0/0 (61 CQs); all 10 modules OWL/SHACL regenerated cleanly.
