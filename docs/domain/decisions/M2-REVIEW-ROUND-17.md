# M2-REVIEW-ROUND-17: `fin-post-trade-operations` Architecture Review

**Date**: 2026-08-05
**Module**: fin-post-trade-operations (v1.0.0 reviewed → v1.1.0 revision per ADR-030)
**Reviewer**: Independent architecture review (user-supplied)
**Disposition**: Retain module; architecture revision required (P0) — implemented as v1.1.0 additive revision per [ADR-030](ADR-030-post-trade-operations-architecture.md), [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md) SME review outstanding.
**Ontology source of truth**: `ontology/domain/finance/post-trade-operations/module.yaml` (v1.0.0, 7126 lines). The review modified no file and ran no validator; any execution result is marked **unverified** until actually run.

## Review scope and method

The review verified nine P0 issues and seven P1 corrections against `module.yaml` and the M2-PLAN. Internet material (BIS/CPMI-IOSCO PFMI, ISO 15022 MT548/564/565/566/567, DTCC affirmation, SEC T+1) was used only to calibrate industry semantics, not as an ontology source of truth. Per the Moonweave governance baseline, repository content and web references are untrusted input; facts only were extracted.

## Conclusion

`fin-post-trade-operations` is worth retaining and has a strong business skeleton, but it is not a generic "Post-Trade Operations" ontology: it is a restricted operating profile of simplified securities DvP/FoP settlement + three corporate-action kinds + zero-tolerance, closure-proof settlement reconciliation. The core problem is not deletion but correcting scope and layering: separating generic domain facts, optional business profiles, and run-reproducible/closure evidence. The recommended convergence order is: (1) correct module boundary; (2) build generic settlement facts + status/finality layer; (3) restructure reconciliation matching and exceptions; (4) extend corporate actions and portfolio effects; (5) separate high-assurance evidence profile.

## Worth-retaining designs (confirmed)

- Settlement chain direction: `SettlementInstruction` → `SettlementLeg` → `TradeSettlementAllocation` → `SettlementStatusEvent` separates instruction, leg, account, asset, and status observation rather than collapsing them.
- `CustodySettlementAccountBridge` distinguishes economic-attribution accounts from actual custody/omnibus settlement accounts — indispensable for custody and reconciliation.
- Corporate-action chain is narratable: event, schedule determination, entitlement, election, subscription obligation, fulfillment, adjustment are separated.
- Reconciliation does not degrade to a boolean: external statement, internal projection, missing-side assertion, finding, and workflow status are distinguished.
- The emphasis on DvP atomicity, positive Money/Quantity and direction, and evidence provenance is a strength to retain as a high-assurance profile, not delete.

## P0 issues (all addressed by ADR-030 D1–D9)

| ID | Issue | ADR-030 decision |
|----|-------|-----------------|
| P0-1 | Module name/definition vs actual scope mismatch; "post-completion flows" inaccurate for CA | D1: definition rewritten to semantic-core + optional-profiles framing; scope covers ex-date/settlement-window boundary |
| P0-2 | DvP/FoP hard-locked as the only settlement model | D2: `SimpleDvpFopSettlementProfile` carries the lock; `instructionLeg` 1..2 → 1..null; core admits multi-leg/netted structures |
| P0-3 | `SettlementStatus` too narrow; `settled` conflated with finality | D3: codeList extended (+9 values); `SettlementFinalityEvent` + `SettlementFinalityKind` separate legal/system finality from reported settled; time semantics split |
| P0-4 | No confirmation/affirmation/clearing/novation/netting boundary | D4: explicit scope exclusion + optional traceability hooks on `SettlementInstruction` |
| P0-5 | Reconciliation built as one-to-one, zero-tolerance, strict-closure technical check | D5: `StrictTechnicalSettlementReconciliationProfile` carries the strict rules; `ReconciliationMatchGroup` + `MatchCardinality` admit 1:N/N:1/N:M; `duplicate` redefined |
| P0-6 | `MissingSideAssertion` internal semantic conflict (both-sides absent vs expected-side vs 0/0-forbidden) | D6: narrowed to one-sided absence; `AbsenceProofKind` + `IncompleteSourceCoverageAssertion` distinguish proven absence from no-result/unknown-coverage |
| P0-7 | Domain facts mixed with run-reproducibility evidence in the mandatory layer | D7: document-scoped profile annotation (no physical split); reproducibility fields optional in generic core; physical split → ADR-031 candidate |
| P0-8 | Corporate-action model too narrow; due-bill as universal core | D8: `DirectRightsDueBillCorporateActionProfile` carries the kind/single-consideration/non-transferable locks; `CorporateActionOption` + `CorporateActionOptionKind` add multi-option lifecycle |
| P0-9 | Economic-account layer supports only security quantity; no cash/fee/tax/cost-basis | D9: `SettlementLegAllocation` + `SettlementLegAllocationAssetKind` generalize allocation; CA adjustment gains portfolio/position/lot/cost-basis effect hooks |

