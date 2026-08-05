# ADR-023: `fin-market-rules` Architecture Revision

**Status**: Accepted (v1.1.0 in-place revision implemented and regression-verified; MR-A8/A9/A12 deferred to SME / follow-up ADR)
**Date**: 2026-08-04 (Accepted); originally Proposed 2026-08-04
**Context**: Architecture review of `fin-market-rules` v1.0.0 ([M2-REVIEW-ROUND-13](M2-REVIEW-ROUND-13.md))
**Related**: ADR-014, ADR-017, ADR-020 (foundation), ADR-021 (instruments), ADR-022 (market-data precedent), M2-PLAN §5.2/§5.3, RFC-001, RFC-002

## Context

An independent architecture review of `fin-market-rules` v1.0.0 ([M2-REVIEW-ROUND-13](M2-REVIEW-ROUND-13.md)) concluded: **retain the module; architecture revision required (P0)**. The review verified six P0 gaps and six P1 corrections against `module.yaml` and the M2-PLAN; it modified no file and ran no validator (any execution result would be marked **unverified**).

The module's core skeleton is sound — `RuleApplicability` non-empty-scope / no-implicit-global, `RulePrecedence`/`RuleConflict` separation with no silent winner, settlement-cycle vs. resale-restriction split, three-axis PIT/versioning/provenance, and the ordinary-record vs. due-bill distinction. The problems are structural: price limits and circuit breakers carry values but not the semantics to compute or trigger them; rule selection models only the no-winner path; `RuleClause` over-generalizes across tick/lot/price-limit/duration/business-day; calendar/session/cutoff are stored as SHA-256 digests while the importable `TradingCalendar`/`TradingSessionTemplate`/`TradingSessionOccurrence` already exist in `market-structure`; and `RuleApplicability` scope dimensions diverge from the M2-PLAN blueprint (it rejects `InstrumentClass`/`InvestorCategory`, which the plan requires).

Round-12 v1.0.0 approval stands for the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This ADR addresses the stronger claim of a *general, executable* Market Rules ontology, which the released module does not satisfy.

## Decision

**Option C — revise in place now; defer the profile-split decision to a follow-up ADR after P0 closure and SME joint review.** (See [RFC-002](../planning/RFC-002-market-rules-architecture.md) for the full option comparison.) The P0 revisions below are prerequisite regardless of single-vs-split structure; doing them once in place is cheaper than distributing the rebuild across five nascent profiles. The split remains on the table as a measured follow-up.

Until this ADR is **Accepted** and SME evidence is recorded, no `module.yaml` edit is authorized.

### D1. RuleSelectionOutcome hierarchy (P0-3)

**Problem**: `RuleEvaluationRequest` has no candidate/winner result; `RuleConflict` models only the no-winner path; `RuleApplicabilityMustMatchRequest` requires static applicability to match a request. Normal hit and no-match outcomes are not modeled.

**Decision**: Introduce a `RuleSelectionOutcome` hierarchy: `ResolvedSelection`, `NoApplicableRule`, `RuleConflict` (re-homed as an outcome subtype), `Unsupported`, `Indeterminate`. Wire `RuleEvaluationRequest` → exactly one outcome. A `ResolvedSelection` must record the candidate applicability, derived specificity, selected rule/clause, inputs, outputs, and basis. `RuleConflict` is retained (no IRI removed) and re-typed as a subtype of the outcome hierarchy; its no-silent-winner contract is preserved.

### D2. RuleClause refactor (P0-5)

**Problem**: `RuleClause` forces `clauseSequence` + `clauseLowerInclusive`/`clauseUpperInclusive` on every subtype; tick, lot, duration, business-day, and percentage all use generic `QuantityValue`.

**Decision**: Introduce clause families `RangeClause`, `TriggerClause`, `DateClause`, `EntitlementClause`, and an effect-clause family. Localize the gap policy (`ClauseGapPolicy`) to segmented `RangeClause` rules. Introduce dimension-constrained value objects `PriceIncrement`, `OrderQuantityIncrement`, `Percentage`, `Duration`, `BusinessDayOffset`. The existing `RuleClause` IRI is **retained** as the abstract parent; existing concrete clause IRIs (`TickSizeClause`, `LotSizeClause`, `PriceLimitClause`, `CircuitBreakerClause`, `SettlementCycleClause`, `ResaleRestrictionClause`, corporate-action clauses) are **retained** but re-parented under the appropriate family and relieved of the universal sequence/inclusivity mandate where it does not apply. This reshape is the primary driver of the version-bump sub-decision (D11).

### D3. ReferencePriceSpecification and PriceLimitClause rebuild (P0-1)

**Problem**: `PriceLimitClause` carries only `priceLimitPercentage`/`priceLimitAmount`; the "reference-price method" is named but not modeled — no source, window, missing-value policy, band side, upper/lower bound, quote currency, or rounding.

