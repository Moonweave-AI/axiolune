# M2 Review Round 16 — fin-portfolio-positions

**Date**: 2026-08-05
**Module**: `ontology/domain/finance/portfolio-positions/module.yaml`
**Version reviewed**: 1.0.0
**Disposition**: Retain; architecture revision required (P0) — implemented as v1.1.0 per ADR-029
**ADR**: [ADR-029](ADR-029-portfolio-positions-architecture.md)
**RFC**: [RFC-005](../planning/RFC-005-portfolio-positions-architecture.md)

## Review conclusion

The `fin-portfolio-positions` module should be retained; it is an indispensable boundary module of the financial domain ontology. Its "portfolio–account–holding–lot–valuation–cost-basis–reconciliation" backbone is correct and more mature than a single `Position` class. However, the v1.0.0 module expresses a very concrete operating profile (account aggregation, direct-unit-price valuation, execution-derived lots, strict closures, external reconciliation) under a generic "Portfolio and Positions" name. The review recommended converging to a generic semantic core plus an optional "direct-unit-price × quantity, execution-driven cost, strict closure, data ingestion" implementation profile, retaining the generic name (Option B).

## P0 issues (7)

| ID | Issue | ADR-029 decision |
|----|-------|------------------|
| PP-P0-01 | Identity authority missing from logical keys; stream identity conflated with contract | D1: portfolioIdentifyingAuthority in key; stream identity = (provider, streamId) |
| PP-P0-02 | Single signed quantity cannot express custody/accounting/economic views or gross long/short/net per bucket | D2: PositionScope + BalanceDimension + grossLong/Short |
| PP-P0-03 | Valuation locked to directUnitPriceTimesQuantity; no coverage closure | D3: ValuationMethodFamily + DirectUnitValuationProfile + PortfolioValuationSummary |
| PP-P0-04 | Lot locked to execution-derived opening-remainder; no lifecycle | D4: PositionChange + LotAdjustment + LotRealization + lotSourceKind |
| PP-P0-05 | External basis forced to internal definition; reconciliation missing ambiguous/resolution | D5: ReconciliationComparison/Finding/Resolution + externalBasisMethod/MappingStatus |
| PP-P0-06 | Domain facts and runtime artifacts mixed in mandatory layer | D6: document-scoped execution-and-reproducibility profile (physical split deferred) |
| PP-P0-07 | Portfolio restricted to account aggregation | D7: PortfolioConstituent + Sleeve + PortfolioConstituentKind |

## P1 issues (4)

| ID | Issue | ADR-029 decision |
|----|-------|------------------|
| PP-P1-1 | HoldingSnapshot exact vs PositionSnapshot logical stream reference | D8: observedFromStream hook; full unification deferred |
| PP-P1-2 | PositionSourceKind collapsed non-external into executionDerived | D9 (satisfied by D4): PositionSourceKind extended |
| PP-P1-3 | FXConversion lacks cross-rate, rate source, quote time, finality | D10: rateSource/quoteTime/rateDate/rateFinality/crossRatePath |
| PP-P1-4 | authorityScope free text; performance/attribution mixed in | D11: authorityScopeSubject/Role hooks; performance deferred |

## Disposition

The v1.1.0 in-place additive revision (Option B) is implemented in `ontology/domain/finance/portfolio-positions/module.yaml`:

- **All existing IRIs retained** (5 object types, 15 association types, 13 relation types, 112+ attributes, 9 original code lists, 22 original constraints) per the ADR-020..024 IRI-retention precedent.
- **New types added** (object types: ValuationMethodFamily [abstract], DirectUnitValuationProfile, Sleeve; association types: PositionChange, LotAdjustment, LotRealization, ReconciliationComparison, ReconciliationResolution, PortfolioValuationSummary, PortfolioConstituent; relation types: portfolioIdentifyingAuthority, valuationDefinitionMethodFamily).
- **New code lists added** (PositionScope, BalanceDimension, ValuationFinality, CoverageStatus, PositionChangeKind, LotAdjustmentKind, ComparisonFamily, ReconciliationComparisonResult, ReconciliationFindingKind, FindingSeverity, ResolutionKind, ExternalBasisMappingStatus, PortfolioConstituentKind, RateFinality; ValuationMethod and PositionSourceKind and PortfolioReconciliationKind extended additively).
- **Hard-locked constraints broadened** (supertype-widening + codelist admission; the locked value remains a valid profile) → v1.1.0 additive, not 2.0.0 major, per the ADR-024 D1 / ADR-026 precedent and the fixture-impact check.
- **Staging fixtures created** at `tests/m2/fixtures/positive/portfolio-positions-v11-positive.yaml` and `tests/m2/fixtures/negative/portfolio-positions-v11-negative.yaml` using the `instances:` dialect so CQ-probe loadStaging reads them.
- **CQ probes PP8..PP15 wired** in `scripts/domain/run-all-cq-probes.cjs` with staged-count reporting.
- **Sidecars updated to v1.1.0**: CQs (0.1.0→1.1.0, rewritten to use actual predicates + 8 new CQs), terminology (0.1.0→1.1.0, dropped stale Account/PositionSide/AccountType cards, added 25+ cards), alignments (0.3.0→1.1.0, 12 items), traceability (v1.1.0), gap (v1.1.0 Round-16), M2-PLAN §5.2, registry.

### Regression gate (2026-08-05, actual)

| Gate | Command | Result |
|---|---|---|
| Structural validation | `node scripts/domain/validate-m2-core.js --all --strict` | PASS — 10 modules, 0 errors |
| pySHACL domain validation | `node scripts/domain/run-domain-shacl.cjs` | PASS |
| CQ probes | `node scripts/domain/run-all-cq-probes.cjs` | PASS — 152 pass / 0 fail / 0 pending (80 CQs probed) |
| PIT validation | `node scripts/domain/validate-pit.cjs` (new fixtures) | PASS — 14 positive / 7 negative |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` | PASS — 0 projection warnings |

`test-all-domain` step 2 has a pre-existing environment-specific concurrent-IO race on Windows (documented in ADR-023 and memory) that is not caused by this revision.

## SME review

[RFC-005](../planning/RFC-005-portfolio-positions-architecture.md) records open questions Q1–Q8 with recommended answers. SME joint review (portfolio accounting + custody + valuation + reconciliation + data engineering) is outstanding; ADR-029 remains **Proposed** until sign-off. No approval is fabricated.

## Deferred follow-ups

- **ADR-030 candidate** — physical `fin-portfolio-runtime` module split (gated on RFC-005 Q6).
- **Performance-and-attribution module** — TWR/MWR, cashflow, benchmark, attribution (deferred, out of scope).
- **Corporate-action full workflow** — remains in an independent module; this revision carries only lot/position results and traceability.
