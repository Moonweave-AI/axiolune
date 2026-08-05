# ADR-029: `fin-portfolio-positions` Architecture Revision

**Status**: Proposed (v1.1.0 in-place additive revision implemented; SME joint review on RFC-005 Q1–Q8 outstanding; physical runtime-profile split deferred to follow-up ADR)
**Date**: 2026-08-05 (Proposed)
**Context**: Architecture review of `fin-portfolio-positions` v1.0.0 ([M2-REVIEW-ROUND-16](M2-REVIEW-ROUND-16.md))
**Related**: ADR-014 (versioning), ADR-020 (foundation Party/Currency), ADR-021 (instruments thin-core + profile precedent), ADR-022 (IRI-retention precedent), ADR-024 (market-structure v1.1.0 additive backbone revision), ADR-026 (orders quotation supertype-widening as additive minor), ADR-028 (orders layer separation — document-deprecation precedent), M2-PLAN §5.2, RFC-001

## Context

An independent architecture review of `fin-portfolio-positions` v1.0.0 ([M2-REVIEW-ROUND-16](M2-REVIEW-ROUND-16.md)) concluded: **retain the module; architecture revision required (P0)**. The review verified seven P0 issues and four P1 corrections against `module.yaml` (3,802 lines) and the M2-PLAN; it modified no file and ran no validator (any execution result would be marked **unverified**).

The module's backbone is sound — the "portfolio–account–holding–lot–valuation–cost-basis–reconciliation" skeleton is correct and more mature than a single `Position` class. The problems are structural: the current code lists and constraints lock the model to one very concrete operating profile (direct-unit-price valuation, execution-derived cost, strict closures, data-ingestion contracts) and present it under a generic "Portfolio and Positions" name. The review's central recommendation is to converge the module to a **generic semantic core** plus an **optional "direct-unit-price × quantity, execution-driven cost, strict closure, data ingestion" implementation profile**, retaining the generic name.

Round-12 v1.0.0 approval stands for the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This ADR addresses the stronger claim of a *semantically complete* portfolio-and-positions module, which the released module does not yet satisfy.

## Decision

**Option B — retain the generic name; revise the backbone in place now (v1.1.0, additive, IRI-retentive); introduce abstract families so the previously hard-locked single-method/single-policy paths become the first concrete profile; broaden the generic core with position scope, balance dimension, lot lifecycle, and reconciliation comparison/finding/resolution; annotate the runtime/reproducibility evidence as a document-scoped profile (no physical module split).** The user confirmed this form (v1.1.0 additive, full lot-lifecycle extension, document-scoped runtime profile). The seven backbone P0 revisions are in place; cross-module physical migrations (runtime-module split, performance-and-attribution module, corporate-action full workflow) are correctly measured follow-ups, not in-place edits.

Until this ADR is **Accepted** and SME evidence is recorded for the deferred items, no cross-module runtime split or performance-module extraction is authorized.

### D1. Identity authority (P0-01, PP-A1)

**Problem**: `Portfolio` claims "authority-scoped" but its logical key is only `portfolioId`; `PortfolioAccountMembership` and `PortfolioManagementMandate` keys likewise omit the authority. `PortfolioObservationStream` puts provider, source contract, and stream ID into one identity key, conflating "provider-owned stable stream" with contract-scoped ingestion.

**Decision**: Introduce `portfolioIdentifyingAuthority` as a functional relation from `Portfolio` to `foundation:Party` (logical reference), and include it in `PortfolioContract.logicalKey` → `logicalKey(portfolioIdentifyingAuthority.logicalIri, portfolioId)`. The existing `membershipAuthority`/`mandateAuthority` Party roles on membership/mandate are explicitly documented as forming the identity context (their contracts already reference them; expressions updated to name them as identity-context authorities). `PortfolioObservationStream` is clarified: its stable identity is `(provider, portfolioObservationStreamId)`; the source/completeness/pagination contracts are **version-locked ingestion semantics** (version content), **not** identity components — `PortfolioObservationStreamContract` expression rewritten to separate the identity key `(portfolioObservationStreamProvider.logicalIri, portfolioObservationStreamId)` from the contract lock (which mutates version content, not identity). Existing `portfolioObservationStreamProvider` relation retained. SME confirmation (RFC-005 Q1) required on whether `portfolioIdentifyingAuthority` should be a relation or an attribute.