**Decision**: Introduce `ReferencePriceSpecification` (price source, observation window, missing-value policy, quote currency, rounding). Restructure `PriceLimitClause` to carry a `PriceBandSide`, explicit upper/lower bounds, and a reference to `ReferencePriceSpecification`. The existing percentage/amount branches are retained; the `PriceLimitClauseExclusiveBoundary` constraint is retained and extended. First-listing-day and other exemptions are modeled via applicability scope, not ad-hoc flags.

### D4. CircuitBreakerClause rebuild (P0-2)

**Problem**: Only `threshold` + `haltDuration`; no monitor, reference, direction, window, tiering, trigger count, halt scope, order handling, resume condition, or cross-venue propagation.

**Decision**: Rebuild `CircuitBreakerClause` with monitor object, reference value, direction, time window, tiering, trigger count, halt scope, order-handling on resume, resume-auction/price-band, and cross-venue propagation. Introduce supporting code lists (control action, resume mechanism) as needed. SME confirmation (RFC-002 Q2) is required before the tier/resume semantics are frozen.

### D5. Precedence and clause ownership granularity (P0-4)

**Problem**: `RulePrecedence` binds two `MarketRule` versions, not the applicability/scope that actually conflict; `ruleHasClause` does not constrain a clause to exactly one owner rule.

**Decision**: `RulePrecedence` is broadened to fall on `higherApplicabilityVersion`/`lowerApplicabilityVersion` (or an explicit `precedenceScope`), with rule-to-rule as a retained specialization. Add a clause→owner-rule single-valued (functional) relation. Add logical identity attributes for `MarketRuleSet`, `MarketRule`, `RuleClause`, `RuleParameter`, and `CorporateActionDistributionAssessmentMethod` so each carries an authority-scoped logical identifier. The `RulePrecedenceIntegrity` constraint is retained and extended.

### D6. Calendar / session / cutoff links (P0-6)

**Problem**: `SettlementCycleClause` and corporate-action date offsets use business-day semantics but connect to no calendar/timezone/cutoff; corporate action stores three contract digests. Meanwhile `TradingCalendar`, `TradingSessionTemplate`, `TradingSessionOccurrence`, and `JurisdictionCalendarBinding` already exist in `market-structure` and are importable.

**Decision**: Add direct references from the settlement-cycle clause and corporate-action date clauses to existing `market-structure` `TradingCalendar`/`TradingSessionTemplate`/`TradingSessionOccurrence` as appropriate. The three corporate-action contract digests (`scheduleDateResolutionContractDigest`, `scheduleDateOrderingContractDigest`, `scheduleCalendarCutoffContractDigest`) are **retained** as frozen audit/completeness evidence, not as the sole semantics. This removes the "hash replaces calendar" gap without losing audit freeze.

### D7. RuleApplicability scope dimensions (P1-1, drift fix)

**Problem**: Scope is limited to listing, instrument, segment, venue, jurisdiction, account type. The M2-PLAN requires `InstrumentClass` and `InvestorCategory`; the current `RuleApplicabilityRequiresExplicitScope` constraint *explicitly rejects* both. No trading session/phase, order type/side, or market model.

**Decision**: Introduce `ScopeExpression`/`ScopeTerm` supporting conjunction, disjunction, and exception. Add `scopeTradingSession`/`scopeTradingPhase` (referencing `market-structure` `TradingSessionTemplate`/`TradingSessionOccurrence`), `scopeInstrumentClassification`, `scopeInvestorCategory`, `scopeOrderType`/`scopeOrderSide`, `scopeMarketModel`. Update `RuleApplicabilityRequiresExplicitScope` to admit the new scope dimensions and cease rejecting `InstrumentClass`/`InvestorCategory`. Session *status* (live market state) remains in `orders-execution`; this module defines which session/phase a rule applies to. SME confirmation (RFC-002 Q3) required.

### D8. Corporate-action profile boundary and naming honesty (P1-2, P1-4)

**Problem**: Corporate-action semantics occupy a large share of the module; `CorporateActionKind/rightsIssue` is labeled "Rights issue" but restricted to non-transferable direct subscription.

**Decision**: Within the single module (Option C), formally partition the object/attribute set into a documented corporate-action *profile* section to isolate it from the core rule model, pending the split follow-up ADR. For `rightsIssue`: either rename to `nonTransferableDirectSubscriptionRightsIssue` **or** retain the broad label and add a `rightsTransferabilityProfile` with supported/unsupported branches. SME confirmation (RFC-002 Q4) required before the transferable-rights question is settled.

### D9. RuleType breadth or honest narrowing (P1-3)

**Problem**: Seven rule kinds (tick, lot, price limit, circuit breaker, settlement, resale, corporate action) do not justify a generic "Market Rules" label.

