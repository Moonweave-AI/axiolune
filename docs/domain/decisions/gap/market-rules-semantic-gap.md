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