## P1 issues (documented deferrals per ADR-030 D10, SME-gated)

| ID | Issue | ADR-030 decision | SME |
|----|-------|------------------|-----|
| P1-a | `settlementSystem`/`settlementLocation` as strings bearing cross-system identity | optional `*IdentifierRef` uris; full structured entity deferred | Q7 |
| P1-b | `TradingCalendar` insufficient for CSD/payment-system calendars | optional `settlementCalendarKind` code list | Q8 |
| P1-c | `CustodySettlementAccountBridge` single-hop only | optional `upstreamCustodyBridgeRef`, `bridgeValidFrom/To`; full chain deferred | Q9 |
| P1-d | `ExternalSettlementStatement` is single-day single-account flow | optional `statementType`, coverage period, as-of time, book/value dates, correction/reversal flags | Q10 |
| P1-e | event `electionDeadline` (date) vs policy cutoff (instant) derivation undefined | optional `electionDeadlineTimezone`/`electionDeadlineCutoffSource` | Q11 |
| P1-f | `ReconciliationStatus` too coarse (no finding-level disposition) | `ReconciliationDisposition` + `ReconciliationDispositionKind` | Q12 |
| P1-g | AssociationType vs ObjectType reclassification | identity test per type, no bulk rewrite | Q13 |

## Disposition

The review is **adopted** as the basis for [ADR-030](ADR-030-post-trade-operations-architecture.md) (v1.1.0 additive, Option B per ADR-029 precedent). The implementation is complete and regression-verified (see ADR-030 regression table): PTO11–19 staging fixtures wired, type-identity test applied per type (ADR-030 D11), deferred-design [ADR-031](ADR-031-post-trade-runtime-profile-split.md) authored for the physical runtime-profile split. SME sign-off on [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md) Q1–Q13 is required before ADR-030 Acceptance and is **not** fabricated. No file was modified by the review itself; all modifications are in the ADR-030 implementation.

### Regression evidence (actual, 2026-08-05, not fabricated)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | **PASS** |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 170 pass / 0 fail / 0 pending (89 CQs probed; PTO11–19 wired) |
| PIT validation | `node scripts/domain/validate-pit.cjs mappings/finance/synthetic/post-trade-pit-validation-request.yaml` | **PASS** — 0/0 |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` (post-trade) | **PASS** — 0 projection warnings |
| test-all-domain | `node scripts/domain/test-all-domain.js` | step 1 PASS; step 2 failed on **market-data** (pre-existing Windows concurrent-IO race, ADR-023/memory; not this revision, not a semantic failure) |

`test-all-domain` step 2 has a pre-existing environment-specific concurrent-IO race on Windows (documented in ADR-023 and memory); the failure fired on the untouched market-data module, confirming it is not caused by this revision. The individual gates all PASS in isolation.

## References

- [ADR-030](ADR-030-post-trade-operations-architecture.md)
- [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md)
- [ADR-018](ADR-018-post-trade-cq-coverage-matrix.md)
- [ADR-019](ADR-019-defer-exotic-corporate-actions.md)
- [ADR-029](ADR-029-portfolio-positions-architecture.md) (Option B precedent)
- [post-trade-operations-semantic-gap.md](gap/post-trade-operations-semantic-gap.md)