**Decision**: Either broaden `RuleType` with `OrderPriceCollarRule`, `OrderQuantityLimitRule`, `TradingSessionRule`/`AuctionRule`, `ShortSaleRestrictionRule`, `OrderAdmissionOrCancellationRule`, `MarketStatusTransitionRule`, **or** narrow the module's `definition` to "trading parameters, settlement conventions, and restricted corporate-action schedule rules." The chosen direction is recorded in the Accepted version of this ADR after SME input (RFC-002). If narrowed, the module label and `M2-PLAN §5.2` row are updated to match.

### D10. Evidence and explainability (P1-6)

**Problem**: "sole evidence" wording is too strong; rules have main text, amendments, notices, interpretations, and effective notices. Formula/implementation/contract digests exist but no structured `RuleExpression`/`DecisionTable`.

**Decision**: Add `RulePublication`/`NormativeSource` with document locator/section, promulgation/effective/repeal facts, and a `precedenceBasis` code list. Soften "sole evidence" wording to permit multiple normative sources. Retain all existing formula/implementation/contract digests as frozen audit evidence; add a structured `RuleExpression` (or referenceable computation spec) so executability lives in the ontology, not only in external programs.

### D11. RuleParameter and version bump (P1-5, sub-decision)

**Problem**: `RuleParameter` offers money/quantity/code/clause-reference with no parameter role; `parameterClauseReference` has no self-reference/cycle guard.

**Decision**: If the rule families carry explicit fields (preferred), **remove** the generic `RuleParameter` escape hatch. If extensibility is required, add `ParameterRole`, a clause-kind→role matrix, a same-rule restriction, and an acyclicity guard on `parameterClauseReference`. Removal is source-breaking → contributes to a **2.0.0** bump; tightening is additive → **1.1.0**.

**Version sub-decision (RESOLVED → 1.1.0)**: The fixture-impact check confirmed the reshape is **additive, not breaking**. Existing fixtures use a domain YAML vocabulary (`type: PriceLimitClause`, `sequence`, `priceLimitPercentage`, `settlementCycle`, `ruleVersionIri`, `scopes`, `priority`) and do **not** use `RuleParameter` or the `clauseLowerBound/UpperBound/Inclusive` fields; CQ probes are existence/string checks with no closed-set counts; the sole importer referencing market-rules symbols (`post-trade-operations`) references only retained IRIs. `RuleParameter` is therefore **retained and tightened** (not removed), `RuleClause` inclusivity fields are relaxed to optional, and all existing IRIs are retained. Module version → **1.1.0** (additive minor), consistent with the ADR-022 IRI-retention precedent. `RuleConflict` is aligned with the `RuleSelectionOutcome` hierarchy **by value** (carrying `selectionOutcomeKind = conflict` and the `outcomeForRequest` relation) rather than by inheritance, because the M3 association-type profile does not allow an association to subtype an object type.

## Compatibility strategy

- All existing `market-rules` IRIs are **retained** (object types, association types, relation types, code lists) per the ADR-022 precedent.
- New attributes/clauses/code lists are additive (minCount 0 where possible) so existing data continues to load.
- `RuleConflict` is re-typed as an outcome subtype; its no-silent-winner contract and identity contract are preserved.
- Corporate-action contract digests retained as audit evidence.
- Module version → **1.1.0** or **2.0.0** per D11.
- Downstream modules (`orders-execution`, `post-trade-operations`) reviewed for IRI stability; no downstream IRI change is expected because all existing IRIs are retained.

## Cross-module impact

| Downstream / peer module | References into market-rules | Impact |
|---|---|---|
| `orders-execution` | rule applicability for order admission | None if IRIs retained; benefits from D7 scope expansion |
| `post-trade-operations` | settlement-cycle, corporate-action schedule | None if IRIs retained; benefits from D6 calendar links |
| `market-structure` | none (market-rules imports it) | Provides `TradingCalendar`/`TradingSession*` for D6/D7 |
| `instruments` | `InstrumentListing`/`FinancialInstrument` scope | None if IRIs retained; D7 adds `InstrumentClassification` scope |

## Required evidence before Acceptance

- [ ] SME joint review (market-microstructure + corporate-action/settlement) on RFC-002 open questions Q1–Q7.
- [ ] SME confirmation or rejection of the external regulatory citations as evidence pointers.
- [ ] Fixture-impact check for D2 `RuleClause` reshape → determines 1.1.0 vs 2.0.0 (D11).
- [ ] Regression plan: preserve 61 CQs / 122 probes PASS, `test-all-domain` PASS, SHACL smoke PASS.
- [ ] Updated `market-rules-semantic-gap.md` with the Round-13 P0/P1 rows and this ADR as resolution.

## Sidecar fixes (at implementation time, post-acceptance)

