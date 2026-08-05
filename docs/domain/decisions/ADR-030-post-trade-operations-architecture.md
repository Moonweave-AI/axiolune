# ADR-030: `fin-post-trade-operations` Architecture Revision

**Status**: Proposed (v1.1.0 in-place additive revision implemented; SME joint review on RFC-006 Q1–Q13 outstanding; physical runtime-profile split deferred to follow-up ADR-031 candidate)
**Date**: 2026-08-05 (Proposed)
**Context**: Architecture review of `fin-post-trade-operations` v1.0.0 ([M2-REVIEW-ROUND-17](M2-REVIEW-ROUND-17.md))
**Related**: ADR-014 (versioning), ADR-018 (post-trade CQ coverage matrix), ADR-019 (deferred exotic corporate actions), ADR-020 (foundation Party/Currency), ADR-024 (market-structure v1.1.0 additive backbone revision precedent), ADR-026 (supertype-widening as additive minor), ADR-028 (document-deprecation + deferred physical split), ADR-029 (portfolio-positions v1.1.0 Option B precedent — core + profile layering), M2-PLAN §5.2, RFC-001, RFC-006

## Context

An independent architecture review of `fin-post-trade-operations` v1.0.0 ([M2-REVIEW-ROUND-17](M2-REVIEW-ROUND-17.md)) concluded: **retain the module; architecture revision required (P0)**. The review verified nine P0 issues and seven P1 corrections against `module.yaml` (v1.0.0, 7126 lines) and the M2-PLAN; it modified no file and ran no validator (any execution result would be marked **unverified**). The review's only source of truth for the ontology was `module.yaml`; internet material (BIS/CPMI-IOSCO PFMI, ISO 15022 MT548/564/567, DTCC affirmation, SEC T+1) was used only to calibrate industry semantics.

The module's backbone is sound — the settlement (Instruction → Leg → Allocation → Status), corporate-action (Event → Schedule → Entitlement → Election → Subscription → Adjustment), and reconciliation (Statement → Projection → Finding → Status) chains separate concerns correctly and do not collapse them into single objects. The problems are structural: the module presents a generic "Post-Trade Operations" name but locks the model to one concrete operating profile (simple DvP/FoP, direct non-transferable rights, due-bill, strict zero-tolerance reconciliation, run-level digest/probe/closure reproducibility evidence) as universal post-trade semantics, and mixes domain facts with runtime reproducibility evidence in the same mandatory layer. A genuine internal semantic conflict in `MissingSideAssertion` (definition says absent from *both* sides; `expectedSide` says the side that *should* exist; finding contract forbids 0/0) is also present.

Round-12 v1.0.0 approval stands for the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This ADR addresses the stronger claim of a *semantically complete* post-trade-operations module, which the released module does not yet satisfy. The review's central recommendation is to converge the module to a **generic semantic core** plus **optional implementation profiles** (Simple DvP/FoP, Direct Rights Due-Bill, Strict Technical Settlement Reconciliation, execution-and-reproducibility), retaining the generic name.

## Decision

**Option B (per ADR-029 precedent) — retain the generic name; revise the backbone in place now (v1.1.0, additive, IRI-retentive); introduce abstract profile families so the previously hard-locked single-method/single-policy paths become the first concrete profile; broaden the generic core with settlement finality, multi-option corporate actions, generalized leg allocation, and multi-cardinality reconciliation matching; fix the `MissingSideAssertion` semantic conflict; annotate the runtime/reproducibility evidence as a document-scoped profile (no physical module split).** The user confirmed this form (v1.1.0 additive, full resolution of all review opinions). The nine backbone P0 revisions and seven P1 documented deferrals are in place; cross-module physical migrations (runtime-module split, confirmation/affirmation/clearing/netting module) are correctly measured follow-ups, not in-place edits.

Until this ADR is **Accepted** and SME evidence is recorded for the deferred items, no cross-module runtime split or new peer module is authorized.

### D1. Module definition/scope correction (P0-1)