### D2. Position scope and balance dimension (P0-02, PP-A2)

**Problem**: A single signed `positionQuantity` cannot express custody/accounting/economic/regulatory views, nor settled/pending/available/pledged/loaned balances, nor gross long / gross short / net simultaneously.

**Decision**: Introduce two closed code lists — `PositionScope` (custody / accounting / economic / regulatory) and `BalanceDimension` (settled / pending / available / pledged / loaned / receivable / payable). Add optional (0..1) attributes to both `HoldingSnapshot` and `PositionSnapshot`: `positionScope`, `balanceDimension`, `grossLongQuantity`, `grossShortQuantity` (QuantityValue), `businessAsOf` (date), `statementPeriodRef` (uri). The existing `holdingQuantity` (non-negative net) and `positionQuantity` (signed net) are **retained** as the default authoritative quantity but are no longer the *only* authoritative quantity — a new `PositionBalanceDimensionCardinality` constraint states that where `balanceDimension` is present, `grossLongQuantity`/`grossShortQuantity` express that bucket and `positionQuantity` remains the signed net default. FIX Position Report (Tag 702) and ISO 15022 MT538 custody sub-balances inform the dimension set. SME confirmation (RFC-005 Q2) required before the dimension vocabulary is frozen.

### D3. Valuation core + profile (P0-03, PP-A3)

**Problem**: `ValuationCalculationDefinition` is locked to `directUnitPriceTimesQuantity`; `PositionValuationContract` forbids par, accrual, multiplier, notional paths; the portfolio layer lacks a verifiable valuation-line coverage / cash / accrued / receivable-payable inclusion rule and total closure.

**Decision**: Introduce `ValuationMethodFamily` as an abstract object type — the parent of valuation method profiles — and `DirectUnitValuationProfile` as its first concrete subtype carrying the locked `directUnitPriceTimesQuantity` method, `contractMultiplier = 1`, and the par/accrued/multiplier/notional forbiddals. The previously global hard lock **moves down** to the profile (scoped via `ConstraintBinding` and constraint-expression text, not removed). Introduce `valuationDefinitionMethodFamily` (functional relation → `ValuationMethodFamily`). Broaden the `ValuationMethod` code list additively (`markToModel`, `costBasis`, `lowerOfCostOrMarket`, `accruedIncome`, `notionalBased`; existing `directUnitPriceTimesQuantity` retained). Relax `ValuationCalculationDefinitionContract`: the `valuationMethod = directUnitPriceTimesQuantity` assertion becomes "when `valuationDefinitionMethodFamily = DirectUnitValuationProfile`, then `valuationMethod = directUnitPriceTimesQuantity`; other profiles bind their own method." Add `PositionValuation` optional attributes `valuationSubjectKind`, `valuationFinality` (preliminary/final), `coverageInclusionReason`, `exclusionReason`. The `PositionValuationContract` "forbidden(line method, par, accrued, inverse, notional, multiplier fallback)" clause moves to the `DirectUnitValuationProfile` scope; generic position valuations under other profiles are not forbidden those paths. Introduce `PortfolioValuationSummary` association (sums lines, closes coverage) with `PortfolioValuationSummaryContract`. IFRS 13 (measurement date, market participant, exit price) and GIPS valuation/cash/accrual policies inform the family. SME confirmation (RFC-005 Q3) required before additional profiles are frozen.

### D4. Lot lifecycle (P0-04, PP-A4)

**Problem**: `PositionLot` is locked to execution-derived `openingRemainder`; only FIFO/LIFO/specific-identification; "lot opening time" is referenced but has no explicit field; no realized P&L, transfer, opening balance, split, merge, corporate-action adjustment, exercise, or manual-adjustment lifecycle.

