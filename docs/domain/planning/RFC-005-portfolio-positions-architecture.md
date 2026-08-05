# RFC-005: `fin-portfolio-positions` Architecture — SME Review

**Status**: Awaiting SME signatures
**Date**: 2026-08-05
**ADR**: [ADR-029](../decisions/ADR-029-portfolio-positions-architecture.md)
**Review**: [M2-REVIEW-ROUND-16](../decisions/M2-REVIEW-ROUND-16.md)

This RFC records the open questions requiring Subject-Matter-Expert (SME) joint review before ADR-029 can move from **Proposed** to **Accepted**. The v1.1.0 module records recommended answers as scaffolding; **the SME signatures below are the authoritative acceptance** and are not fabricated.

## SME panel required

- Portfolio accounting (tax-lot, cost-basis methods)
- Custody / clearing (sub-balance semantics)
- Valuation (IFRS 13 / GIPS fair-value)
- Reconciliation / breaks management
- Data engineering (observation-stream contracts, closure probes)
- Corporate actions (lot-adjustment result binding)

## Open questions

### Q1. Identity-authority shape (PP-A1 / D1)

Should `portfolioIdentifyingAuthority` be a **relation** to `foundation:Party` (current scaffold) or an **attribute** (uri)? The relation form matches `membershipAuthority`/`mandateAuthority`; the attribute form is lighter. Should `PortfolioAccountMembership`/`PortfolioManagementMandate` carry an explicit `identifyingAuthority` separate from their existing authority role, or is the existing role sufficient as the identity context?

**Recommended answer**: Relation form (consistent with membership/mandate). The existing authority role doubles as identity context; no separate `identifyingAuthority` on membership/mandate.

### Q2. Balance-dimension vocabulary (PP-A2 / D2)

Is the `BalanceDimension` set (settled / pending / available / pledged / loaned / receivable / payable) closed and complete for custody+accounting+economic views? Should `grossLongQuantity`/`grossShortQuantity` be signed or absolute non-negative? Should `businessAsOf` be a date or a full datetime?

**Recommended answer**: Closed set as scaffolded; grossLong/grossShort absolute non-negative (the net signed truth stays on `positionQuantity`); `businessAsOf` datetime.

### Q3. Valuation-method families (PP-A3 / D3)

Is `ValuationMethodFamily` the right abstraction, with `DirectUnitValuationProfile` as the first concrete subtype? Which additional profiles to freeze now (mark-to-model, accrued-income, notional-based) vs defer? Should `PortfolioValuationSummary` carry cash + accrued + receivable/payable inclusion rules, or stay market-value-only?

**Recommended answer**: Family abstraction correct; freeze only `DirectUnitValuationProfile` now, defer others; `PortfolioValuationSummary` market-value-only in v1.1.0, cash/accrued inclusion deferred to the performance-and-attribution module.

### Q4. Lot source-business-event binding (PP-A4 / D4)

Should `PositionChange.sourceBusinessEvent` range over a new `foundation:BusinessEvent` type (if foundation v2.x introduces one) or over an opaque uri? Should corporate-action-result lots reference the corporate-action module's event IRI directly, or through an intermediate `LotAdjustment`? Is `lotDiscriminator` broadening to `openingRemainder | adjustedRemainder | transferredLot` sufficient, or should it be a free string?

**Recommended answer**: Opaque uri now (foundation:BusinessEvent when available); through `LotAdjustment` for traceability; broadened three-value set sufficient (free string risks identity ambiguity).

### Q5. Reconciliation resolution workflow (PP-A5 / D5)

Is the three-way `ReconciliationComparison` / `ReconciliationFinding` / `ReconciliationResolution` split correct? Should `matched` remain as a `ReconciliationFindingKind` value for compatibility, or be removed from findings (comparison-result only)? Should `ReconciliationResolution` carry a workflow state (open/in-progress/closed) or stay a single disposition?

**Recommended answer**: Three-way split correct; `matched` retained as compatibility value; single disposition with an optional follow-up resolution chain.

### Q6. Runtime-profile split boundary (PP-A6 / D6)

Should the physical `fin-portfolio-runtime` module split proceed in a follow-up ADR (ADR-030), and what is its import boundary — does it import `fin-portfolio-positions` (domain) or sit beside it? Which probe/digest fields are purely runtime-evidence (move) vs domain-closure (stay)?

**Recommended answer**: Follow-up ADR, gated; runtime imports domain; `*ProbeRef/Digest`, `toolLockRef/Digest`, `runtimeDigest`, `implementationDigest`, pagination/contract digests move; conservation `*VersionSetDigest`/`*Count` stay as domain closure evidence.

### Q7. Sleeve / constituent boundary (PP-A7 / D7)

Is `Sleeve` a first-class object type or an attribute on `PortfolioConstituent`? Should `PortfolioConstituent.constituentSubject` range be a union (Account | Portfolio | Sleeve) or a polymorphic supertype? Is `PortfolioAccountMembership` correctly retained as the account-kind specialization?

**Recommended answer**: `Sleeve` first-class (enables temporal sleeve membership); union range; `PortfolioAccountMembership` retained as account specialization.

### Q8. FX cross-rate representation (PP-A10 / D10)

Should `crossRatePath` be a uri reference to a separate `FXRateObservation` chain, or an ordered list? Is `rateFinality` (indicative / firm / settled) the right closed set? Should real-FX-trade `FXConversion` be split to a settlement module, leaving only rate-application semantics here?

**Recommended answer**: uri to a chain; `rateFinality` set correct; real-FX-trade split deferred to a settlement-module follow-up, here only rate-application.

## Sign-off table

| Question | SME | Signature | Date | Decision |
|---|---|---|---|---|
| Q1 Identity authority | | | | |
| Q2 Balance dimension | | | | |
| Q3 Valuation families | | | | |
| Q4 Lot source event | | | | |
| Q5 Reconciliation resolution | | | | |
| Q6 Runtime split | | | | |
| Q7 Sleeve/constituent | | | | |
| Q8 FX cross-rate | | | | |

**Overall ADR-029 Acceptance**: _awaiting SME signatures_

## Honest status

This document records **recommended answers** as scaffolding to accelerate SME review. No SME signature has been obtained; no approval is fabricated. ADR-029 remains **Proposed** until the sign-off table is completed by real SMEs and the regression evidence is confirmed.
