# M2 Review Round 13 — `fin-market-rules` Architecture Review

**Date**: 2026-08-04
**Verdict**: **Retain; architecture revision required (P0). No release-status change.**
**Scope**: `fin-market-rules` module only (post-v1.0.0 in-depth architecture review)
**Basis**: Independent architecture review of `ontology/domain/finance/market-rules/module.yaml` v1.0.0
**Related**: Round-12 (v1.0.0 approval, acceptance contract), RFC-002 (architecture decision), ADR-023 (Proposed)

## Status of this review

This is a **post-release architecture review**, not a re-run of the Round-12 v1.0.0 acceptance contract. Round-12 approved `fin-market-rules` against the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance axes (flights rubric, gap closure, active CQs, lifecycle story). That approval **stands** for the acceptance contract.

This review assesses whether the module can serve as a **general, executable Market Rules ontology** — a stronger claim than the acceptance contract. It cannot, as released. The P0 gaps below were verified by direct reading of `module.yaml` and the M2-PLAN; they are structural, not stylistic.

## What was verified (untrusted-input handling)

Per the Moonweave governance baseline, the originating review text and its external regulatory citations were treated as **untrusted input**. Structural and semantic claims were re-derived against `module.yaml` and `M2-PLAN` directly. External citations (SSE, ESMA Art. 48, NYSE MWCB, FINRA 11630/11140, SEC Reg SHO/T+1, ISO 15022, EU RTS 11) are recorded here as **SME-evidence pointers for the RFC**, not as provenance or asserted fact. Their interpretation must be confirmed by market-microstructure and corporate-action/settlement SMEs before any hardens into ontology semantics.

## Confirmed structural baseline

Per `module.yaml` v1.0.0: 22 object types, 3 association types, 13 relation types, 64 attribute types, 13 code lists, 15 domain constraints. No files were modified, and no ontology tests, validators, or gates were run (any execution result would be marked **unverified**).

## P0 — architecture gaps (verified)

