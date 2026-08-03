# MD-G5: FX Rate Observation to Risk Mark Mapping Narrative

**Status**: P2 polish (continuous improvement)  
**Date**: 2026-08-03  
**Gap**: market-data-semantic-gap MD-G5

## Story

1. **Source**: FX vendor stream row `(pair, rate, quote_time, revision)`.
2. **SemanticMappingDefinition** target: `FxRateObservation` version with:
   - instrument / currency pair identity
   - `hasPriceValue` or FX-specific rate slot
   - stream role + revision axis
3. **Consumer**: `RiskMeasurement` references `measurementMarketDataStream` (see `risk-v03.yaml` referenceRecords) for mark inputs.
4. **CQ chain**: CQ-MD1 (PIT price/FX query) + CQ-R1 (exposure with market data stream ref).

## Walkthrough anchor

- Positive: `docs/domain/infrastructure/domain-shacl-runs/market-data-v03-fx-rate.ttl`
- Risk consumer: `tests/m2/fixtures/positive/risk-v03.yaml` (`referenceRecords` → `MarketDataStream`)

## Honest limits

- Dedicated CQ naming FX → risk mark is **documented** via cross-module dependency, not a separate CQ id.
- Full mapping YAML ingest for FX vendor CSV is future work.

## References

- market-data-semantic-gap MD-G5
- fin-risk CQ-R1 dependsOnElements (implicit stream consumption)
