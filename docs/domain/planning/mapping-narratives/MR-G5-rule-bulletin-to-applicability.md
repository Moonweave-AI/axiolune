# MR-G5: Exchange Rule Bulletin to RuleApplicability Mapping Narrative

**Status**: P2 polish (continuous improvement)  
**Date**: 2026-08-03  
**Gap**: market-rules-semantic-gap MR-G5  
**Mapping artifact**: `mappings/finance/synthetic/rule-bulletin-semantic-mapping.yaml`

## Story (read path)

1. **Source**: exchange publishes a rule bulletin row (venue MIC, instrument class, rule code, effective interval, bulletin revision).
2. **SemanticMappingDefinition** maps bulletin `rule_code` to canonical `MarketRule` IRI (see existing `rule-applicability-cn-market.yaml` rules block).
3. **Target fact**: `RuleApplicability` version with:
   - `appliesRule` → exact rule version IRI
   - `scopedToVenue` → `TradingVenue` logical identity (MIC)
   - `appliesToInstrumentClass` → CodeList value (Equity, Future, …)
   - three-axis temporal fields from bulletin effective window
4. **Consumer CQ**: CQ-MR1 lists active applicability facts; CQ-MR2-neg rejects expired intervals.

## Walkthrough anchor

Existing positive fixtures in `tests/m2/fixtures/positive/rule-applicability-cn-market.yaml` demonstrate steps 3–4 for T+1, price limit, and close-today rules (rqalpha / vnpy evidence notes).

The bulletin mapping YAML extends step 2 with a tabular ingest narrative without changing canonical rule types.

## Honest limits (v0.3.0)

- Mapping runner for bulletin ingest is **documented only** — not wired to `run-slice-a.cjs`.
- pySHACL validates instance fixtures, not bulletin CSV ingest.

## References

- [M2-SEMANTIC-QUALITY-RUBRIC.md](../M2-SEMANTIC-QUALITY-RUBRIC.md) rubric #8
- [RFC-001](../RFC-001-m2-conformance-profile-and-domain-contract.md) SemanticMappingDefinition