**Problem**: The module definition claimed to cover settlement, reconciliation, corporate action, and "other post-trade processing," but the actual settlement supported only DvP/FoP and corporate actions only cash dividend / stock split / non-transferable direct rights. "Cash and security flows once a trade has completed" is also an inaccurate CA definition: corporate actions affect record-date holders, and due-bill handles the ex-date / settlement-window boundary while trades are still settling.

**Decision**: Rewrite `module.definition` to a semantic-core + optional-profiles framing: "provides a semantic core for settlement, settlement reconciliation, and selected corporate-action servicing; Simple DvP/FoP, direct non-transferable rights subscription, due-bill, strict zero-tolerance reconciliation, and run-level digest/probe/closure reproducibility evidence are optional profiles rather than universal post-trade semantics; confirmation, affirmation, clearing, CCP novation, and netting are out of scope and exposed only as traceability hooks." The module characterizes flows *around and after* trade completion, including the entitlement economics spanning the ex-date / settlement-window boundary. Version 1.0.0 → 1.1.0.

### D2. Settlement model: DvP/FoP hard lock → profile (P0-2)

**Problem**: `SettlementInstructionContract` locked FoP to one security leg and DvP to one reciprocal security + cash leg with distinct Parties, excluding internal transfers between accounts of the same legal entity, multi-leg settlement, fee/tax legs, netting, partial settlement, multi-currency, PvP/DvD, securities lending/repo collateral, and multi-asset CA settlement.

**Decision**: Introduce `SimpleDvpFopSettlementProfile` (object type, abstract family) carrying the locked two-leg/one-leg rule. Relax `instructionLeg` cardinality on `SettlementInstruction` from `1..2` → `1..null` (additive; existing 1/2 remains valid as the first profile). `SettlementInstructionContract` keeps only core rules (deliverer ≠ receiver, cross-leg date/system/location/calendar consistency, well-formed atomic group); the DvP/FoP lock moves to `SimpleDvpFopSettlementProfileContract` (scope: Object). New `SimpleDvpFopSettlementProfileContract` and its `ConstraintBinding` added. BIS/CPMI-IOSCO PFMI (DvP/DvD/PvP distinction) informs the profile boundary.

### D3. Settlement status broadening + finality separation (P0-3)

**Problem**: `SettlementStatus` had only instructed/matched/settled/cancelled/failed — no pending, unmatched, rejected, repair, hold, partially-settled, rescheduled, reversed, buy-in, or failure cause. `settled` was conflated with legal/system finality; PFMI final settlement is irrevocable and unconditional and cannot equal a source-reported `settled`.

**Decision**: Additively extend `SettlementStatus` with `pending`, `unmatched`, `rejected`, `repair`, `hold`, `partiallySettled`, `rescheduled`, `reversed`, `buyIn` (existing 5 retained); version 1.0.0 → 1.1.0; document `settled` ≠ legal/system finality. Introduce `SettlementFinalityEvent` association carrying `finalityKind` (new code list `SettlementFinalityKind`: provisional/unconditional/irrevocable), `finalitySystem`, `finalityRuleBasisRef`, `finalityInstant`, and time-separation attributes (`originalSettlementDate`, `amendedSettlementDate`, `actualSettlementInstant`) distinct from `observedAt` and the TemporalFact knowledge/availability pivots. New `SettlementFinalityEventContract` + binding. **SME Q1** on the finality-kind vocabulary.

### D4. Confirmation/affirmation/clearing/netting boundary (P0-4)

**Problem**: No confirmation, affirmation, clearing, CCP, novation, or netting concepts existed, and no explicit statement that peer modules own them; `matched` could not simultaneously mean "both confirmed," "eligible for settlement," "cleared," or "novated."

**Decision**: Explicit scope exclusion in the module definition (D1) plus optional traceability hooks on `SettlementInstruction`: `confirmationRef`, `affirmationRef`, `clearingRef`, `nettingSetRef` (uri, 0..1) pointing to where those concepts live without modeling them. DTCC affirmation and SEC T+1 (allocation/confirmation/affirmation as distinct flows) inform the boundary. **SME Q2** on whether a future dedicated module should own them.