**Decision**: Relax `lotDiscriminator` pattern to allow `openingRemainder | adjustedRemainder | transferredLot` (the `openingRemainder` value remains valid; broadened additively). Extend `PositionSourceKind` additively with `openingBalance`, `transfer`, `corporateActionResult`, `exerciseAssignment`, `manualAdjustment`, `clearingCustodyStatement`, `calculatedAggregation` (existing `externalReported`/`executionDerived` retained). Introduce `PositionChangeKind` code list and a `PositionChange` association (account + instrument + optional `sourceBusinessEvent` → foundation:BusinessEvent + changeKind + changeQuantity + changeEffectiveAt + changeEvidence). Introduce `LotAdjustment` association (split / merge / restatement / corporateActionAdjustment, with quantity factor and basis adjustment) and `LotRealization` association (realized lot + optional realizing execution/change + realizedQuantity + realizedCostBasis + realizedProceeds + realizedPnl). Add `lotSourceKind` (PositionSourceKind, 0..1) and `derivedFromChange` (→ PositionChange, 0..1) to `PositionLot`. The `PositionLotContract` "execution-derived opening remainder" assertions move to a profile-scoped constraint; generic lots may be sourced from transfer/opening-balance/corporate-action-result. The `PositionLotOpeningAllocationCompletenessContract` "each lot targeted by exactly one opening allocation" becomes profile-scoped to execution-derived lots. **Full corporate-action workflow remains in an independent module**; here only lot/position results and traceability. IRS Publication 550 and FIX PosType inform the lifecycle. SME confirmation (RFC-005 Q4) required on the `sourceBusinessEvent` binding.

### D5. Reconciliation comparison / finding / resolution (P0-05, PP-A5)

**Problem**: `ExternalCostBasisObservation` is forced to use the same internal `CostBasisCalculationDefinition`; reconciliation rejects multiple candidates and has no ambiguous / notComparable / timingDifference / methodologyDifference / resolution states. `matched` is overloaded as both a comparison result and a "finding."

**Decision**: Split into three concepts. `ReconciliationComparison` (association, the comparison act) carries `comparisonFamily` (quantity/basis), `comparisonProfileRef`, `comparisonResult` (new code list `ReconciliationComparisonResult`: matched / break / ambiguous / notComparable), and the existing candidate-graph/manifest/tool-lock context (now profile-scoped per D6). `ReconciliationFinding` (the `PortfolioPositionReconciliationFinding` IRI **retained**, definition narrowed to "a break or notable result requiring disposition") carries `findingKind` (new code list `ReconciliationFindingKind`: matched [demoted to compatibility value] / quantityMismatch / basisMismatch / methodologyDifference / timingDifference / ambiguous / notComparable / missingExternal / missingDerived), `findingSeverity`, `subjectDigest`, and a `sourceComparison` role. `ReconciliationResolution` (new association) carries `resolutionKind` (new code list `ResolutionKind`: accepted / investigated / corrected / waived / escalated), `resolutionNote`, `resolutionEvidence`, and roles to the finding and a resolving Party. `ExternalCostBasisObservationContract` is relaxed: `externalBasisDefinition` becomes **optional** (0..1) — the external party may report its own `externalBasisMethod` (string, 0..1), `externalStatementDate` (date, 0..1), `externalBasisMappingStatus` (mapped / unknown / unmapped, 0..1); the internal definition is an optional mapping, not a disguised external method. `PortfolioReconciliationKind` is extended additively with `ambiguous`, `notComparable`, `timingDifference`, `methodologyDifference` (existing five retained). `matched` is documented as primarily a comparison result; the finding-kind value remains for compatibility. SME confirmation (RFC-005 Q5) required on the resolution workflow.

### D6. Runtime / reproducibility profile (P0-06, PP-A6) — document-scoped, no physical migration

**Problem**: Domain facts and runtime implementation artifacts (stream contracts, pagination, tool/runtime locks, execution-allocation closures) are mixed in the same mandatory ontology layer.