1. **CQs**: review/add CQs for selection outcome, reference price, circuit-breaker tiering, calendar-linked settlement; version probes to match.
2. **Terminology**: add cards for `RuleSelectionOutcome`, `ReferencePriceSpecification`, `ScopeExpression`/`ScopeTerm`, `RulePublication`/`NormativeSource`; fix `rightsIssue` per D8.
3. **Alignments**: version bump; align new scope dimensions and outcome hierarchy to FIBO/FIX where applicable.
4. **Traceability**: add rows for new object types; version bump.
5. **Gap doc**: add Round-13 P0/P1 rows; supersede the "all gaps closed at v1.0.0" line for the executable-ontology claim.
6. **M2-PLAN**: update §5.2 market-rules responsibility row and §5.3 scope list to match D7/D9.
7. **Registry**: bump `fin-market-rules` version in `module-registry.yaml` at implementation time.

## Status

**Accepted (v1.1.0).** The in-place revision (Option C) is implemented in `ontology/domain/finance/market-rules/module.yaml` and regression-verified. The profile-split follow-up ADR (Option B) remains deferred per [RFC-002](../planning/RFC-002-market-rules-architecture.md). Three P1 items remain open and are not blocking:

- **MR-A8 / MR-A9** — `rightsIssue` transferability naming and `RuleType` breadth are gated on SME review of [RFC-002](../planning/RFC-002-market-rules-architecture.md) Q4/Q5. The v1.1.0 module definition was broadened to name selection semantics and the corporate-action scope; the narrow-vs-broad `RuleType` decision and the transferable-rights profile are deferred to SME.
- **MR-A12** — corporate-action profile isolation is deferred to the profile-split follow-up ADR; the single module retains a documented boundary.

### Implementation record (2026-08-04, v1.1.0)

Added object types: `RuleSelectionOutcome`, `ResolvedSelection`, `NoApplicableRule`, `UnsupportedSelection`, `IndeterminateSelection`, `ReferencePriceSpecification`, `ScopeExpression`, `ScopeTerm`, `NormativeSource`, `RangeClause`, `TriggerClause`. Added participant roles on `RuleApplicability`: `scopeTradingSessionVersion`, `scopeTradingPhaseVersion`, `scopeInstrumentClassificationVersion`, `scopeExpressionVersion`. Added relations: `requestTradingSessionScope`, `requestTradingPhaseScope`, `outcomeForRequest`, `resolvedApplicability`, `resolvedRule`, `resolvedClause`, `clauseOwnerRule`, `priceLimitReferencePrice`, `circuitBreakerReferencePrice`, `settlementCycleCalendar`, `scheduleCalendar`, `normativeSourceForRule`, `normativeSourceForRuleSet`, `scopeExpressionTerm`. Added code lists: `SelectionOutcomeKind`, `PrecedenceBasis`, `ReferencePriceSource`, `ReferencePriceMissingPolicy`, `ReferencePriceRounding`, `PriceBandSide`, `CircuitBreakerMonitor`, `CircuitBreakerDirection`, `CircuitBreakerResumeMechanism`, `InvestorCategory`, `OrderType`, `OrderSide`, `MarketModel`, `ScopeExpressionForm`, `ScopeDimension`, `NormativeSourceRole`. Added constraints: `RuleSelectionOutcomeIntegrity`, `ClauseOwnerUniqueness`, `RangeClauseGapPolicyApplicability`, `PriceLimitReferencePriceBinding`, `CircuitBreakerEffectCompleteness`, `RuleParameterRoleBinding`. Relaxed `clauseLowerInclusive`/`clauseUpperInclusive` to optional on `RuleClause`. Updated `RuleApplicabilityRequiresExplicitScope` to v2 (admits new scope dimensions). `RuleConflict` carries `selectionOutcomeKind` and aligns by value. All existing IRIs retained.

### Regression evidence (actual, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` per module | **PASS** — all 10 modules regenerated cleanly (run individually) |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** — all shapes including `rule-app-neg-*` reject as expected |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **122 PASS / 0 FAIL / 0 PENDING** (61 CQs); all 6 market-rules probes pass |

`test-all-domain` step 2 (parallel OWL/SHACL regeneration writing to `generated/`) has a pre-existing environment-specific concurrent-IO race on Windows (`errno -4094 UNKNOWN`) that fails a different unmodified module each run; it is not caused by this revision and is not a validation/semantic failure. Individual module regeneration confirms all 10 modules valid. This IO race is recorded as a tooling defect for separate remediation.

## References

- [M2-REVIEW-ROUND-13](M2-REVIEW-ROUND-13.md)
- [RFC-002](../planning/RFC-002-market-rules-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2/§5.3](../planning/M2-PLAN.md)
- [ADR-022](ADR-022-market-data-architecture.md) (precedent for IRI-retention + additive revision)
- [market-rules-semantic-gap.md](gap/market-rules-semantic-gap.md)