### D5. Reconciliation strictness → profile; multi-cardinality matching (P0-5)

**Problem**: The comparator forbade non-zero business tolerance and fuzzy reference matching; scope was locked to `accountDateSystem`; any side count >1 was a `duplicate`. This misclassifies normal business situations (one internal netted entry vs many external partial settlements, many internal rows vs one omnibus line, reference translation, cut-off, book/value-date differences, FX/fees/tax/rounding, expected timing breaks).

**Decision**: Introduce `StrictTechnicalSettlementReconciliationProfile` (object type) carrying the zero-tolerance / fuzzy-match-forbidden / any-count->1-is-duplicate rules. `SettlementReconciliationComparator` IRI retained as the strict profile's concrete instance; `SettlementReconciliationComparatorContract` broadened to make zero-tolerance and fuzzy-match-forbiddal profile-scoped. Introduce `ReconciliationMatchGroup` association admitting one-to-one/one-to-many/many-to-one/many-to-many (new code list `MatchCardinality`) with `matchBasis` and `matchGroupSubjectDigest`; `ReconciliationFindingContract` broadened so `duplicate` means "same logical business fact recorded more than once" (not "bucket count >1") and 0/0 is not a finding under the generic core. New `ReconciliationMatchGroupContract` + binding. **SME Q3** on the match-group contract; **SME Q4** on scope vocabulary.

### D6. MissingSideAssertion semantic conflict (P0-6)

**Problem**: Definition said a bucket is absent from *both* internal and external sets; `expectedSide` expressed the side that *should* exist but is empty; `ReconciliationFindingContract` forbade 0/0. These three cannot describe the same assertion.