**Decision**: Annotate, in type/attribute definitions, which elements belong to the **execution-and-reproducibility profile**: `PortfolioObservationStream` source/completeness/pagination contracts and source-artifact digests; `ExecutionLotAllocationClosure` strict closure probes (allocation/fee/consumption-selection); `PositionLotStateClosure` lot/allocation closure probes; `PortfolioPositionReconciliationFinding` candidate-graph/manifest/tool-lock probes; all `*VersionSetDigest`, `*Count`, `*ProbeRef/Digest`, `toolLockRef/Digest`, `runtimeDigest`, `implementationDigest` fields. Core constraints (endpoints, conservation, sign, identity) stay Mandatory. Profile constraints are documented as "Mandatory when the execution-and-reproducibility profile is active; otherwise the field is optional evidence" — expressed in constraint-expression text and definition annotations per the project's prose-deprecation convention (no new YAML key, consistent with ADR-024). **No physical module split** in this revision; all profile types remain in `fin-portfolio-positions`. The physical split to a `fin-portfolio-runtime` module is deferred to a follow-up ADR (ADR-030 candidate) gated on SME confirmation (RFC-005 Q6), per the ADR-028 document-deprecation precedent. This keeps the core able to express real portfolio state without requiring every business fact to attach to a data extraction or a runtime tool.

### D7. Portfolio constituent breadth (P0-07, PP-A7)

**Problem**: `PortfolioAccountMembership` makes a portfolio essentially a financial-account aggregation; `PortfolioManagementMandate` is closer to management authority than an investment mandate (no strategy, benchmark, base currency, performance policy).

**Decision**: Introduce `PortfolioConstituent` as a new association with a `constituentSubject` role whose range is `foundation:FinancialAccount | Portfolio | Sleeve` (union via supertype or polymorphic role) and a `constituentKind` attribute (new code list `PortfolioConstituentKind`: account / subPortfolio / sleeve / explicitAllocation). The existing `PortfolioAccountMembership` IRI is **retained** and documented as the account-kind specialization of `PortfolioConstituent`. Introduce `Sleeve` as an optional object type (a management subdivision of a portfolio). `PortfolioManagementMandate` IRI is retained and scoped in its definition as "management authority, not a full investment mandate"; the full investment mandate / benchmark / base currency / performance policy belong to a future `fin-performance-attribution` module (deferred, P1). GIPS portfolio/composite semantics inform the constituent kinds. SME confirmation (RFC-005 Q7) required on the Sleeve/constituent boundary.

### D8. Snapshot stream-reference consistency (P1-1, PP-A8)

**Problem**: `HoldingSnapshot` uses exact fact-version reference to its observation stream while `PositionSnapshot` and `ExternalCostBasisObservation` use logical reference — inconsistent "locked-at-observation version" vs "logical stream definition" principle.

**Decision**: Add an `observedFromStream` relation (ExactVersionReference) to `PositionSnapshot` and `ExternalCostBasisObservation` alongside their existing logical stream role, and document the principle: "the fact uses the version locked at observation; the stream definition is logical." Both relations are optional in the generic core; the execution-and-reproducibility profile (D6) makes the exact-version binding mandatory.

### D9. PositionSourceKind breadth (P1-2, PP-A9) — satisfied by D4.

### D10. FXConversion precision (P1-3, PP-A10)

**Problem**: `FXConversion` conflates a valuation-rate application with a real FX trade; lacks cross-rate, multi-leg, rate source, quote time, rate date, finality.

**Decision**: Retain the `FXConversion` IRI (IRI stability). Add optional attributes `rateSource` (uri), `quoteTime` (datetime), `rateDate` (date), `rateFinality` (new code list: indicative / firm / settled, 0..1), `crossRatePath` (uri, 0..1). Document in the definition that "if this fact represents a real FX trade, it belongs to trading/settlement semantics and should reference a settlement/trading module fact; here it models a rate application." `FXRateApplication` is noted as an alias in the definition (no new IRI). SME confirmation (RFC-005 Q8) required on the cross-rate representation.

### D11. authorityScope structure & performance boundary (P1-4, PP-A11)

**Problem**: `authorityScope` is free text; performance / P&L / attribution (TWR/MWR, cashflow, gross/net-of-fee, benchmark) are mixed into this module.

