# MS-G4 / F-G5: Jurisdiction Calendar Binding Mapping Narrative

**Status**: P2 polish (continuous improvement)  
**Date**: 2026-08-03  
**Gaps**: market-structure MS-G4, foundation F-G5

## Intended story

1. **Source**: jurisdiction calendar provider publishes `(jurisdiction_id, calendar_id, binding_effective_from)` rows.
2. **Mapping** produces `JurisdictionCalendarBinding` facts (planned type — not exported in v0.3.0 module YAML):
   - binds a `Jurisdiction` logical identity to a `MarketCalendar` version
   - carries three-axis effective interval
3. **Downstream**: `TradingVenue` / session facts reference calendar versions for "is market open" queries (CQ-MS3).

## v0.3.0 honest posture

- Type remains **deferred**; slice-a uses inline calendar/session negatives without a dedicated binding CQ.
- MIC venue validation and session interval negatives (CQ-MS1–MS3) cover the acceptance bar for Round-11.

## Promotion checklist (future minor)

- Export `JurisdictionCalendarBinding` in foundation or market-structure module
- Active CQ with PIT negative (binding effective after query valid time)
- SemanticMappingDefinition synthetic slice under `mappings/finance/synthetic/`

## References

- foundation-semantic-gap F-G5
- market-structure-semantic-gap MS-G4