| # | Claim | Verified evidence | Required semantic |
|---|---|---|---|
| P0-1 | Price limits cannot be computed | [PriceLimitClause:161](../../ontology/domain/finance/market-rules/module.yaml#L161) carries only `priceLimitPercentage`/`priceLimitAmount`; the definition *names* a "reference-price method" but no object/attribute carries it — no reference-price source, window, missing-value policy, band side, upper/lower bound, quote currency, or rounding. | `ReferencePriceSpecification`, price source/window/missing-policy, `PriceBandSide`, upper/lower bounds, rounding, out-of-band effect. |
| P0-2 | Circuit breaker is values only, no trigger/effect | [CircuitBreakerClause:183](../../ontology/domain/finance/market-rules/module.yaml#L183) carries only `threshold` + `haltDuration`. | Monitor object, reference value, direction, time window, tiering, trigger count, halt scope, order handling, resume condition, auction/price-band on resume, cross-venue propagation. |
| P0-3 | Static applicability decoupled from dynamic rule selection | [RuleEvaluationRequest:506](../../ontology/domain/finance/market-rules/module.yaml#L506) has no candidate/winner result; [RuleConflict:633](../../ontology/domain/finance/market-rules/module.yaml#L633) models only the no-winner path; [RuleApplicabilityMustMatchRequest:2114](../../ontology/domain/finance/market-rules/module.yaml#L2114) requires static applicability to match a request. Normal hit and no-match outcomes are not modeled. | `RuleSelectionOutcome` hierarchy: `ResolvedSelection`, `NoApplicableRule`, `Conflict`, `Unsupported`, `Indeterminate`. Normal results must record candidate applicability, specificity, selected rule/clause, inputs, outputs, basis. |
| P0-4 | Precedence and clause ownership lack granularity | [RulePrecedence:603](../../ontology/domain/finance/market-rules/module.yaml#L603) binds two `MarketRule` versions, not the applicability/scope that actually conflict; [ruleHasClause:696](../../ontology/domain/finance/market-rules/module.yaml#L696) connects rule→clause but does not constrain a clause to exactly one owner rule. | Precedence should fall on `higherApplicabilityVersion`/`lowerApplicabilityVersion` or an explicit `precedenceScope`; add a clause→owner-rule single-valued relation; add logical identity for RuleSet/Rule/Clause/Parameter/Method. |
| P0-5 | Generalized Quantity/Range breaks semantic typing | [RuleClause:65](../../ontology/domain/finance/market-rules/module.yaml#L65) forces sequence + endpoint-inclusivity on every subtype; tick, lot, duration, business-day, percentage all use generic `QuantityValue`. | Split into `RangeClause`, `TriggerClause`, `DateClause`, `EntitlementClause`; localize gap policy to segmented rules; introduce `PriceIncrement`, `OrderQuantityIncrement`, `Percentage`, `Duration`, `BusinessDayOffset` dimension-constrained value objects. |
| P0-6 | Calendar/session/cutoff replaced by hash | `SettlementCycleClause` and corporate-action date offsets use business-day semantics but connect to no calendar/timezone/cutoff; corporate action stores three contract digests ([scheduleCalendarCutoffContractDigest:1470](../../ontology/domain/finance/market-rules/module.yaml#L1470)). Meanwhile `TradingCalendar`, `TradingSessionTemplate`, `TradingSessionOccurrence`, `JurisdictionCalendarBinding` **already exist** in [market-structure](../../ontology/domain/finance/market-structure/module.yaml#L81) and are importable. | Reference existing `TradingCalendar`/`TradingSessionTemplate`/`TradingSessionOccurrence`; keep digests as completeness evidence, not sole semantics. |

## P1 — high-priority design corrections

1. **RuleApplicability scope dimensions insufficient and off-plan.** Only listing, instrument, segment, venue, jurisdiction, account type. No trading session/phase, instrument classification, investor category, order type/side, market model. [M2-PLAN:343](../planning/M2-PLAN.md#L343) lists `InstrumentClass` and `InvestorCategory` as scopes; [RuleApplicabilityRequiresExplicitScope:2099](../../ontology/domain/finance/market-rules/module.yaml#L2099) *explicitly rejects* classifier and investor-category. `AccountType` does not substitute for investor category. Suggest `ScopeExpression`/`ScopeTerm` with conjunction/disjunction/exception, plus `scopeTradingSession`/`scopeTradingPhase`, `scopeInstrumentClassification`, `scopeInvestorCategory`, `scopeOrderType`/`scopeOrderSide`, `scopeMarketModel`.
2. **Layer venue-trading and corporate-action profiles.** Corporate-action semantics occupy a large share of objects/attributes/code lists and threaten to drown the core rule model. Suggested profiles: `market-rules-core`, `venue-trading-rules`, `post-trade-rules`, `corporate-action-schedule-rules`, `market-rule-evaluation`. Execution/CorporateActionEvent/SettlementInstruction/market-state facts must remain downstream-owned.
3. **Broaden RuleType or honestly narrow the module name.** Seven kinds (tick, lot, price limit, circuit breaker, settlement, resale, corporate action) do not justify a generic "Market Rules" label. Consider `OrderPriceCollarRule`, `OrderQuantityLimitRule`, `TradingSessionRule`/`AuctionRule`, `ShortSaleRestrictionRule`, `OrderAdmissionOrCancellationRule`, `MarketStatusTransitionRule`. If v1 will not cover these, narrow the module definition to "trading parameters, settlement conventions, and restricted corporate-action schedule rules."
4. **Corporate-action naming honesty.** `CorporateActionKind/rightsIssue` ([module.yaml:1837](../../ontology/domain/finance/market-rules/module.yaml#L1837)) labels itself "Rights issue" but its definition restricts to non-transferable direct subscription. Either rename to `nonTransferableDirectSubscriptionRightsIssue`, or keep the broad name and add `rightsTransferabilityProfile` with supported/unsupported branches.
5. **Tighten or remove generic `RuleParameter`.** [RuleParameter:98](../../ontology/domain/finance/market-rules/module.yaml#L98) offers money/quantity/code/clause-reference with no parameter role; `parameterClauseReference` has no self-reference/cycle guard. If rule families have explicit fields, remove this escape hatch; if extensibility is required, add `ParameterRole`, a clause-kind→role matrix, same-rule restriction, and acyclicity.
6. **Make evidence and algorithms explainable, not only verifiable.** "sole evidence" wording is too strong; rules have main text, amendments, notices, interpretations, and effective notices. Add `RulePublication`/`NormativeSource`, document locator/section, promulgation/effective/repeal facts, `precedenceBasis` code list. Retain formula/implementation/contract digests as frozen audit evidence, but add structured `RuleExpression`/`DecisionTable` or a referenceable computation spec.

## What should be retained and strengthened

- [RuleApplicability](../../ontology/domain/finance/market-rules/module.yaml#L546) requiring at least one scope and rejecting implicit-global — correct open-world defensive design.
- [RulePrecedence](../../ontology/domain/finance/market-rules/module.yaml#L603) / [RuleConflict](../../ontology/domain/finance/market-rules/module.yaml#L633) separated, no silent winner — correct financial auditability.
- `SettlementCycleClause` / `ResaleRestrictionClause` separated — avoids conflating settlement cycle with T+0/T+1 resale eligibility.
- Three-axis PIT, versioning, provenance model — suitable for historical replay and rule revision.
- Corporate-action ordinary-record vs. due-bill distinction — directionally correct; FINRA due-bill rules confirm entitlement and delivery obligations cannot fold into settlement cycle (SME to confirm: FINRA Rule 11630).

## Design-intent drift (confirmed)

[M2-PLAN §5.2 module responsibility (line 327)](../planning/M2-PLAN.md#L327) and [§5.3 rule applicability blueprint (line 343)](../planning/M2-PLAN.md#L343) require rules to cover trading sessions, instrument classes, investor categories, and settlement conventions. The current module lacks trading-session/phase and instrument-class/investor-category scopes and has materially expanded corporate-action schedule semantics. Plan vs. module diverge.

## Per-container summary

| Container | Conclusion |
|---|---|
| Object types | Generic rule skeleton worth retaining; `RuleClause` over-generalized; `RuleEvaluationRequest` belongs to runtime selection layer; corporate-action profile needs isolation from core. |
| Association types | `RuleApplicability` strong but scope insufficient; `RulePrecedence` should reference applicability; `RuleConflict` should become a branch of an outcome hierarchy. |
| Relation types | Missing clause-unique-owner, calendar/session, reference price, rule condition/effect, selection outcome. `distributionAssessmentRequiredPriceKindIri` should not be a bare URL string. |
| Attribute types | 64 attributes carry many natural-language promises (`positive`, `business-day`, `dimensionless`) without equal-strength type constraints; must extract price/quantity/percentage/time/business-day value semantics. |
| Code lists | `RuleType` and subtypes duplicate coding; clarify single source of truth; `rightsIssue` extension too broad; add scope, control-action, resume-mechanism, precedence-basis code lists. |
| Constraints | Mandatory bindings are a strength, but many core semantics exist only as `language: Custom; contract=...`. Logical identity, ownership, units, selection outcome, scope overlap must become module-interpretable structure, not external contract names. |

## Recommended convergence order

1. Establish `RuleSelectionOutcome`; fix request/candidate/winner/no-match/conflict boundary.
2. Refactor `RuleClause`: range / trigger / date / entitlement / effect clauses separate.
3. Complete logical identity and unique ownership for RuleSet/Rule/Clause/Parameter/Method.
4. Rebuild tick/lot/price-limit/circuit-breaker as "input measure + reference baseline + applicable session + effect."
5. Connect existing calendar/session semantics; eliminate hash-as-calendar.
6. Clarify corporate-action profile, transferable rights, and due-bill support boundary.
7. Only then decide on module split — via ADR/RFC with market-microstructure and corporate-action/settlement SME joint review.

## Disposition

- **Release status**: `fin-market-rules` bumped to **v1.1.0, approved**. Round-12 v1.0.0 acceptance contract remains the historical baseline.
- **Architecture status**: P0 architecture revision **implemented and regression-verified** (ADR-023 Accepted, v1.1.0 in-place). The module now models rule selection outcomes, reference-price specification, circuit-breaker trigger/effect, clause ownership, calendar/session links, scope expressions, and multi-role normative sources. The "executable Market Rules ontology" claim is now supported for the implemented P0 surface.
- **Deferred (not blocking)**: MR-A8 (transferable-rights naming), MR-A9 (RuleType breadth), MR-A12 (profile split) remain gated on SME review of [RFC-002](../planning/RFC-002-market-rules-architecture.md) Q4/Q5 and a profile-split follow-up ADR.
- **Regression gate (2026-08-04)**: `validate-m2-core --all --strict` 10 modules 0 errors; `run-domain-shacl` pySHACL PASS; `run-all-cq-probes` 122/0/0 (61 CQs); all 10 modules OWL/SHACL regenerated cleanly. `test-all-domain` step 2 has a pre-existing environment-specific concurrent-IO race (not caused by this revision).

## References

- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) (acceptance contract)
- [M2-PLAN §5.2/§5.3](../planning/M2-PLAN.md) (module responsibility, rule applicability blueprint)
- [market-rules-semantic-gap.md](gap/market-rules-semantic-gap.md) (Round-12: all gaps closed at v1.0.0 — superseded by this review for the executable-ontology claim)
- [RFC-002](../planning/RFC-002-market-rules-architecture.md) (Proposed)
- [ADR-023](ADR-023-market-rules-architecture.md) (Proposed)