**Decision**: Retain `authorityScope` as string (IRI stability) but add optional structured hooks `authorityScopeSubject` (uri, 0..1) and `authorityScopeRole` (string, 0..1); full structured (authority, scope subject, effective period, role) representation is deferred to foundation v2.x. Performance and attribution (TWR/MWR, cashflow policy, gross/net-of-fee, benchmark, attribution) are explicitly **out of scope** here and deferred to a future `fin-performance-attribution` module; this module retains only the `UnrealizedPnLObservation` fact basis. GIPS Asset Owners informs the boundary but is not hardcoded as a regulatory obligation.

## Compatibility strategy

- All existing `portfolio-positions` IRIs are **retained** (object types, association types, relation types, attribute types, code lists, constraints) per the ADR-020..024 IRI-retention precedent.
- New attributes are optional (minCount 0) so existing data continues to load.
- New abstract families (`ValuationMethodFamily`, `DirectUnitValuationProfile`) are additive; the existing `ValuationMethod`/`CostBasisMethod` single values remain valid as the first profile.
- Hard-locked single-value constraints are **broadened** (supertype-widening + codelist multi-value admission), not removed; the locked value remains one valid profile, per the ADR-024 D1 / ADR-026 precedent. This is additive (v1.1.0), **not** a 2.0.0 major, because (a) no IRI is removed, (b) the locked value remains valid, (c) the broadening is supertype-widening and codelist admission, and (d) fixtures use the domain YAML vocabulary, not the exact locked attribute set (fixture-impact check, per ADR-023 D11). The ADR-021 (instruments v2.0.0) major-bump precedent is distinguished: there the cumulative scope introduced a new abstract parent *and* re-scoped a global hard lock *and* reshaped a downstream-facing contract; here the re-scope is profile-internal and downstream-facing `Execution`/`Fee`/`DirectUnitPriceQuotationContract`/`PriceObservation` ranges are unchanged.
- `PortfolioAccountMembership` and `PortfolioPositionReconciliationFinding` IRIs are retained as specialized/compatible aliases.
- Module version → **1.1.0** (additive minor), consistent with the ADR-022/023/024 precedent and the fixture-impact check.

## Cross-module impact

| Downstream / peer module | References into portfolio-positions | Impact of v1.1.0 |
|---|---|---|
| `orders-execution` | (none — orders → portfolio not in DAG; portfolio imports orders for Execution/Fee) | None. |
| `risk` | `PositionSnapshot` (execution-derived exposure) | None (IRIs retained; benefits from D2 scope/dimension when adopted). |
| `strategy-research` | (none direct) | None. |
| `post-trade-operations` | (none direct; uses Execution/Fee from orders) | None. |
| `foundation` | `Party`, `Currency`, `FinancialAccount`, `BusinessEvent` (new D4 reference) | None (foundation IRIs unchanged; D4 uses BusinessEvent if present, else optional). |
| `instruments` | `FinancialInstrument`, `InstrumentListing`, `DirectUnitPriceQuotationContract` | None (IRIs retained; D3 broadens *portfolio's* use, not instruments'). |
| `market-data` | `PriceObservation`, `FXRateObservation` | None (IRIs retained). |

## Required evidence before Acceptance

- [ ] Backbone P0 revision implemented (PP-A1..A7) in `module.yaml`.
- [ ] Fixture-impact check confirms additive/non-breaking → v1.1.0 (D-version sub-decision resolved).
- [ ] Regression gates run (validate-m2-core, run-domain-shacl, run-all-cq-probes, validate-pit) with actual results recorded below.
- [ ] SME joint review (portfolio accounting + custody + valuation + reconciliation + data engineering) on RFC-005 open questions Q1–Q8.
- [ ] SME confirmation or rejection of the external regulatory citations (FIX, ISO 15022, IFRS 13, GIPS, IRS Pub 550) as evidence pointers.
- [ ] Physical runtime-profile split follow-up ADR (ADR-030 candidate) — deferred, not blocking this revision.
- [ ] Performance-and-attribution module scoping — deferred, not blocking.

## Sidecar fixes (at implementation time)

