'use strict';

const {
  compareDecimalLexical,
  isDecimalLexical,
} = require('./decimal-lexical.cjs');
const {
  parseUtcInstantNanoseconds,
} = require('./instant-lexical.cjs');

const CQ_FUNCTION_VERSION = 'market-data-cq/v0.3.0';

function list(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function instant(value, label) {
  try {
    return parseUtcInstantNanoseconds(value);
  } catch {
    throw new Error(`${label} must be a calendar-valid canonical UTC instant with at most nanosecond precision`);
  }
}

function tupleKey(values) {
  return JSON.stringify(values);
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function buildIndexes(scenario) {
  if (!object(scenario)) throw new Error('market-data CQ scenario must be an object');
  const streams = new Map();
  for (const stream of list(scenario.streams)) {
    if (!stream?.id || streams.has(stream.id)) throw new Error(`duplicate or missing stream id ${String(stream?.id)}`);
    if (typeof stream.logicalIri !== 'string' || typeof stream.versionIri !== 'string') {
      throw new Error(`${stream.id} lacks stream logical/version identity`);
    }
    streams.set(stream.id, stream);
  }
  const listings = new Map();
  for (const listing of list(scenario.referenceGraph?.listings)) {
    if (!listing?.versionIri || listings.has(listing.versionIri)) {
      throw new Error(`duplicate or missing listing version ${String(listing?.versionIri)}`);
    }
    listings.set(listing.versionIri, listing);
  }
  const currencies = new Map();
  for (const currency of list(scenario.referenceGraph?.currencies)) {
    if (!currency?.logicalIri || currencies.has(currency.logicalIri)) {
      throw new Error(`duplicate or missing currency ${String(currency?.logicalIri)}`);
    }
    currencies.set(currency.logicalIri, currency);
  }
  const observations = new Map();
  for (const observation of list(scenario.observations)) {
    if (!observation?.versionIri || observations.has(observation.versionIri)) {
      throw new Error(`duplicate or missing observation version ${String(observation?.versionIri)}`);
    }
    if (!streams.has(observation.stream)) {
      throw new Error(`${observation.versionIri} references unknown stream ${String(observation.stream)}`);
    }
    if (!Number.isSafeInteger(observation.sourceOrderKey)) {
      throw new Error(`${observation.versionIri} requires a safe-integer sourceOrderKey`);
    }
    if (typeof (observation.providerObservationId || observation.sourceTradeId) !== 'string') {
      throw new Error(`${observation.versionIri} requires a provider observation/trade identifier`);
    }
    instant(observation.observedAt, `${observation.versionIri}.observedAt`);
    observations.set(observation.versionIri, observation);
  }
  const closureByTargetAxis = new Map();
  for (const closure of list(scenario.closures)) {
    const key = tupleKey([closure?.targetVersionIri, closure?.axis]);
    if (!closure?.targetVersionIri || !closure?.axis || closureByTargetAxis.has(key)) {
      throw new Error(`duplicate or invalid closure ${key}`);
    }
    closureByTargetAxis.set(key, closure);
  }
  return {
    streams,
    listings,
    currencies,
    observations,
    closureByTargetAxis,
    referenceTime: instant(scenario?.queryPivot?.referenceTime, 'referenceTime'),
  };
}

function normalizePivot(pivot, referenceTime) {
  if (!object(pivot)) throw new Error('three-axis pivot is required');
  const normalized = {
    valid: instant(pivot.asOfValid, 'asOfValid'),
    knowledge: instant(pivot.asOfKnowledge, 'asOfKnowledge'),
    available: instant(pivot.asOfAvailable, 'asOfAvailable'),
  };
  for (const [axis, value] of Object.entries(normalized)) {
    if (value > referenceTime) throw new Error(`asOf${axis[0].toUpperCase()}${axis.slice(1)} exceeds referenceTime`);
  }
  return normalized;
}

function axisEligible(from, inlineTo, closureTo, pivot, label) {
  const start = instant(from, `${label}From`);
  const ends = [inlineTo, closureTo]
    .filter((value) => value !== undefined && value !== null);
  if (ends.length > 1) throw new Error(`${label} has two competing end representations`);
  if (pivot < start) return false;
  if (ends.length === 0) return true;
  const end = instant(ends[0], `${label}To`);
  if (end <= start) throw new Error(`${label} interval must be non-empty and half-open`);
  return pivot < end;
}

function pitEligible(record, pivot, indexes) {
  if (Object.hasOwn(record?.axes || {}, 'knowledgeTo')
      || Object.hasOwn(record?.axes || {}, 'availableTo')) {
    throw new Error('canonical FactVersion forbids inline knowledgeTo/availableTo; use FactClosureAssertion');
  }
  const normalized = normalizePivot(pivot, indexes.referenceTime);
  const knowledgeClosure = indexes.closureByTargetAxis
    .get(tupleKey([record.versionIri, 'knowledge']));
  const availabilityClosure = indexes.closureByTargetAxis
    .get(tupleKey([record.versionIri, 'availability']));
  return axisEligible(
    record?.axes?.validFrom,
    record?.axes?.validTo,
    undefined,
    normalized.valid,
    'valid',
  ) && axisEligible(
    record?.axes?.knowledgeFrom,
    undefined,
    knowledgeClosure?.closedAt,
    normalized.knowledge,
    'knowledge',
  ) && axisEligible(
    record?.axes?.availableFrom,
    undefined,
    availabilityClosure?.closedAt,
    normalized.available,
    'available',
  );
}

function observationOrder(left, right, indexes) {
  const leftStream = indexes.streams.get(left.stream);
  const rightStream = indexes.streams.get(right.stream);
  if (!leftStream || !rightStream) {
    throw new Error('observation ordering references an unknown stream');
  }
  if (!Number.isSafeInteger(left.sourceOrderKey)
      || !Number.isSafeInteger(right.sourceOrderKey)) {
    throw new Error('observation ordering requires safe-integer sourceOrderKey values');
  }
  const leftSourceId = left.providerObservationId || left.sourceTradeId;
  const rightSourceId = right.providerObservationId || right.sourceTradeId;
  if (typeof leftSourceId !== 'string' || typeof rightSourceId !== 'string') {
    throw new Error('observation ordering requires a provider observation/trade identifier');
  }
  const leftTime = instant(left.observedAt, `${left.id}.observedAt`);
  const rightTime = instant(right.observedAt, `${right.id}.observedAt`);
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  const stream = compareText(leftStream.logicalIri, rightStream.logicalIri);
  if (stream !== 0) return stream;
  const sourceOrder = left.sourceOrderKey - right.sourceOrderKey;
  if (sourceOrder !== 0) return sourceOrder;
  return compareText(leftSourceId, rightSourceId);
}

function assertListedQuotationJoin(observation, query, indexes) {
  const listingVersionIri = observation?.context?.listing?.versionIri;
  const listing = indexes.listings.get(listingVersionIri);
  if (!listing
      || listing.versionIri !== query.listingVersionIri
      || listing.instrumentVersionIri !== query.instrumentVersionIri
      || listing.facilityLogicalIri !== query.facilityLogicalIri
      || observation?.context?.listing?.instrumentVersionIri !== query.instrumentVersionIri
      || observation?.observedInstrument?.versionIri !== query.instrumentVersionIri
      || observation?.quotation?.contextVersionIri !== listing.versionIri
      || observation?.quotation?.instrumentLogicalIri !== observation?.observedInstrument?.logicalIri
      || observation?.quotation?.quoteCurrency !== observation?.context?.listing?.quoteCurrency) {
    return false;
  }
  const currency = indexes.currencies.get(listing.quoteCurrencyLogicalIri);
  return Boolean(
    currency
      && currency.alphabeticCode === observation.quotation.quoteCurrency
      && currency.registryEntryVersionIri,
  );
}

function selectPrices(scenario, query) {
  const indexes = buildIndexes(scenario);
  const results = list(scenario.observations)
    .filter((observation) => observation.type === 'PriceObservation')
    .filter((observation) => observation.priceKind === query.priceKind)
    .filter((observation) => pitEligible(observation, query.pivot, indexes))
    .filter((observation) => assertListedQuotationJoin(observation, query, indexes))
    .sort((left, right) => observationOrder(left, right, indexes));
  for (const observation of results) {
    if (!isDecimalLexical(observation?.price?.amount)) {
      throw new Error(`${observation.versionIri}.price.amount must be an explicit decimal lexical value`);
    }
  }
  return results.map((observation) => ({
    versionIri: observation.versionIri,
    amount: observation.price.amount,
    currency: observation.price.currency,
    observedAt: observation.observedAt,
    validFrom: observation.axes.validFrom,
    sourceArtifactRef: observation.provenance.sourceArtifactRef,
    sourceArtifactDigest: observation.provenance.sourceArtifactDigest,
    sourceLocator: observation.provenance.sourceLocator,
  }));
}

function selectTrades(scenario, query) {
  const indexes = buildIndexes(scenario);
  const from = instant(query.from, 'from');
  const to = instant(query.to, 'to');
  if (from >= to) throw new Error('trade interval must be non-empty and half-open');
  return list(scenario.observations)
    .filter((observation) => observation.type === 'TradeObservation')
    .filter((observation) => {
      const observedAt = instant(observation.observedAt, `${observation.id}.observedAt`);
      return from <= observedAt && observedAt < to;
    })
    .filter((observation) => pitEligible(observation, query.pivot, indexes))
    .sort((left, right) => observationOrder(left, right, indexes))
    .map((observation) => ({
      versionIri: observation.versionIri,
      observedAt: observation.observedAt,
      streamLogicalIri: indexes.streams.get(observation.stream)?.logicalIri,
      sourceOrderKey: observation.sourceOrderKey,
      sourceTradeId: observation.sourceTradeId,
    }));
}

function selectLogicalVersion(scenario, logicalIri, pivot) {
  const indexes = buildIndexes(scenario);
  const selected = list(scenario.observations)
    .filter((observation) => observation.logicalIri === logicalIri)
    .filter((observation) => pitEligible(observation, pivot, indexes))
    .sort((left, right) => observationOrder(left, right, indexes));
  if (selected.length > 1) {
    throw new Error(`${logicalIri} has ${selected.length} PIT-eligible versions`);
  }
  return selected[0] || null;
}

function selectCompleteQuotes(scenario, pivot) {
  const indexes = buildIndexes(scenario);
  const selected = list(scenario.observations)
    .filter((observation) => observation.type === 'QuoteObservation')
    .filter((observation) => pitEligible(observation, pivot, indexes))
    .filter((observation) => ['bidPrice', 'bidSize', 'askPrice', 'askSize']
      .every((field) => object(observation[field])))
    .sort((left, right) => observationOrder(left, right, indexes));
  for (const observation of selected) {
    for (const field of ['bidPrice', 'askPrice']) {
      if (!isDecimalLexical(observation[field]?.amount)) {
        throw new Error(`${observation.versionIri}.${field}.amount must be an explicit decimal lexical value`);
      }
    }
    for (const field of ['bidSize', 'askSize']) {
      if (!isDecimalLexical(observation[field]?.value)) {
        throw new Error(`${observation.versionIri}.${field}.value must be an explicit decimal lexical value`);
      }
    }
  }
  return selected;
}

function validOhlc(observation, prefix) {
  const open = observation[`${prefix}OpenPrice`]?.amount;
  const high = observation[`${prefix}HighPrice`]?.amount;
  const low = observation[`${prefix}LowPrice`]?.amount;
  const close = observation[`${prefix}ClosePrice`]?.amount;
  return [open, high, low, close].every(isDecimalLexical)
    && compareDecimalLexical(low, open) <= 0
    && compareDecimalLexical(open, high) <= 0
    && compareDecimalLexical(low, close) <= 0
    && compareDecimalLexical(close, high) <= 0
    && compareDecimalLexical(low, high) <= 0;
}

function selectValidBars(scenario, pivot) {
  const indexes = buildIndexes(scenario);
  return list(scenario.observations)
    .filter((observation) => ['TradeBar', 'QuoteBar'].includes(observation.type))
    .filter((observation) => pitEligible(observation, pivot, indexes))
    .filter((observation) => observation.type === 'TradeBar'
      ? validOhlc(observation, 'trade')
      : validOhlc(observation, 'bid') && validOhlc(observation, 'ask'))
    .sort((left, right) => observationOrder(left, right, indexes));
}

function provenanceForObservation(scenario, versionIri) {
  const indexes = buildIndexes(scenario);
  const observation = indexes.observations.get(versionIri);
  if (!observation) return null;
  const stream = indexes.streams.get(observation.stream);
  if (!stream) throw new Error(`${versionIri} references unknown stream ${observation.stream}`);
  const predecessor = observation.supersedes
    ? indexes.observations.get(observation.supersedes)
    : null;
  const closure = predecessor
    ? indexes.closureByTargetAxis.get(tupleKey([predecessor.versionIri, 'knowledge']))
    : null;
  return {
    observationVersionIri: observation.versionIri,
    streamVersionIri: stream.versionIri,
    streamLogicalIri: stream.logicalIri,
    revisionMode: stream.revisionMode,
    observationIdFieldLocator: stream.mappings?.observationIdFieldLocator,
    sourceRevisionFieldLocator: stream.mappings?.sourceRevisionFieldLocator || null,
    providerObservationId: observation.providerObservationId || observation.sourceTradeId,
    sourceRevisionToken: observation.sourceRevisionToken || null,
    sourceRevisionOrder: observation.sourceRevisionOrder ?? null,
    predecessorVersionIri: predecessor?.versionIri || null,
    predecessorClosedAt: closure?.closedAt || null,
    sourceArtifactRef: observation.provenance?.sourceArtifactRef,
    sourceArtifactDigest: observation.provenance?.sourceArtifactDigest,
    sourceLocator: observation.provenance?.sourceLocator,
  };
}

function latestCloseBefore(scenario, query) {
  const cutoff = instant(query.before, 'before');
  const selected = selectPrices(scenario, {
    ...query,
    priceKind: 'close',
  }).filter((row) => instant(row.validFrom, `${row.versionIri}.validFrom`) < cutoff)
    .sort((left, right) => {
      const leftTime = instant(left.validFrom, `${left.versionIri}.validFrom`);
      const rightTime = instant(right.validFrom, `${right.versionIri}.validFrom`);
      if (leftTime < rightTime) return -1;
      if (leftTime > rightTime) return 1;
      return compareText(left.versionIri, right.versionIri);
    });
  return selected.length === 0 ? null : selected[selected.length - 1];
}

function executeCq(cqId, scenario, query) {
  if (!object(query)) throw new Error(`${cqId} query must be a closed object`);
  if (cqId === 'CQ-MD1') {
    return selectPrices(scenario, query).map((row) => ({
      versionIri: row.versionIri,
      amount: row.amount,
      currency: row.currency,
      observedAt: row.observedAt,
      validFrom: row.validFrom,
    }));
  }
  if (cqId === 'CQ-MD2') return selectTrades(scenario, query);
  if (cqId === 'CQ-MD3') {
    if (typeof query.logicalIri !== 'string'
        || !Array.isArray(query.pivots)
        || query.pivots.length === 0) {
      throw new Error('CQ-MD3 requires logicalIri and one or more named pivots');
    }
    return query.pivots.map((entry) => {
      if (!object(entry) || typeof entry.id !== 'string') {
        throw new Error('CQ-MD3 pivot entry requires an id');
      }
      const selected = selectLogicalVersion(scenario, query.logicalIri, entry.pivot);
      if (!selected) return { pivotId: entry.id, versionIri: null, amount: null };
      if (!isDecimalLexical(selected?.price?.amount)) {
        throw new Error(`${selected.versionIri}.price.amount must be an explicit decimal lexical value`);
      }
      return {
        pivotId: entry.id,
        versionIri: selected.versionIri,
        amount: selected.price.amount,
      };
    });
  }
  if (cqId === 'CQ-MD4') {
    return selectCompleteQuotes(scenario, query.pivot).map((row) => ({
      versionIri: row.versionIri,
      bidPrice: row.bidPrice.amount,
      bidSize: row.bidSize.value,
      askPrice: row.askPrice.amount,
      askSize: row.askSize.value,
    }));
  }
  if (cqId === 'CQ-MD5') {
    return selectValidBars(scenario, query.pivot).map((row) => ({
      versionIri: row.versionIri,
      type: row.type,
    }));
  }
  if (cqId === 'CQ-MD6') {
    const row = provenanceForObservation(scenario, query.versionIri);
    return row ? [row] : [];
  }
  if (cqId === 'CQ-MD7') {
    const row = latestCloseBefore(scenario, query);
    return row ? [{
      versionIri: row.versionIri,
      amount: row.amount,
      currency: row.currency,
      observedAt: row.observedAt,
      validFrom: row.validFrom,
    }] : [];
  }
  throw new Error(`unsupported Market Data CQ ${String(cqId)}`);
}

module.exports = {
  CQ_FUNCTION_VERSION,
  buildIndexes,
  executeCq,
  latestCloseBefore,
  pitEligible,
  provenanceForObservation,
  selectCompleteQuotes,
  selectLogicalVersion,
  selectPrices,
  selectTrades,
  selectValidBars,
};