**Decision**: Narrow `MissingSideAssertion` to one-sided absence (the requested side is absent; the opposite side is proven present by the finding's observable members). Make `absenceProbeRef/Digest` optional (0..1) so the generic core admits weaker absence proofs. Introduce `absenceProofKind` (new code list `AbsenceProofKind`: deterministicSideAbsence/unknownCoverage/incompleteSourceCoverage) on the assertion. Introduce `IncompleteSourceCoverageAssertion` association for "no rows but coverage unknown/incomplete — absence cannot be concluded." Update `MissingSideAssertionContract` to enforce one-sided absence, opposite-side presence, and the absence-proof kind; deterministic side absence with a completed universe probe is required only by the strict profile. New `IncompleteSourceCoverageAssertionContract` + binding. **SME Q5** on the absence-proof strength.

### D7. Domain facts vs run-evidence layer separation (P0-7)

**Problem**: `SettlementReconciliationComparator`, `CorporateActionElectionProviderPolicy`, and many closure/probe/digest/runtime conditions put implementation, runtime, JCS digest, input-output contracts, and source snapshots into core business semantics, so a real but not-yet-reproducibility-proven external report could not be expressed.

**Decision**: Per ADR-029 D6 precedent — document-scoped profile annotation, no physical split. Annotate in type/attribute definitions which elements belong to the **execution-and-reproducibility profile**: comparator digests/runtime/contracts/numericTolerance; election-policy digests/closure probes; election-resolution and fulfillment-closure closure probes/digests; all `*VersionSetDigest`, `*ProbeRef/Digest`, `runtimeDigest`, `implementationDigest`. Core constraints (endpoints, conservation, sign, identity, direction, authority) stay Mandatory. Profile constraints documented as "Mandatory when the execution-and-reproducibility profile is active; otherwise optional evidence" — expressed in definition text per the ADR-024 prose convention, no new YAML key. The `SettlementReconciliationComparator` definition is rewritten to mark its reproducibility fields optional in the generic core. Physical split to a `fin-post-trade-runtime` module deferred to [ADR-031](ADR-031-post-trade-runtime-profile-split.md) (deferred design, gated on SME Q6), per the ADR-028 document-deprecation precedent.

### D8. Corporate-action model broadening (P0-8)

**Problem**: Only cash dividend / stock split / non-transferable direct rights; consideration strictly mutually exclusive; no merger, redemption, conversion, tender, spin-off, exchange, transferable rights, interest, tax withholding, cash-in-lieu, reversal/correction; no multi-option lifecycle.

**Decision**: Introduce `DirectRightsDueBillCorporateActionProfile` (object type) carrying the kind restriction (cash dividend/stock split/rights issue), single-consideration, and non-transferable-direct-rights locks. `CorporateActionEventContract` broadened to core scope/date-matrix only; the kind/consideration lock moves to `DirectRightsDueBillCorporateActionProfileContract` (scope: Object). Introduce `CorporateActionOption` association with `optionKind` (new code list `CorporateActionOptionKind`: defaultOption/voluntaryElection/withdrawal/amendment/partialAllocation), option consideration, deadline, allocation ratio, default flag, and amendment-of reference, per ISO 15022 MT564/565/566/567 lifecycle. The due-bill chain is retained as a market-practice profile. New `CorporateActionOptionContract` + binding. Exotic kinds (tender/spin-off/exchange) keep ADR-019 CQ coverage (PTO6–8). **SME Q6** on the option lifecycle.

### D9. Economic-account allocation generalization (P0-9)

**Problem**: `TradeSettlementAllocation` mapped only execution quantity to a security leg; `InternalProjectionContract` permitted security only — so in omnibus custody, securities could be reconciled by beneficial account but cash legs, fees, taxes, FX, and rounding residuals could not. `CorporateActionAdjustment` produced only cash/quantity summaries, no portfolio/position/lot/cost-basis effect hooks.

**Decision**: Introduce `SettlementLegAllocation` association generalizing allocation to cash/security/fee/tax legs (new code list `SettlementLegAllocationAssetKind`), allocable to economic account with optional bridge, carrying `allocatedMoney`/`allocatedQuantity`, `allocationBasis`, residual fields, FX conversion, and rounding policy. `TradeSettlementAllocation` IRI retained as the security-only execution-driven first profile specialization. Add optional `adjustmentPortfolioEffectRef`/`adjustmentPositionEffectRef`/`adjustmentLotEffectRef`/`adjustmentCostBasisEffectRef` (uri, 0..1) to `CorporateActionAdjustment`. New `SettlementLegAllocationContract` + binding. `InternalProjectionContract`'s "security only" clause is profile-scoped. **SME Q7** on the allocation boundary.

### D10. P1 documented deferrals (P1-a..g)

Seven P1 items are implemented as lighter additive edits with SME questions, not full restructures:
- **P1-a (system/location identity)**: optional `settlementSystemIdentifierRef`/`settlementLocationIdentifierRef` (uri) complement the source strings; full structured entity deferred. **SME Q7.**
- **P1-b (calendar kinds)**: optional `settlementCalendarKind` (new code list `SettlementCalendarKind`: trading/settlementSystem/paymentSystem) on `SettlementInstruction`. **SME Q8.**
- **P1-c (custody chain)**: optional `upstreamCustodyBridgeRef` (self-ref), `bridgeValidFrom`/`bridgeValidTo` on `CustodySettlementAccountBridge`; full multi-custodian chain deferred. **SME Q9.**
- **P1-d (statement shape)**: optional `statementType` (new code list `ExternalSettlementStatementType`: holdings/transactions/pendingSettlement), `coveragePeriodStart`/`coveragePeriodEnd`, `statementAsOfTime` on `ExternalSettlementStatement`; `bookDate`/`valueDate`/`entryIsCorrection`/`entryIsReversal` on `ExternalSettlementStatementLine`. **SME Q10.**
- **P1-e (deadline derivation)**: optional `electionDeadlineTimezone`/`electionDeadlineCutoffSource` on `CorporateActionEvent`. **SME Q11.**
- **P1-f (finding disposition)**: new `ReconciliationDisposition` association with `dispositionKind` (new code list `ReconciliationDispositionKind`: accepted/investigated/corrected/waived/escalated/reopened/externalPending), `remedialAction`, `waiverRef`; case-level status retained. New `ReconciliationDispositionContract` + binding. **SME Q12.**
- **P1-g (type identity test)**: do NOT bulk-reclassify AssociationType → ObjectType. Apply the ADR-029 identity test (independent identity/version/lifecycle/evidence/parties) to `CorporateActionEvent`, `SettlementInstruction`, `ReconciliationCase` only and document the decision per type. **SME Q13.**

### D11. Type identity test results (P1-g, applied per type)

The ADR-029 identity test asks whether a type has **independent identity, version, lifecycle, evidence, and participant-party-change semantics** such that it should own its own existence (ObjectType) rather than be a relation among pre-existing entities (AssociationType). The test is applied per type below. **Decision: all three currently satisfy the identity test as candidates for promotion, but the actual reclassification is deferred to SME sign-off (RFC-006 Q13) because it is a cross-module identity change against the M3 v0.6.0 frozen upstream baseline.** No IRI is changed in v1.1.0; the three types remain `associationTypes` with their existing participantRoles until the SME-confirmed follow-up ADR authorizes the reclassification and its downstream-binding consequences.

| Type | Independent identity | Version | Lifecycle | Evidence | Participant-party changes | Test result | v1.1.0 action |
|---|---|---|---|---|---|---|---|
| `CorporateActionEvent` | yes — `sourceEventId` + source authority scope | yes — TemporalFact version, revision chain (CQ-PTO5) | yes — announcement→ex→record→payment/effective, election deadline | yes — ProvenancedFact source artifact | yes — affectedSecurity/listing/jurisdiction/facility, successorSecurity vary by event | **Promotion candidate** | deferred to SME Q13; IRI retained as associationType |
| `SettlementInstruction` | yes — `authorityScopedId` + instruction authority | yes — TemporalFact version | yes — instructed→matched→settled/cancelled/failed + rescheduled/reversed/buy-in (D3) | yes — ProvenancedFact source artifact | yes — deliverer/receiver/legs/calendar vary; confirmation/affirmation/clearing/netting hooks (D4) | **Promotion candidate** | deferred to SME Q13; IRI retained as associationType |
| `ReconciliationCase` | yes — `authorityScopedId` + case owner + internal source authority | yes — TemporalFact version | yes — open→investigating→resolved/closedNoAction + finding-level disposition (D10 P1-f) | yes — prior input context, pivots | yes — focal account, comparator, external statement, allocations vary | **Promotion candidate** | deferred to SME Q13; IRI retained as associationType |

The promotion of any of these to ObjectType would change the OWL projection (from n-ary relation to independent entity) and may affect the M3 v0.6.0 frozen upstream baseline and downstream consumers. Per the governance baseline, a cross-module identity change requires SME sign-off and is not an in-place v1.1.0 edit. The follow-up ADR (ADR-031 candidate, or a dedicated ADR-032) will authorize the reclassification once SME Q13 is resolved.

## Compatibility strategy (mirrors ADR-029)

- All existing post-trade IRIs **retained** (object/association/relation/attribute/code-list/constraint).
- New attributes optional (minCount 0) → existing data loads.
- New abstract profile families additive; locked single values remain valid as the first profile.
- Hard-locked single-value constraints **broadened** (profile-scoped), not removed; the locked value stays valid. This is v1.1.0 additive minor, **not** 2.0.0 major, because (a) no IRI removed, (b) locked value remains valid, (c) broadening is profile-internal + codelist admission, (d) fixtures use domain YAML vocabulary (fixture-impact check per ADR-023 D11). Distinguished from ADR-021 (instruments 2.0.0) major: no simultaneous new-abstract-parent + global-hard-lock-re-scope + downstream-contract-reshape.
- `MissingSideAssertion`/`SettlementReconciliationComparator`/`SettlementInstruction`/`TradeSettlementAllocation` IRIs retained as specialized/compatible aliases of their broadened families.

## Cross-module impact (none breaking)

| Peer module | Reference | Impact |
|---|---|---|
| orders-execution | Execution/Fee used by TradeSettlementAllocation | None (IRIs retained). |
| portfolio-positions | none direct (uses Execution) | None. |
| market-rules | CorporateActionScheduleRule, RuleApplicability, corporateActionKind | None (IRIs retained; CA kind broadening is additive). |
| market-data | PriceObservation | None. |
| instruments | FinancialInstrument, InstrumentListing | None. |
| foundation | Party, FinancialAccount, FinancialAccountPartyRole, Currency, TradingCalendar | None (foundation IRIs unchanged). |

## Required evidence before Acceptance (never fabricated)

- [x] P0 revisions implemented (D1–D9) in `module.yaml`; P1 documented (D10); type-identity test applied per type (D11).
- [x] Fixture-impact check confirms additive/non-breaking → v1.1.0.
- [x] v1.1.0 staging fixtures wired (`tests/m2/fixtures/positive/post-trade-v11-additive.yaml`, `tests/m2/fixtures/negative/post-trade-v11-additive-negative.yaml`); PTO11–19 probes added to `run-all-cq-probes.cjs`.
- [x] Regression gates run with **actual** results (2026-08-05):
  - `node scripts/domain/validate-m2-core.js --all --strict` → **PASS** (0 errors, 10 files)
  - `node scripts/domain/run-domain-shacl.cjs` → **PASS**
  - `node scripts/domain/run-all-cq-probes.cjs` → **PASS** (170 pass / 0 fail / 0 pending; 89 CQs probed; PTO11–19 wired)
  - `node scripts/domain/validate-pit.cjs mappings/finance/synthetic/post-trade-pit-validation-request.yaml` → **PASS** (0/0)
  - `generate-m2-shacl.cjs` / `generate-m2-owl.cjs` (post-trade) → **PASS** (0 projection warnings)
- [ ] SME joint review on [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md) Q1–Q13 — **open, not blocking**, never marked PASS without execution.
- [ ] SME confirmation of external regulatory citations (PFMI, ISO 15022 MT548/564/565/566/567, DTCC, BIS/CPMI-IOSCO, SEC T+1) as evidence pointers.
- [x] Physical runtime-profile split deferred-design ADR authored: [ADR-031](ADR-031-post-trade-runtime-profile-split.md) — not authorized for implementation until ADR-030 Accepted and Q6 SME-confirmed.
- [ ] `test-all-domain` step 2 has a known Windows concurrent-IO race (per ADR-023/memory) — not a semantic failure; documented, not a blocker.

## Sidecar fixes (implemented)

1. **CQs** ✅: extended `fin-post-trade-cq.yaml` additively (PTO11–PTO19) for internal transfer, partial/failed settlement, finality vs settled, 1:N/N:M match, zero-balance vs unobserved vs unknown-coverage, multi-option CA, withdrawal/amendment, cash/fee/tax economic allocation, custody chain, statement coverage; version 0.3.0 → 1.1.0; PTO11–19 probes wired into `run-all-cq-probes.cjs`.
2. **Terminology** ✅: added cards for new v1.1.0 types (SimpleDvpFopSettlementProfile, StrictTechnicalSettlementReconciliationProfile, DirectRightsDueBillCorporateActionProfile, SettlementFinalityEvent, CorporateActionOption, SettlementLegAllocation, ReconciliationMatchGroup, IncompleteSourceCoverageAssertion, ReconciliationDisposition) + new code lists; version bumped; stale `ReconciliationBreak` card corrected to `ReconciliationFinding`.
3. **Alignments** ✅: version 0.3.0 → 1.1.0; added PFMI (finality), ISO 15022 MT548/564/565/566/567, DTCC affirmation, BIS/CPMI-IOSCO, SEC T+1 as evidence pointers (SME confirmation of relevance pending per ADR-029 precedent).
4. **Traceability** ✅: added rows for new types/associations; version bump; regression gate table with actual 2026-08-05 results (170 pass / 89 CQs probed).
5. **Gap doc** ✅: added Round-17 P0/P1 rows (PTO-G7..G22); superseded "all gaps closed at v1.0.0" for the semantically-complete claim; v1.1.0 status section; P1-g type-identity test applied.
6. **M2-PLAN** ✅: updated §5.2 post-trade-operations responsibility row to v1.1.0 with core/profile + finality + reconciliation breadth + CA options boundary.
7. **Registry** ✅: bumped `fin-post-trade-operations` version 1.0.0 → 1.1.0 in `ontology/domain/finance/registry/module-registry.yaml`.
8. **M2-REVIEW-ROUND-17** ✅: created the review document; Disposition section referencing ADR-030 + RFC-006 SME review; regression gate date.
9. **Staging fixtures** ✅ (added): `tests/m2/fixtures/positive/post-trade-v11-additive.yaml` + `tests/m2/fixtures/negative/post-trade-v11-additive-negative.yaml` wire the new types into the CQ probes.
10. **ADR-031** ✅ (added): deferred-design ADR for the `fin-post-trade-runtime` physical profile split, gated on ADR-030 Acceptance + RFC-006 Q6.

## Status

**Proposed (v1.1.0).** The in-place additive revision (Option B) is implemented in `ontology/domain/finance/post-trade-operations/module.yaml`. The physical runtime-profile split deferred-design ADR is authored ([ADR-031](ADR-031-post-trade-runtime-profile-split.md)) and is not authorized for implementation until this ADR is Accepted and Q6 is SME-confirmed; the confirmation/affirmation/clearing/netting peer module remains deferred per [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md). Items requiring SME input remain open and are not blocking:

- **D7** — physical runtime-profile split is gated on SME review of RFC-006 Q6 and the deferred-design [ADR-031](ADR-031-post-trade-runtime-profile-split.md). The v1.1.0 module annotates the execution-and-reproducibility profile in place; the physical migration to `fin-post-trade-runtime` is deferred.
- **Q1–Q13** — finality vocabulary, confirm/affirm/clear/net boundary, match-group contract, reconciliation scope, absence-proof strength, runtime split, system/location identity, calendar kinds, custody chain, statement shape, deadline derivation, finding disposition, and type-identity test remain SME-confirmed.

### Regression evidence (actual, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 170 pass / 0 fail / 0 pending (89 CQs probed; PTO11–19 wired) |
| PIT validation | `node scripts/domain/validate-pit.cjs mappings/finance/synthetic/post-trade-pit-validation-request.yaml` | **PASS** — 0/0 (no findings) |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (post-trade) | **PASS** — 0 projection warnings |

`test-all-domain` step 2 has a pre-existing environment-specific concurrent-IO race on Windows (documented in ADR-023 and memory) that is not caused by this revision and is not a validation/semantic failure. **Actual run (2026-08-05):** `node scripts/domain/test-all-domain.js` — step 1 (validate-m2-core) PASS; step 2 (regenerate OWL/SHACL) failed with `UNKNOWN: unknown error, open '...market-data\MarketData.owl.ttl'` — the concurrent-write race fired on the **market-data** module, which this revision did not touch, confirming the race is environment-specific and not caused by the post-trade-operations v1.1.0 changes. The individual gates (validate-m2-core, run-domain-shacl, run-all-cq-probes, validate-pit, and direct generate-m2-owl/generate-m2-shacl on the post-trade module) all PASS in isolation.

## References

- [M2-REVIEW-ROUND-17](M2-REVIEW-ROUND-17.md)
- [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](../planning/M2-PLAN.md)
- [ADR-018](ADR-018-post-trade-cq-coverage-matrix.md) (post-trade CQ coverage matrix)
- [ADR-019](ADR-019-defer-exotic-corporate-actions.md) (deferred exotic corporate actions)
- [ADR-020](ADR-020-foundation-identity-architecture.md) (foundation Party/Currency)
- [ADR-024](ADR-024-market-structure-architecture.md) (v1.1.0 additive backbone revision precedent)
- [ADR-026](ADR-026-orders-quotation-convention-broadening.md) (supertype-widening as additive minor)
- [ADR-028](ADR-028-orders-layer-separation.md) (document-deprecation + deferred physical split)
- [ADR-029](ADR-029-portfolio-positions-architecture.md) (portfolio-positions v1.1.0 Option B precedent)
- [post-trade-operations-semantic-gap.md](gap/post-trade-operations-semantic-gap.md)