1. **CQs**: rewrite the seven stale v0.1.0 CQs to use actual v1.0.0+ predicates; add CQs PP8..PP15 for identity-authority disambiguation, gross long/short, multi-bucket balance, lot lifecycle, valuation-line coverage, reconciliation comparison/finding/resolution, constituent kinds, FX cross-rate path; version 0.1.0 → 1.1.0.
2. **Terminology**: drop deprecated Account/PositionSide/AccountType cards; add cards for all 20 v1.0.0 types + new v1.1.0 types (ValuationMethodFamily, DirectUnitValuationProfile, PortfolioValuationSummary, PositionChange, LotAdjustment, LotRealization, ReconciliationComparison, ReconciliationResolution, Sleeve, PortfolioConstituent) + new code lists; fix ValuationMethod card; version 0.1.0 → 1.1.0.
3. **Alignments**: version 0.3.0 → 1.1.0; add FIX Position Report (Tag 702), ISO 15022 MT538, IFRS 13, GIPS, IRS Pub 550, FIBO PortfolioHolding/lots, nautilus Position, BIAN investment portfolio.
4. **Traceability**: add rows for new object types/associations; version bump to v1.1.0; regression gate table with actual 2026-08-05 results.
5. **Gap doc**: add Round-16 P0/P1 rows (PP-A1..A11); supersede the "all gaps closed at v1.0.0" line for the semantically-complete claim; v1.1.0 status section.
6. **M2-PLAN**: update §5.2 portfolio-positions responsibility row to v1.1.0 with core/profile + lifecycle + reconciliation boundary.
7. **Registry**: bump `fin-portfolio-positions` version 1.0.0 → 1.1.0 in `module-registry.yaml` at implementation time.
8. **M2-REVIEW-ROUND-16**: create the review document; Disposition section referencing ADR-029 + staging fixtures + RFC-005 SME review; regression gate date.

## Status

**Proposed (v1.1.0).** The in-place additive revision (Option B) is implemented in `ontology/domain/finance/portfolio-positions/module.yaml`. The physical runtime-profile split (ADR-030 candidate) and the performance-and-attribution module remain deferred per [RFC-005](../planning/RFC-005-portfolio-positions-architecture.md). Items requiring SME input remain open and are not blocking:

- **PP-A6** — physical runtime-profile split is gated on SME review of RFC-005 Q6 and a follow-up ADR. The v1.1.0 module annotates the execution-and-reproducibility profile in place; the physical migration to `fin-portfolio-runtime` is deferred.
- **Q1–Q8** — identity-authority shape, balance-dimension vocabulary, valuation-method families, lot source-business-event binding, reconciliation resolution workflow, runtime-profile split boundary, Sleeve/constituent boundary, and FX cross-rate representation remain SME-confirmed.

### Regression evidence (actual, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 152 pass / 0 fail / 0 pending (80 CQs probed; 16 portfolio probes incl. PP8–PP15 wired) |
| PIT validation (new fixtures) | `node scripts/domain/validate-pit.cjs` (positive + negative) | **PASS** — 14 positive / 7 negative |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (portfolio-positions) | **PASS** — 0 projection warnings |

`test-all-domain` step 2 has a pre-existing environment-specific concurrent-IO race on Windows (documented in ADR-023 and memory) that is not caused by this revision and is not a validation/semantic failure.

## References

- [M2-REVIEW-ROUND-16](M2-REVIEW-ROUND-16.md)
- [RFC-005](../planning/RFC-005-portfolio-positions-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](../planning/M2-PLAN.md)
- [ADR-020](ADR-020-foundation-identity-architecture.md) (foundation Party/Currency/BusinessEvent)
- [ADR-021](ADR-021-instruments-architecture.md) (thin-core + profile, abstract supertype precedent)
- [ADR-022](ADR-022-market-data-architecture.md) (IRI-retention + Layer 4 precedent)
- [ADR-024](ADR-024-market-structure-architecture.md) (v1.1.0 additive backbone revision precedent)
- [ADR-026](ADR-026-orders-quotation-convention-broadening.md) (supertype-widening as additive minor)
- [ADR-028](ADR-028-orders-layer-separation.md) (document-deprecation + deferred physical split)
- [portfolio-positions-semantic-gap.md](gap/portfolio-positions-semantic-gap.md)
