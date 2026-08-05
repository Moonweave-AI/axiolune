# Post-Trade Operations Semantic Gap

**Module**: fin-post-trade-operations
**Version**: 1.1.0 (v1.0.0 Round-12 closed; v1.1.0 Round-17 additive revision per ADR-030)
**Date**: 2026-08-05 (v1.1.0), 2026-08-03 (v1.0.0)
**Round-12**: all gaps closed at v1.0.0 (acceptance contract per RFC-001)
**Round-17**: architecture revision required for the semantically-complete claim; implemented v1.1.0 additive (ADR-030), SME sign-off on RFC-006 Q1–Q13 outstanding

## Track A (M2-PLAN scope)

- Models corporate actions, settlement instructions, reconciliation breaks, and operational exceptions as provenanced facts.
- Non-goal: replacing trading front-end order state; full custodian operational workflow automation; confirmation/affirmation/clearing/novation/netting (out of scope, traceability hooks only per ADR-030 D4).
- Largest module by type count; closes lifecycle from execution to settled/reconciled state.

## Track B (reference/ alignment)

- ISO 15022 / SWIFT settlement and corporate action messages inform SettlementInstruction and entitlement semantics.
- FIBO CAE/SEC corporate action events anchor CorporateActionEvent subtypes via terminology alignment.
- Lean settlement model and broker reconciliation patterns in NautilusTrader/vn.py inform break detection ordering.
- BIS/CPMI-IOSCO PFMI informs settlement finality (ADR-030 D3); ISO 15022 MT548/564/565/566/567 informs status and CA option lifecycle (D3/D8); DTCC affirmation and SEC T+1 inform the confirm/affirm/clear boundary (D4).

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| PTO-G1 | weak-cq | P0 | Stub CQs vs 300+ types | **Closed** - 10 active CQs (CQ-PTO1-PTO10) per ADR-018 |
| PTO-G2 | orphan-type | P1 | Exotic CA subtypes without CQ | **Closed** (v1.0.0) — ADR-018 matrix + exotic fixtures (CQ-PTO6-PTO8) |
| PTO-G3 | broken-boundary | P1 | Bilateral break negative | **Closed** - reconciliation negative fixture |
| PTO-G4 | mapping-gap | P1 | Custodian to break mapping | **Closed** - economic-allocation contract fixture |
| PTO-G5 | shallow-definition | P2 | SettlementInstruction vs status | **Closed** - settlement contract negatives |
| PTO-G6 | weak-cq | P0 | CQ probe fake PASS | **Closed** - probes stage events/findings/instructions |

### Round-17 gaps (v1.1.0, ADR-030) — architecture revision for semantically-complete claim

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| PTO-G7 | scope-mismatch | P0 | Module name/definition vs actual scope; "post-completion flows" inaccurate for CA | **Closed (v1.1.0)** — D1 definition rewritten to semantic-core + optional-profiles |
| PTO-G8 | hard-lock | P0 | DvP/FoP as the only settlement model | **Closed (v1.1.0)** — D2 SimpleDvpFopSettlementProfile; instructionLeg 1..2→1..null |
| PTO-G9 | shallow-status | P0 | SettlementStatus too narrow; settled conflated with finality | **Closed (v1.1.0)** — D3 +9 statuses; SettlementFinalityEvent + SettlementFinalityKind |
| PTO-G10 | missing-boundary | P0 | No confirm/affirm/clear/novation/netting boundary | **Closed (v1.1.0)** — D4 scope exclusion + traceability hooks |
| PTO-G11 | over-strict | P0 | Reconciliation one-to-one/zero-tolerance/strict-closure as universal | **Closed (v1.1.0)** — D5 StrictTechnicalSettlementReconciliationProfile; ReconciliationMatchGroup |
| PTO-G12 | semantic-conflict | P0 | MissingSideAssertion internal conflict (both-absent vs expectedSide vs 0/0-forbidden) | **Closed (v1.1.0)** — D6 one-sided absence; AbsenceProofKind; IncompleteSourceCoverageAssertion |
| PTO-G13 | layer-mix | P0 | Domain facts mixed with run-reproducibility evidence | **Closed (v1.1.0)** — D7 document-scoped profile annotation; physical split → ADR-031 |
| PTO-G14 | narrow-ca | P0 | CA model too narrow; due-bill as universal core | **Closed (v1.1.0)** — D8 DirectRightsDueBillCorporateActionProfile; CorporateActionOption |
| PTO-G15 | security-only-alloc | P0 | Economic-account layer supports only security quantity | **Closed (v1.1.0)** — D9 SettlementLegAllocation; CA adjustment effect hooks |
| PTO-G16 | string-identity | P1 | settlementSystem/Location as strings bearing cross-system identity | **Open (SME Q7)** — optional *IdentifierRef; full structured entity deferred |
| PTO-G17 | calendar-narrow | P1 | TradingCalendar insufficient for CSD/payment-system calendars | **Open (SME Q8)** — optional settlementCalendarKind code list |
| PTO-G18 | custody-single-hop | P1 | CustodySettlementAccountBridge single-hop only | **Open (SME Q9)** — optional upstreamCustodyBridgeRef + validFrom/To; full chain deferred |
| PTO-G19 | statement-single-day | P1 | ExternalSettlementStatement single-day single-account flow | **Open (SME Q10)** — optional statementType/coverage/asOf/book-value/correction |
| PTO-G20 | deadline-derivation | P1 | electionDeadline (date) vs policy cutoff (instant) derivation undefined | **Open (SME Q11)** — optional timezone/cutoffSource |
| PTO-G21 | coarse-disposition | P1 | ReconciliationStatus too coarse; no finding-level disposition | **Open (SME Q12)** — ReconciliationDisposition + ReconciliationDispositionKind |
| PTO-G22 | type-identity | P1 | AssociationType vs ObjectType reclassification | **Applied (SME Q13)** — identity test applied per type (ADR-030 D11); all 3 are promotion candidates; reclassification deferred to SME Q13 + follow-up ADR (cross-module identity change vs M3 baseline) |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Event/instruction keys + break identity in matrix |
| 2 | pass | Money on entitlements in contract negatives |
| 3 | pass | Subtype excludes via event-field-matrix |
| 4 | pass | Bilateral break stories in reconciliation fixture |
| 5 | pass | TemporalFact + availability in probes |
| 6 | pass | Ten active CQs (CQ-PTO1-PTO10); probes 0 pending |
| 7 | pass | ISO 15022 + FIBO CAE in bibliography |
| 8 | pass | Reconciliation mapping slice in closure fixture |

P0/P1/P2 status (Round-12 v1.0.0): closed (2026-08-03).
Round-17 P0 status: closed (v1.1.0, 2026-08-05, ADR-030 D1–D9).
Round-17 P1 status: implemented (v1.1.0 D10 + staging fixtures wired); SME confirmation of Q7–Q13 open, not blocking v1.1.0 implementation. P1-g type-identity test applied per type (D11); reclassification deferred to SME Q13 + follow-up ADR.

