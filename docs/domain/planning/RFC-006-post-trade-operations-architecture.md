# RFC-006: `fin-post-trade-operations` Architecture SME Questions

**Status**: Open (SME joint review outstanding)
**Date**: 2026-08-05
**Related**: [ADR-030](../decisions/ADR-030-post-trade-operations-architecture.md), [M2-REVIEW-ROUND-17](../decisions/M2-REVIEW-ROUND-17.md)

## Purpose

This RFC collects the open SME-confirmation questions raised by the `fin-post-trade-operations` v1.0.0 → v1.1.0 additive revision ([ADR-030](../decisions/ADR-030-post-trade-operations-architecture.md)). Per the Moonweave governance baseline, SME sign-off on these questions is **required before ADR-030 is Accepted** and must never be fabricated. Each question is non-blocking for the v1.1.0 *implementation* (the revision is additive and IRI-retentive) but is blocking for the *Acceptance* of the semantically-complete claim.

The revision was implemented against `module.yaml` as the only ontology source of truth; external references (BIS/CPMI-IOSCO PFMI, ISO 15022 MT548/564/565/566/567, DTCC, SEC T+1) are evidence pointers awaiting SME confirmation of relevance.

## SME questions

### Q1 — Settlement finality vocabulary
`SettlementFinalityKind` is `provisional / unconditional / irrevocable`, informed by BIS/CPMI-IOSCO PFMI final settlement. Is this three-value vocabulary sufficient, or should it distinguish settlement-system finality from payment-system finality, and should `finalityRuleBasisRef` be a typed relation rather than a free uri?

### Q2 — Confirmation / affirmation / clearing / netting boundary
These concepts are out of scope in `fin-post-trade-operations` and exposed only as optional traceability hooks (`confirmationRef`, `affirmationRef`, `clearingRef`, `nettingSetRef`) on `SettlementInstruction`. Should a future dedicated module own them, and if so, should the hooks be typed relations to that module's types rather than free uri references?

### Q3 — Reconciliation match-group contract
`ReconciliationMatchGroup` admits one-to-one / one-to-many / many-to-one / many-to-many matches under non-strict profiles, while the strict profile forbids it. Is the `MatchCardinality` vocabulary and the `matchBasis` free-text field sufficient to evidence non-strict matches, or should `matchBasis` be a typed code list?

### Q4 — Reconciliation scope vocabulary
`ReconciliationScope` is currently the single value `accountDateSystem`. The generic core admits broader scopes; should the vocabulary be extended to `accountDateSystemAndValueDate` and `portfolioDateSystem`, and what are the exact closure rules for each?

### Q5 — Absence-proof strength
`AbsenceProofKind` is `deterministicSideAbsence / unknownCoverage / incompleteSourceCoverage`. The strict profile requires `deterministicSideAbsence` with a completed universe probe; the generic core admits weaker forms. Is the boundary between `MissingSideAssertion` (deterministic side absence) and `IncompleteSourceCoverageAssertion` (no conclusion) correct, and does `unknownCoverage` need its own assertion type or is it a value of `AbsenceProofKind` on `MissingSideAssertion`?

### Q6 — Physical runtime-profile split boundary
The execution-and-reproducibility profile (comparator digests, closure probes, runtime/implementation digests) is annotated in place in v1.1.0. A physical split to a `fin-post-trade-runtime` module is a candidate follow-up ADR (ADR-031). Is the proposed split boundary correct, and which constraint bindings should move with it versus stay in the core?

### Q7 — Settlement system / location identity
`settlementSystem`/`settlementLocation` remain source strings; optional `settlementSystemIdentifierRef`/`settlementLocationIdentifierRef` (uri) complement them. Should the structured form be a typed relation to a foundation `SettlementSystem`/`SettlementLocation` entity, and is that a foundation v2.x responsibility?

### Q8 — Settlement calendar kinds
`SettlementCalendarKind` is `trading / settlementSystem / paymentSystem`. Is this three-value vocabulary sufficient for CSD, payment-system, and market cut-off calendars, and should the calendar role carry an effective-period in addition to the existing `TradingCalendar`?

### Q9 — Custody chain depth
`CustodySettlementAccountBridge` gains optional `upstreamCustodyBridgeRef` (self-ref), `bridgeValidFrom`/`bridgeValidTo`. Is the self-referential chain sufficient to model global-custodian → sub-custodian → CSD, or should the bridge be reified as an ordered chain type with explicit custody-relationship mandates?

### Q10 — External statement shape
`ExternalSettlementStatement` gains optional `statementType`, `coveragePeriodStart`/`coveragePeriodEnd`, `statementAsOfTime`; lines gain `bookDate`/`valueDate`/`entryIsCorrection`/`entryIsReversal`. Is this sufficient to model a full multi-day statement, and should the statement carry a source-version semantics distinct from the snapshot digest?

### Q11 — Election deadline derivation
Event-level `electionDeadline` is a `date`; policy cutoff is an `instant`; optional `electionDeadlineTimezone`/`electionDeadlineCutoffSource` are added. Is the derivation rule from date + timezone + cutoff-source to the policy cutoff instant adequately specified, and should it be a formal contract rather than a documented derivation?

### Q12 — Finding-level disposition
`ReconciliationDisposition` carries `dispositionKind` (accepted/investigated/corrected/waived/escalated/reopened/externalPending), `remedialAction`, `waiverRef`, distinct from case-level `ReconciliationStatus`. Is the disposition workflow complete, and should `reopened` require a reference to the prior resolution?

### Q13 — ObjectType vs AssociationType identity test
The review cautioned against bulk-reclassifying AssociationTypes to ObjectTypes. The ADR-029 identity test (independent identity/version/lifecycle/evidence/parties) has been **applied per type** and documented in ADR-030 D11: `CorporateActionEvent`, `SettlementInstruction`, and `ReconciliationCase` all satisfy the test as **promotion candidates** (each has independent `authorityScopedId`/`sourceEventId` identity, TemporalFact versioning, a lifecycle, ProvenancedFact evidence, and participant-party-change semantics). The actual reclassification is **deferred to SME sign-off** because it is a cross-module identity change against the M3 v0.6.0 frozen upstream baseline and would change the OWL projection (n-ary relation → independent entity). SME question: confirm the promotion of any/all of the three, and identify the downstream-binding consequences (M3 baseline, peer consumers) to be handled by the follow-up ADR (ADR-031/032 candidate).

## Out of scope for this RFC

- Fabrication of any test, review, approval, or run result (forbidden by governance baseline).
- Physical module splits or cross-module migrations (deferred to follow-up ADRs).
- Changes to foundation, instruments, market-data, market-rules, orders-execution, or portfolio-positions (none required; all peer IRIs retained).
