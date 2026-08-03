'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  directUnitValueRaw,
  fxValueRaw,
  isValuationPrecisionPolicy,
  isValuationRoundingPolicy,
} = require('./orders-portfolio-exact-arithmetic.cjs');

const CQ_FUNCTION_VERSION = 'axiolune-m2-cq-orders-portfolio/v1';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IRI = /^(?:https?:\/\/|urn:)[^\s]+$/u;
const UTC = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u;
const FACT_COLLECTIONS = Object.freeze([
  'accounts',
  'instruments',
  'listings',
  'otcContexts',
  'mandates',
  'memberships',
  'membershipClosures',
  'holdings',
  'positions',
  'streams',
  'intents',
  'orderLineages',
  'externalOrders',
  'events',
  'executions',
  'fees',
  'quotationContracts',
  'liquidityDeterminations',
  'transitionProfiles',
  'integrityFindings',
  'positionLots',
  'lotAllocations',
  'feeAllocations',
  'allocationClosures',
  'valuationDefinitions',
  'valuationHeaders',
  'priceObservations',
  'positionValuations',
  'fxRates',
  'fxConversions',
  'closures',
]);

class CqContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'CqContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CqContractError(code, message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function array(value, label) {
  if (!Array.isArray(value)) fail('CQ_GRAPH_SCHEMA', `${label} must be an array`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('CQ_GRAPH_SCHEMA', `${label} must be a non-empty string`);
  }
  return value;
}

function iri(value, label) {
  if (typeof value !== 'string' || !IRI.test(value)) {
    fail('CQ_GRAPH_IRI', `${label} must be an absolute HTTP(S) or URN IRI`);
  }
  return value;
}

function exactVersionIri(value, label) {
  iri(value, label);
  if (!/(?:\/version\/[A-Za-z0-9._~:-]+|:v\d+)$/u.test(value)) {
    fail('CQ_GRAPH_VERSION_IRI', `${label} must be an exact version IRI`);
  }
  return value;
}

function instant(value, label) {
  const match = typeof value === 'string' ? UTC.exec(value) : null;
  if (!match) fail('CQ_TEMPORAL_LEXICAL', `${label} must be an explicit UTC dateTimeStamp with at most nanosecond precision`);
  const millis = Date.parse(`${match[1]}T${match[2]}.000Z`);
  if (Number.isNaN(millis)
      || new Date(millis).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`) {
    fail('CQ_TEMPORAL_LEXICAL', `${label} is not a real UTC calendar instant`);
  }
  const fractionalNanoseconds = BigInt((match[3] || '').padEnd(9, '0'));
  return BigInt(millis) * 1000000n + fractionalNanoseconds;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function u64be(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

function iriSetDigest(values) {
  const normalized = [...values].map((value, index) => iri(value, `IRI set[${index}]`))
    .sort(utf8Compare);
  if (new Set(normalized).size !== normalized.length) {
    fail('CQ_EXACT_SET_DUPLICATE', 'exact-version IRI set contains a duplicate');
  }
  const parts = [Buffer.from('axiolune-iri-set-v1\0', 'utf8'), u64be(normalized.length)];
  for (const value of normalized) {
    const bytes = Buffer.from(value, 'utf8');
    parts.push(u64be(bytes.length), bytes);
  }
  return `sha256:${crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator = 1n) {
  if (denominator === 0n) fail('CQ_DECIMAL_ZERO_DIVISOR', 'decimal division by zero');
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

function decimal(value, label) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    fail('CQ_DECIMAL_LEXICAL', `${label} must be a finite canonical decimal lexical value`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const numerator = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return rational(numerator, 10n ** BigInt(fraction.length));
}

function add(left, right) {
  return rational(left.n * right.d + right.n * left.d, left.d * right.d);
}

function multiply(left, right) {
  return rational(left.n * right.n, left.d * right.d);
}

function divide(left, right) {
  return rational(left.n * right.d, left.d * right.n);
}

function equal(left, right) {
  return left.n === right.n && left.d === right.d;
}

function compare(left, right) {
  const delta = left.n * right.d - right.n * left.d;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function decimalLexical(value, label = 'result') {
  let n = value.n;
  let d = value.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos += 1;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives += 1;
  }
  if (d !== 1n) fail('CQ_DECIMAL_NON_TERMINATING', `${label} is not an exact finite decimal`);
  const scale = Math.max(twos, fives);
  n *= 2n ** BigInt(scale - twos);
  n *= 5n ** BigInt(scale - fives);
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(scale + 1, '0');
  const lexical = scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/u, '');
  return `${negative ? '-' : ''}${lexical || '0'}`;
}

function sha256Jcs(value) {
  let canonical;
  try {
    canonical = canonicalJcs(value);
  } catch (cause) {
    fail('CQ_EVIDENCE_ARTIFACT', `artifact payload is not RFC 8785 JCS-compatible: ${cause.message}`);
  }
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function sha256DomainJcs(domain, value) {
  if (typeof domain !== 'string' || domain.length === 0 || domain.includes('\0')) {
    fail('CQ_DOMAIN_JCS_INPUT', 'JCS digest domain must be a non-empty NUL-free string');
  }
  let canonical;
  try {
    canonical = canonicalJcs(value);
  } catch (cause) {
    fail('CQ_DOMAIN_JCS_INPUT', `domain-separated payload is not RFC 8785 JCS-compatible: ${cause.message}`);
  }
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(`${domain}\0`, 'utf8'));
  hash.update(Buffer.from(canonical, 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function scaledInteger(value, scale, label) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 18) {
    fail('CQ_DECIMAL_SCALE', `${label} scale is outside the exact 0..18 profile`);
  }
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    fail('CQ_DECIMAL_LEXICAL', `${label} must be a finite canonical decimal lexical value`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) {
    fail('CQ_DECIMAL_SCALE', `${label} exceeds its declared scale ${scale}`);
  }
  const raw = BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  return negative ? -raw : raw;
}

function scaledRational(raw, scale) {
  return rational(raw, 10n ** BigInt(scale));
}

function exactScaledQuantity(value, scale, label, options = {}) {
  const parsed = quantity(value, label, options);
  if (value.precision !== scale) {
    fail('CQ_DECIMAL_SCALE', `${label}.precision must equal the locked quantity scale ${scale}`);
  }
  return { ...parsed, raw: scaledInteger(value.value, scale, `${label}.value`) };
}

function exactScaledMoney(value, scale, label) {
  const parsed = money(value, label);
  if (value.scale !== scale) {
    fail('CQ_DECIMAL_SCALE', `${label}.scale must equal the locked amount scale ${scale}`);
  }
  return { ...parsed, raw: scaledInteger(value.amount, scale, `${label}.amount`) };
}

function quantity(value, label, { positive = false, nonNegative = false } = {}) {
  if (!object(value)) fail('CQ_QUANTITY_SCHEMA', `${label} must be a typed Quantity object`);
  const amount = decimal(value.value, `${label}.value`);
  iri(value.unit, `${label}.unit`);
  if (positive && compare(amount, rational(0n)) <= 0) fail('CQ_QUANTITY_SIGN', `${label} must be strictly positive`);
  if (nonNegative && compare(amount, rational(0n)) < 0) fail('CQ_QUANTITY_SIGN', `${label} must be non-negative`);
  return { amount, unit: value.unit };
}

function money(value, label, { positive = false } = {}) {
  if (!object(value)) fail('CQ_MONEY_SCHEMA', `${label} must be a typed Money object`);
  const amount = decimal(value.amount, `${label}.amount`);
  if (!/^[A-Z]{3}$/u.test(value.currency || '')) {
    fail('CQ_MONEY_CURRENCY', `${label}.currency must be an uppercase alphabetic currency code`);
  }
  if (positive && compare(amount, rational(0n)) <= 0) fail('CQ_MONEY_SIGN', `${label} must be strictly positive`);
  return { amount, currency: value.currency };
}

function provenance(value, label, artifactBindings) {
  if (!object(value)) fail('CQ_PROVENANCE', `${label} requires provenance`);
  iri(value.sourceArtifactRef, `${label}.sourceArtifactRef`);
  if (!SHA256.test(value.sourceArtifactDigest || '')) {
    fail('CQ_PROVENANCE', `${label}.sourceArtifactDigest must be SHA-256`);
  }
  if (!object(value.sourceLocator)
      || value.sourceLocator.mediaType !== 'text/yaml'
      || value.sourceLocator.selectorLanguage !== 'json-pointer'
      || typeof value.sourceLocator.expression !== 'string'
      || !value.sourceLocator.expression.startsWith('/')) {
    fail('CQ_PROVENANCE', `${label}.sourceLocator must be a structured YAML JSON-Pointer locator`);
  }
  const binding = artifactBindings.get(value.sourceArtifactRef);
  if (!binding || binding.artifactDigest !== value.sourceArtifactDigest) {
    fail('CQ_PROVENANCE_BINDING', `${label} provenance does not resolve the graph's locked artifact binding`);
  }
}

function temporal(record, label, referenceTime) {
  if (!object(record.axes)) fail('CQ_TEMPORAL_AXES', `${label} requires axes`);
  if (Object.hasOwn(record.axes, 'knowledgeTo') || Object.hasOwn(record.axes, 'availableTo')) {
    fail('CQ_TEMPORAL_INLINE_END', `${label} must not store knowledgeTo/availableTo inline`);
  }
  const validFrom = instant(record.axes.validFrom, `${label}.validFrom`);
  const knowledgeFrom = instant(record.axes.knowledgeFrom, `${label}.knowledgeFrom`);
  const availableFrom = instant(record.axes.availableFrom, `${label}.availableFrom`);
  if (availableFrom < knowledgeFrom) {
    fail('CQ_TEMPORAL_AXIS_ORDER', `${label}.availableFrom must not precede knowledgeFrom`);
  }
  if (record.axes.validTo !== undefined
      && instant(record.axes.validTo, `${label}.validTo`) <= validFrom) {
    fail('CQ_TEMPORAL_INTERVAL', `${label} valid interval must be non-empty and half-open`);
  }
  if (knowledgeFrom > referenceTime || availableFrom > referenceTime) {
    fail('CQ_TEMPORAL_FUTURE_FACT', `${label} knowledge/availability exceeds graph referenceTime`);
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    fail('CQ_TEMPORAL_REVISION', `${label}.revision must be a non-negative safe integer`);
  }
}

function buildIndexes(graph) {
  if (!object(graph)) fail('CQ_GRAPH_ROOT', 'orders/portfolio CQ graph must be an object');
  const referenceTime = instant(graph.referenceTime, 'referenceTime');
  const artifactBindings = new Map();
  for (const [position, binding] of array(graph.artifactBindings, 'artifactBindings').entries()) {
    if (!object(binding)) fail('CQ_PROVENANCE_BINDING', `artifactBindings[${position}] must be an object`);
    const artifactRef = iri(binding.artifactRef, `artifactBindings[${position}].artifactRef`);
    if (artifactBindings.has(artifactRef)
        || !SHA256.test(binding.artifactDigest || '')
        || typeof binding.repositoryPath !== 'string'
        || binding.repositoryPath.startsWith('/')
        || binding.repositoryPath.includes('..')) {
      fail('CQ_PROVENANCE_BINDING', `artifactBindings[${position}] is duplicate or malformed`);
    }
    artifactBindings.set(artifactRef, binding);
  }
  const evidenceArtifacts = new Map();
  for (const [position, artifact] of array(graph.evidenceArtifacts, 'evidenceArtifacts').entries()) {
    if (!object(artifact)) fail('CQ_EVIDENCE_ARTIFACT', `evidenceArtifacts[${position}] must be an object`);
    const ref = iri(artifact.ref, `evidenceArtifacts[${position}].ref`);
    if (evidenceArtifacts.has(ref)
        || !SHA256.test(artifact.digest || '')
        || !object(artifact.payload)
        || artifact.digest !== sha256Jcs(artifact.payload)) {
      fail('CQ_EVIDENCE_ARTIFACT', `evidenceArtifacts[${position}] is duplicate, malformed, or digest-drifted`);
    }
    evidenceArtifacts.set(ref, artifact);
  }
  const collections = {};
  const byId = new Map();
  const ownership = new Map();
  for (const collectionName of FACT_COLLECTIONS) {
    const map = new Map();
    for (const [position, record] of array(graph[collectionName], collectionName).entries()) {
      if (!object(record)) fail('CQ_GRAPH_SCHEMA', `${collectionName}[${position}] must be an object`);
      const id = exactVersionIri(record.id, `${collectionName}[${position}].id`);
      const logicalId = iri(record.logicalId, `${id}.logicalId`);
      if (map.has(id) || byId.has(id)) fail('CQ_GRAPH_DUPLICATE_VERSION', `duplicate version IRI ${id}`);
      temporal(record, id, referenceTime);
      provenance(record.provenance, id, artifactBindings);
      map.set(id, record);
      byId.set(id, record);
      ownership.set(id, collectionName);
      void logicalId;
    }
    collections[collectionName] = map;
  }

  const closureByTargetAxis = new Map();
  for (const closure of collections.closures.values()) {
    exactVersionIri(closure.targetVersionIri, `${closure.id}.targetVersionIri`);
    exactVersionIri(closure.successorVersionIri, `${closure.id}.successorVersionIri`);
    if (!['knowledge', 'availability'].includes(closure.axis)) {
      fail('CQ_CLOSURE_AXIS', `${closure.id} has unsupported closure axis`);
    }
    const key = `${closure.targetVersionIri}\0${closure.axis}`;
    if (closureByTargetAxis.has(key)) fail('CQ_CLOSURE_DUPLICATE', `duplicate closure for ${key}`);
    const target = byId.get(closure.targetVersionIri);
    const successor = byId.get(closure.successorVersionIri);
    if (!target || !successor || ownership.get(target.id) !== ownership.get(successor.id)) {
      fail('CQ_CLOSURE_SUCCESSOR', `${closure.id} does not join target and successor in one fact collection`);
    }
    if (target.logicalId !== successor.logicalId || successor.revision !== target.revision + 1) {
      fail('CQ_CLOSURE_SUCCESSOR', `${closure.id} does not name the direct revision successor`);
    }
    const successorFrom = successor.axes[`${closure.axis === 'knowledge' ? 'knowledge' : 'available'}From`];
    if (closure.closedAt !== successorFrom) {
      fail('CQ_CLOSURE_BOUNDARY', `${closure.id}.closedAt must equal the successor ${closure.axis}From`);
    }
    const targetFrom = target.axes[`${closure.axis === 'knowledge' ? 'knowledge' : 'available'}From`];
    if (instant(successorFrom, `${successor.id}.${closure.axis}From`)
        <= instant(targetFrom, `${target.id}.${closure.axis}From`)) {
      fail('CQ_CLOSURE_MONOTONIC', `${closure.id} successor boundary must be strictly later than the target axis start`);
    }
    closureByTargetAxis.set(key, closure);
  }

  for (const [collectionName, map] of Object.entries(collections)) {
    if (collectionName === 'closures') continue;
    const groups = new Map();
    for (const record of map.values()) {
      const values = groups.get(record.logicalId) || [];
      values.push(record);
      groups.set(record.logicalId, values);
    }
    for (const versions of groups.values()) {
      versions.sort((left, right) => left.revision - right.revision);
      if (versions[0].revision !== 0) {
        fail('CQ_REVISION_CHAIN', `${versions[0].logicalId} revision chain must begin at zero`);
      }
      for (let index = 1; index < versions.length; index += 1) {
        const previous = versions[index - 1];
        const current = versions[index];
        if (current.revision !== previous.revision + 1) {
          fail('CQ_REVISION_CHAIN', `${current.logicalId} revision chain has a gap or branch`);
        }
        for (const axis of ['knowledge', 'availability']) {
          const closure = closureByTargetAxis.get(`${previous.id}\0${axis}`);
          if (!closure || closure.successorVersionIri !== current.id) {
            fail('CQ_CLOSURE_MISSING', `${previous.id} lacks exact ${axis} closure to ${current.id}`);
          }
        }
      }
      if (collectionName === 'events' && versions.length > 1) {
        const identity = versions[0];
        for (const version of versions.slice(1)) {
          if (version.providerEventId !== identity.providerEventId
              || version.sourceOrderKey !== identity.sourceOrderKey
              || version.observedAt !== identity.observedAt
              || version.streamVersionIri !== identity.streamVersionIri
              || version.externalOrderVersionIri !== identity.externalOrderVersionIri
              || version.orderIntentVersionIri !== identity.orderIntentVersionIri) {
            fail('CQ_EVENT_REVISION_IDENTITY', `${version.logicalId} changes immutable provider-event identity across revisions`);
          }
        }
      }
    }
  }

  validateOrderIntentLineageGraph({
    collections,
    byId,
    ownership,
    closureByTargetAxis,
  });

  const simpleIndexes = {};
  for (const name of ['accountTypeMembers', 'parties', 'portfolios']) {
    const map = new Map();
    for (const [position, record] of array(graph[name], name).entries()) {
      if (!object(record) || !record.id) fail('CQ_GRAPH_SCHEMA', `${name}[${position}] lacks id`);
      iri(record.id, `${name}[${position}].id`);
      if (map.has(record.id)) fail('CQ_GRAPH_DUPLICATE_ID', `duplicate ${name} id ${record.id}`);
      map.set(record.id, record);
    }
    simpleIndexes[name] = map;
  }
  return {
    graph,
    referenceTime,
    artifactBindings,
    evidenceArtifacts,
    collections,
    byId,
    ownership,
    closureByTargetAxis,
    ...simpleIndexes,
  };
}

function normalizePivot(query, indexes) {
  if (!object(query?.pivot)) fail('CQ_PIVOT_REQUIRED', 'query.pivot is required');
  const pivot = {
    valid: instant(query.pivot.asOfValid, 'pivot.asOfValid'),
    knowledge: instant(query.pivot.asOfKnowledge, 'pivot.asOfKnowledge'),
    availability: instant(query.pivot.asOfAvailable, 'pivot.asOfAvailable'),
  };
  for (const [axis, value] of Object.entries(pivot)) {
    if (value > indexes.referenceTime) fail('CQ_PIVOT_FUTURE', `${axis} pivot exceeds referenceTime`);
  }
  return pivot;
}

function pitEligible(record, pivot, indexes) {
  const validFrom = instant(record.axes.validFrom, `${record.id}.validFrom`);
  const validTo = record.axes.validTo === undefined
    ? undefined
    : instant(record.axes.validTo, `${record.id}.validTo`);
  const knowledgeFrom = instant(record.axes.knowledgeFrom, `${record.id}.knowledgeFrom`);
  const availableFrom = instant(record.axes.availableFrom, `${record.id}.availableFrom`);
  const knowledgeClosure = indexes.closureByTargetAxis.get(`${record.id}\0knowledge`);
  const availabilityClosure = indexes.closureByTargetAxis.get(`${record.id}\0availability`);
  const knowledgeTo = knowledgeClosure && instant(knowledgeClosure.closedAt, `${knowledgeClosure.id}.closedAt`);
  const availableTo = availabilityClosure && instant(availabilityClosure.closedAt, `${availabilityClosure.id}.closedAt`);
  return validFrom <= pivot.valid
    && (validTo === undefined || pivot.valid < validTo)
    && knowledgeFrom <= pivot.knowledge
    && (knowledgeTo === undefined || pivot.knowledge < knowledgeTo)
    && availableFrom <= pivot.availability
    && (availableTo === undefined || pivot.availability < availableTo);
}

function closedExactVersionSet(values, count, digest, code, label) {
  if (!Array.isArray(values)
      || values.length === 0
      || !Number.isSafeInteger(count)
      || count !== values.length
      || new Set(values).size !== values.length) {
    fail(code, `${label} must be a non-empty duplicate-free exact-version set with an exact count`);
  }
  for (const [position, value] of values.entries()) {
    exactVersionIri(value, `${label}[${position}]`);
    if (position > 0 && utf8Compare(values[position - 1], value) >= 0) {
      fail(code, `${label} must be strictly UTF-8 byte sorted`);
    }
  }
  if (!SHA256.test(digest || '') || digest !== iriSetDigest(values)) {
    fail(code, `${label} digest does not replay RFC section 5.8 iriSetDigest`);
  }
  return values;
}

function orderLineageKey(lineage) {
  return sha256DomainJcs('axiolune-order-intent-lineage-key-v1', {
    kind: lineage.kind,
    resultIntentVersionSetDigest: lineage.resultIntentVersionSetDigest,
    sourceIntentVersionSetDigest: lineage.sourceIntentVersionSetDigest,
  });
}

function resolveLineageIntent(versionIri, lineage, indexes) {
  const record = indexes.byId.get(versionIri);
  if (!record) {
    fail('CQ_OE11_ENDPOINT_ORPHAN', `${lineage.id} endpoint does not resolve: ${versionIri}`);
  }
  if (indexes.ownership.get(versionIri) !== 'intents') {
    fail('CQ_OE11_ENDPOINT_TYPE', `${lineage.id} endpoint is not an OrderIntent exact version: ${versionIri}`);
  }
  return record;
}

function lineageIntentSemantics(intent, lineage, lineagePivot, indexes) {
  if (!['Buy', 'Sell'].includes(intent.side)) {
    fail('CQ_OE11_ENDPOINT_SEMANTICS', `${intent.id}.side is not a reviewed OrderSide`);
  }
  const amount = quantity(intent.quantity, `${intent.id}.quantity`, { positive: true });
  const instrument = indexes.collections.instruments.get(intent.instrumentVersionIri);
  if (!instrument) {
    fail('CQ_OE11_ENDPOINT_SEMANTICS', `${intent.id}.instrumentVersionIri does not resolve an Instrument exact version`);
  }
  if (!pitEligible(intent, lineagePivot, indexes) || !pitEligible(instrument, lineagePivot, indexes)) {
    fail('CQ_OE11_ENDPOINT_PIT', `${intent.id} or its Instrument was not PIT-eligible when ${lineage.id} became available`);
  }
  return {
    amount: amount.amount,
    unit: amount.unit,
    side: intent.side,
    instrumentLogicalIri: instrument.logicalId,
    instrument,
  };
}

function validateOrderIntentLineageGraph(indexes) {
  const lineages = [...indexes.collections.orderLineages.values()]
    .sort((left, right) => utf8Compare(left.id, right.id));
  const keyDigests = new Set();
  const directedEdges = new Set();
  const adjacency = new Map();

  for (const lineage of lineages) {
    if (!['split', 'aggregation'].includes(lineage.kind)) {
      fail('CQ_OE11_BRANCH', `${lineage.id}.kind must be split or aggregation`);
    }
    closedExactVersionSet(
      lineage.sourceIntentVersionIris,
      lineage.sourceIntentCount,
      lineage.sourceIntentVersionSetDigest,
      'CQ_OE11_SOURCE_SET',
      `${lineage.id}.sourceIntentVersionIris`,
    );
    closedExactVersionSet(
      lineage.resultIntentVersionIris,
      lineage.resultIntentCount,
      lineage.resultIntentVersionSetDigest,
      'CQ_OE11_RESULT_SET',
      `${lineage.id}.resultIntentVersionIris`,
    );
    if (!((lineage.kind === 'split'
          && lineage.sourceIntentCount === 1
          && lineage.resultIntentCount >= 2)
        || (lineage.kind === 'aggregation'
          && lineage.sourceIntentCount >= 2
          && lineage.resultIntentCount === 1))) {
      fail('CQ_OE11_BRANCH', `${lineage.id} violates split 1..many or aggregation many..1 cardinality`);
    }
    if (!SHA256.test(lineage.orderLineageKeyDigest || '')
        || lineage.orderLineageKeyDigest !== orderLineageKey(lineage)) {
      fail('CQ_OE11_KEY', `${lineage.id}.orderLineageKeyDigest does not bind kind and both exact endpoint sets`);
    }
    if (lineage.sourceIntentVersionIris.some(
      (versionIri) => lineage.resultIntentVersionIris.includes(versionIri),
    )) {
      fail('CQ_OE11_SELF_EDGE', `${lineage.id} source and result endpoint sets overlap`);
    }
    for (const forbidden of ['reservation', 'reservationId', 'accountBlock', 'blockedAmount']) {
      if (Object.hasOwn(lineage, forbidden)) {
        fail('CQ_OE11_FORBIDDEN_RUNTIME', `${lineage.id}.${forbidden} is runtime state, not immutable M2 lineage`);
      }
    }

    const lineagePivot = {
      valid: instant(lineage.axes.validFrom, `${lineage.id}.validFrom`),
      knowledge: instant(lineage.axes.knowledgeFrom, `${lineage.id}.knowledgeFrom`),
      availability: instant(lineage.axes.availableFrom, `${lineage.id}.availableFrom`),
    };
    const sourceIntents = lineage.sourceIntentVersionIris.map(
      (versionIri) => resolveLineageIntent(versionIri, lineage, indexes),
    );
    const resultIntents = lineage.resultIntentVersionIris.map(
      (versionIri) => resolveLineageIntent(versionIri, lineage, indexes),
    );
    const sourceSemantics = sourceIntents.map(
      (intent) => lineageIntentSemantics(intent, lineage, lineagePivot, indexes),
    );
    const resultSemantics = resultIntents.map(
      (intent) => lineageIntentSemantics(intent, lineage, lineagePivot, indexes),
    );
    const semantics = [...sourceSemantics, ...resultSemantics];
    const first = semantics[0];
    if (!semantics.every((value) => value.instrumentLogicalIri === first.instrumentLogicalIri
        && value.side === first.side
        && value.unit === first.unit)) {
      fail('CQ_OE11_ENDPOINT_SEMANTICS', `${lineage.id} endpoints disagree on instrument, side, or Quantity unit`);
    }
    const sourceQuantity = sourceSemantics.reduce(
      (sum, value) => add(sum, value.amount),
      rational(0n),
    );
    const resultQuantity = resultSemantics.reduce(
      (sum, value) => add(sum, value.amount),
      rational(0n),
    );
    if (!equal(sourceQuantity, resultQuantity)) {
      fail('CQ_OE11_QUANTITY_CONSERVATION', `${lineage.id} exact source and result Quantity sums differ`);
    }

    if (keyDigests.has(lineage.orderLineageKeyDigest)) {
      fail('CQ_OE11_DUPLICATE_KEY', `${lineage.id} repeats an immutable transformation key`);
    }
    keyDigests.add(lineage.orderLineageKeyDigest);
    for (const sourceVersionIri of lineage.sourceIntentVersionIris) {
      const targets = adjacency.get(sourceVersionIri) || new Set();
      for (const resultVersionIri of lineage.resultIntentVersionIris) {
        const edge = `${sourceVersionIri}\0${resultVersionIri}`;
        if (directedEdges.has(edge)) {
          fail('CQ_OE11_DUPLICATE_EDGE', `${lineage.id} repeats directed edge ${sourceVersionIri} -> ${resultVersionIri}`);
        }
        directedEdges.add(edge);
        targets.add(resultVersionIri);
      }
      adjacency.set(sourceVersionIri, targets);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) fail('CQ_OE11_CYCLE', `OrderIntent lineage graph contains a directed cycle through ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) || []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of adjacency.keys()) visit(node);
}

function exactRecord(map, versionIri, code, label) {
  exactVersionIri(versionIri, label);
  const record = map.get(versionIri);
  if (!record) fail(code, `${label} does not resolve: ${versionIri}`);
  return record;
}

function eligibleExact(map, versionIri, pivot, indexes, code, label) {
  const record = exactRecord(map, versionIri, code, label);
  if (!pitEligible(record, pivot, indexes)) fail(code, `${versionIri} is not PIT-eligible`);
  return record;
}

function occurrenceOrder(left, right) {
  const time = instant(left.observedAt, `${left.id}.observedAt`)
    - instant(right.observedAt, `${right.id}.observedAt`);
  if (time < 0n) return -1;
  if (time > 0n) return 1;
  if (!Number.isSafeInteger(left.sourceOrderKey) || !Number.isSafeInteger(right.sourceOrderKey)) {
    fail('CQ_OE_EVENT_ORDER_KEY', 'event ordering requires safe-integer sourceOrderKey');
  }
  const key = left.sourceOrderKey - right.sourceOrderKey;
  if (key !== 0) return key;
  return utf8Compare(left.providerEventId, right.providerEventId);
}

function requirePitDependencies(records, pivot, indexes, code) {
  if (!pivot) return;
  for (const record of records) {
    if (!pitEligible(record, pivot, indexes)) {
      fail(code, `${record.id} in an exact join is not PIT-eligible`);
    }
  }
}

function eventJoin(event, indexes, code, pivot) {
  const stream = exactRecord(indexes.collections.streams, event.streamVersionIri, code, `${event.id}.streamVersionIri`);
  const external = exactRecord(indexes.collections.externalOrders, event.externalOrderVersionIri, code, `${event.id}.externalOrderVersionIri`);
  const intent = exactRecord(indexes.collections.intents, event.orderIntentVersionIri, code, `${event.id}.orderIntentVersionIri`);
  if (stream.externalOrderVersionIri !== external.id
      || external.originatingIntentVersionIri !== intent.id) {
    fail(code, `${event.id} does not form Stream -> ExternalOrder -> OrderIntent exact join`);
  }
  requirePitDependencies([stream, external, intent], pivot, indexes, code);
  if (event.observedAt !== event.axes.validFrom) {
    fail(code, `${event.id}.observedAt must equal its occurrence/validFrom axis`);
  }
  if (!Number.isSafeInteger(event.sourceOrderKey) || event.sourceOrderKey < 0
      || typeof event.providerEventId !== 'string' || event.providerEventId.length === 0) {
    fail(code, `${event.id} lacks immutable provider event ordering identity`);
  }
  return { stream, external, intent };
}

function executionJoin(execution, indexes, code, pivot) {
  if (![execution.executionPartyLogicalIri, execution.contraPartyLogicalIri,
    execution.contraAccountVersionIri].every((value) => typeof value === 'string' && IRI.test(value))) {
    fail(code, `${execution.id} requires explicit principal Party, contra Party, and contra account roles`);
  }
  const stream = exactRecord(indexes.collections.streams, execution.streamVersionIri, code, `${execution.id}.streamVersionIri`);
  const external = exactRecord(indexes.collections.externalOrders, execution.externalOrderVersionIri, code, `${execution.id}.externalOrderVersionIri`);
  const intent = exactRecord(indexes.collections.intents, execution.orderIntentVersionIri, code, `${execution.id}.orderIntentVersionIri`);
  const account = exactRecord(indexes.collections.accounts, execution.accountVersionIri, code, `${execution.id}.accountVersionIri`);
  const contraAccount = exactRecord(indexes.collections.accounts, execution.contraAccountVersionIri, code, `${execution.id}.contraAccountVersionIri`);
  const instrument = exactRecord(indexes.collections.instruments, execution.instrumentVersionIri, code, `${execution.id}.instrumentVersionIri`);
  const executionPartyIri = iri(execution.executionPartyLogicalIri, `${execution.id}.executionPartyLogicalIri`);
  const contraPartyIri = iri(execution.contraPartyLogicalIri, `${execution.id}.contraPartyLogicalIri`);
  const executionParty = indexes.parties.get(executionPartyIri);
  const contraParty = indexes.parties.get(contraPartyIri);
  if (!executionParty || !contraParty) {
    fail(code, `${execution.id} principal or contra Party does not resolve`);
  }
  let executingBroker = null;
  if (execution.executingBrokerLogicalIri !== undefined) {
    const executingBrokerIri = iri(execution.executingBrokerLogicalIri, `${execution.id}.executingBrokerLogicalIri`);
    executingBroker = indexes.parties.get(executingBrokerIri);
    if (!executingBroker) fail(code, `${execution.id} executing broker Party does not resolve`);
  }
  if (stream.externalOrderVersionIri !== external.id
      || external.originatingIntentVersionIri !== intent.id
      || intent.accountVersionIri !== account.id
      || intent.instrumentVersionIri !== instrument.id) {
    fail(code, `${execution.id} does not form Execution -> Stream/ExternalOrder/Intent/Account/Instrument exact join`);
  }
  requirePitDependencies([stream, external, intent, account, contraAccount, instrument], pivot, indexes, code);
  const observedAt = instant(execution.observedAt, `${execution.id}.observedAt`);
  if (observedAt !== instant(execution.axes.validFrom, `${execution.id}.validFrom`)) {
    fail(code, `${execution.id}.observedAt must equal occurrence/validFrom`);
  }
  const executedQuantity = quantity(execution.quantity, `${execution.id}.quantity`, { positive: true });
  const executedPrice = money(execution.price, `${execution.id}.price`, { positive: true });
  return {
    stream, external, intent, account, contraAccount, executionParty, contraParty,
    executingBroker, instrument, observedAt, executedQuantity, executedPrice,
  };
}

function executeOe2(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const intent = eligibleExact(indexes.collections.intents, query.orderIntentVersionIri, pivot, indexes, 'CQ_OE2_INTENT', 'orderIntentVersionIri');
  const externalOrders = [...indexes.collections.externalOrders.values()]
    .filter((record) => record.originatingIntentVersionIri === intent.id)
    .filter((record) => pitEligible(record, pivot, indexes));
  const rows = [];
  for (const external of externalOrders) {
    if (typeof external.externalOrderId !== 'string' || external.externalOrderId.length === 0) {
      fail('CQ_OE2_EXTERNAL_ID', `${external.id} lacks provider-scoped externalOrderId`);
    }
    const acceptances = [...indexes.collections.events.values()]
      .filter((event) => event.orderIntentVersionIri === intent.id && event.state === 'Accepted')
      .filter((event) => pitEligible(event, pivot, indexes));
    if (acceptances.filter((event) => event.externalOrderVersionIri === external.id).length > 1) {
      fail('CQ_OE2_ACCEPTANCE_CARDINALITY', `${external.id} has more than one PIT-eligible acceptance event`);
    }
    for (const event of acceptances) {
      eventJoin(event, indexes, 'CQ_OE2_ACCEPTANCE_CHAIN', pivot);
      if (event.externalOrderVersionIri !== external.id) {
        fail('CQ_OE2_ACCEPTANCE_CHAIN', `${event.id} acceptance points to a different ExternalOrder`);
      }
      rows.push({
        orderIntentVersionIri: intent.id,
        externalOrderVersionIri: external.id,
        externalOrderId: external.externalOrderId,
        acceptanceEventVersionIri: event.id,
        providerEventId: event.providerEventId,
        acceptedAt: event.observedAt,
      });
    }
  }
  return rows.sort((left, right) => utf8Compare(left.acceptanceEventVersionIri, right.acceptanceEventVersionIri));
}

function quotationForExecution(execution, indexes, pivot, code) {
  const contract = eligibleExact(
    indexes.collections.quotationContracts,
    execution.quotationContractVersionIri,
    pivot,
    indexes,
    code,
    `${execution.id}.quotationContractVersionIri`,
  );
  const quantityValue = quantity(execution.quantity, `${execution.id}.quantity`, { positive: true });
  const priceValue = money(execution.price, `${execution.id}.price`, { positive: true });
  const contexts = [execution.listingVersionIri, execution.otcContextVersionIri]
    .filter((value) => value !== undefined);
  if (contexts.length !== 1) fail(code, `${execution.id} must select listing xone OTC context`);
  if (execution.listingVersionIri !== undefined) {
    const listing = eligibleExact(
      indexes.collections.listings,
      execution.listingVersionIri,
      pivot,
      indexes,
      code,
      `${execution.id}.listingVersionIri`,
    );
    if (listing.instrumentVersionIri !== execution.instrumentVersionIri) {
      fail(code, `${execution.id} listing resolves a different instrument`);
    }
  } else {
    eligibleExact(
      indexes.collections.otcContexts,
      execution.otcContextVersionIri,
      pivot,
      indexes,
      code,
      `${execution.id}.otcContextVersionIri`,
    );
  }
  if (contract.contextVersionIri !== contexts[0]
      || contract.instrumentLogicalIri !== execution.instrumentLogicalIri
      || contract.quoteCurrency !== priceValue.currency
      || contract.denominatorUnit !== quantityValue.unit) {
    fail(code, `${execution.id} has no exact direct-unit quotation application`);
  }
  return contract;
}

function executeOe3(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const intent = eligibleExact(indexes.collections.intents, query.orderIntentVersionIri, pivot, indexes, 'CQ_OE3_INTENT', 'orderIntentVersionIri');
  const executions = [...indexes.collections.executions.values()]
    .filter((execution) => execution.orderIntentVersionIri === intent.id)
    .filter((execution) => pitEligible(execution, pivot, indexes));
  if (executions.length === 0) return [];
  let totalQuantity = rational(0n);
  let totalNotional = rational(0n);
  let unit;
  let currency;
  let context;
  const versions = [];
  for (const execution of executions) {
    executionJoin(execution, indexes, 'CQ_OE3_EXECUTION_JOIN', pivot);
    const contract = quotationForExecution(execution, indexes, pivot, 'CQ_OE3_QUOTATION_CONTEXT');
    const q = quantity(execution.quantity, `${execution.id}.quantity`, { positive: true });
    const p = money(execution.price, `${execution.id}.price`, { positive: true });
    unit ??= q.unit;
    currency ??= p.currency;
    context ??= contract.contextVersionIri;
    if (q.unit !== unit) fail('CQ_OE3_QUANTITY_UNIT', 'executions cannot be aggregated across Quantity units');
    if (p.currency !== currency) fail('CQ_OE3_PRICE_CURRENCY', 'VWAP cannot silently mix Money currencies');
    if (contract.contextVersionIri !== context) fail('CQ_OE3_QUOTATION_CONTEXT', 'VWAP requires one exact quotation context');
    totalQuantity = add(totalQuantity, q.amount);
    totalNotional = add(totalNotional, multiply(q.amount, p.amount));
    versions.push(execution.id);
  }
  return [{
    orderIntentVersionIri: intent.id,
    executionVersionIris: versions.sort(utf8Compare),
    totalQuantity: { value: decimalLexical(totalQuantity, 'total executed Quantity'), unit },
    volumeWeightedPrice: { amount: decimalLexical(divide(totalNotional, totalQuantity), 'VWAP'), currency },
    quotationContextVersionIri: context,
  }];
}

function executeOe4(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const execution = eligibleExact(indexes.collections.executions, query.executionVersionIri, pivot, indexes, 'CQ_OE4_EXECUTION', 'executionVersionIri');
  const join = executionJoin(execution, indexes, 'CQ_OE4_TRACE_CHAIN', pivot);
  const events = [...indexes.collections.events.values()]
    .filter((event) => event.externalOrderVersionIri === join.external.id
      && event.orderIntentVersionIri === join.intent.id
      && event.streamVersionIri === join.stream.id)
    .filter((event) => pitEligible(event, pivot, indexes))
    .sort(occurrenceOrder);
  if (events.length === 0) fail('CQ_OE4_LIFECYCLE_EMPTY', `${execution.id} has no immutable lifecycle audit chain`);
  const selectedLogicalEvents = new Set();
  for (const event of events) {
    eventJoin(event, indexes, 'CQ_OE4_TRACE_CHAIN', pivot);
    if (selectedLogicalEvents.has(event.logicalId)) {
      fail('CQ_OE4_OVERLAPPING_EVENT_REVISIONS', `${event.logicalId} has multiple PIT-eligible exact versions`);
    }
    selectedLogicalEvents.add(event.logicalId);
  }
  return [{
    executionVersionIri: execution.id,
    accountVersionIri: join.account.id,
    accountLogicalIri: join.account.logicalId,
    executionPartyLogicalIri: join.executionParty.id,
    contraAccountVersionIri: join.contraAccount.id,
    contraAccountLogicalIri: join.contraAccount.logicalId,
    contraPartyLogicalIri: join.contraParty.id,
    ...(join.executingBroker ? { executingBrokerLogicalIri: join.executingBroker.id } : {}),
    streamVersionIri: join.stream.id,
    externalOrderVersionIri: join.external.id,
    externalOrderId: join.external.externalOrderId,
    orderIntentVersionIri: join.intent.id,
    lifecycleEvents: events.map((event) => ({
      eventVersionIri: event.id,
      providerEventId: event.providerEventId,
      sourceOrderKey: event.sourceOrderKey,
      state: event.state,
      observedAt: event.observedAt,
    })),
  }];
}

function executeOe6(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const profile = eligibleExact(indexes.collections.transitionProfiles, query.transitionProfileVersionIri, pivot, indexes, 'CQ_OE6_PROFILE', 'transitionProfileVersionIri');
  const intent = eligibleExact(indexes.collections.intents, query.orderIntentVersionIri, pivot, indexes, 'CQ_OE6_INTENT', 'orderIntentVersionIri');
  if (!object(profile.transitions) || !Array.isArray(profile.terminalStates)) {
    fail('CQ_OE6_PROFILE_SCHEMA', `${profile.id} lacks closed transition and terminal-state sets`);
  }
  const events = [...indexes.collections.events.values()]
    .filter((event) => event.orderIntentVersionIri === intent.id)
    .filter((event) => pitEligible(event, pivot, indexes))
    .sort(occurrenceOrder);
  for (const event of events) {
    const join = eventJoin(event, indexes, 'CQ_OE6_EVENT_CHAIN', pivot);
    if (profile.providerLogicalIri !== join.stream.providerLogicalIri) {
      fail('CQ_OE6_PROFILE_SCOPE', `${profile.id} does not govern ${join.stream.id}`);
    }
  }
  const counterexamples = [];
  for (let index = 1; index < events.length; index += 1) {
    const from = events[index - 1];
    const to = events[index];
    const allowed = Array.isArray(profile.transitions[from.state]) ? profile.transitions[from.state] : [];
    if (!allowed.includes(to.state) || profile.terminalStates.includes(from.state)) {
      const findings = [...indexes.collections.integrityFindings.values()].filter(
        (finding) => finding.kind === 'transitionViolation'
          && finding.fromEventVersionIri === from.id
          && finding.toEventVersionIri === to.id
          && finding.transitionProfileVersionIri === profile.id,
      );
      if (findings.length !== 1 || !pitEligible(findings[0], pivot, indexes)) {
        fail('CQ_OE6_MISSING_FINDING', `transition ${from.state} -> ${to.state} lacks one PIT-eligible transitionViolation finding`);
      }
      counterexamples.push({
        fromEventVersionIri: from.id,
        fromState: from.state,
        toEventVersionIri: to.id,
        toState: to.state,
        findingVersionIri: findings[0].id,
      });
    }
  }
  return [{
    orderIntentVersionIri: intent.id,
    transitionProfileVersionIri: profile.id,
    compliant: counterexamples.length === 0,
    orderedEventVersionIris: events.map((event) => event.id),
    counterexamples,
  }];
}

function validateDetermination(determination, execution, stream) {
  if (determination.executionVersionIri !== execution.id
      || determination.streamVersionIri !== stream.id
      || determination.perspective !== 'executionAccountOrder') {
    fail('CQ_OE7_LIQUIDITY_PERSPECTIVE', 'liquidity determination is not bound to the Execution account/order perspective');
  }
  if (determination.result === 'classified') {
    if (!['maker', 'taker', 'auctionUndefined'].includes(determination.role)
        || !IRI.test(determination.sourceRecordRef || '')
        || !SHA256.test(determination.sourceRecordDigest || '')
        || typeof determination.rawFieldLocator !== 'string'
        || typeof determination.rawLexicalValue !== 'string'
        || !IRI.test(determination.mappingVersionIri || '')) {
      fail('CQ_OE7_LIQUIDITY_EVIDENCE', 'classified liquidity determination lacks exact raw-record/mapping evidence');
    }
  } else if (determination.result === 'unavailable') {
    if (!['contractUnsupported', 'providerNotSpecified'].includes(determination.unavailableReason)) {
      fail('CQ_OE7_LIQUIDITY_EVIDENCE', 'unavailable liquidity has an unreviewed reason');
    }
  } else {
    fail('CQ_OE7_LIQUIDITY_EVIDENCE', 'liquidity determination must be classified or unavailable');
  }
}

function executeOe7(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const execution = eligibleExact(indexes.collections.executions, query.executionVersionIri, pivot, indexes, 'CQ_OE7_EXECUTION', 'executionVersionIri');
  const join = executionJoin(execution, indexes, 'CQ_OE7_EXECUTION_JOIN', pivot);
  const quotation = quotationForExecution(execution, indexes, pivot, 'CQ_OE7_QUOTATION');
  const determinations = [...indexes.collections.liquidityDeterminations.values()]
    .filter((candidate) => candidate.executionVersionIri === execution.id)
    .filter((candidate) => pitEligible(candidate, pivot, indexes));
  if (determinations.length !== 1) fail('CQ_OE7_LIQUIDITY_CARDINALITY', `${execution.id} requires exactly one PIT-eligible LiquidityRoleDetermination`);
  validateDetermination(determinations[0], execution, join.stream);

  const fees = [...indexes.collections.fees.values()]
    .filter((fee) => fee.executionVersionIri === execution.id)
    .filter((fee) => pitEligible(fee, pivot, indexes));
  const allocations = [...indexes.collections.lotAllocations.values()]
    .filter((allocation) => allocation.executionVersionIri === execution.id)
    .filter((allocation) => pitEligible(allocation, pivot, indexes));
  const feeAllocations = [...indexes.collections.feeAllocations.values()]
    .filter((allocation) => allocations.some((lotAllocation) => lotAllocation.id === allocation.lotAllocationVersionIri))
    .filter((allocation) => pitEligible(allocation, pivot, indexes));
  const closures = [...indexes.collections.allocationClosures.values()]
    .filter((closure) => closure.executionVersionIri === execution.id)
    .filter((closure) => pitEligible(closure, pivot, indexes));
  if (closures.length !== 1) fail('CQ_OE7_ALLOCATION_CLOSURE', `${execution.id} requires exactly one allocation closure`);
  const closure = closures[0];
  const expectedSets = [
    ['allocation', closure.allocationVersionIris, allocations.map((value) => value.id), closure.allocationVersionSetDigest],
    ['fee', closure.feeVersionIris, fees.map((value) => value.id), closure.feeVersionSetDigest],
    ['fee allocation', closure.feeAllocationVersionIris, feeAllocations.map((value) => value.id), closure.feeAllocationVersionSetDigest],
  ];
  for (const [label, declared, actual, digest] of expectedSets) {
    if (!Array.isArray(declared)
        || declared.length !== actual.length
        || [...declared].sort(utf8Compare).some((value, index) => value !== [...actual].sort(utf8Compare)[index])
        || digest !== iriSetDigest(actual)) {
      fail('CQ_OE7_ALLOCATION_CLOSURE', `${label} exact-version closure is incomplete or has the wrong digest`);
    }
  }

  const executedQuantity = quantity(execution.quantity, `${execution.id}.quantity`, { positive: true });
  const executedPrice = money(execution.price, `${execution.id}.price`, { positive: true });
  let allocatedQuantity = rational(0n);
  for (const allocation of allocations) {
    const lot = exactRecord(
      indexes.collections.positionLots,
      allocation.lotVersionIri,
      'CQ_OE7_POSITION_LOT_JOIN',
      `${allocation.id}.lotVersionIri`,
    );
    if (allocation.kind !== 'opening'
        || lot.openingExecutionVersionIri !== execution.id
        || lot.openingAllocationVersionIri !== allocation.id
        || lot.accountVersionIri !== execution.accountVersionIri
        || lot.instrumentVersionIri !== execution.instrumentVersionIri) {
      fail('CQ_OE7_POSITION_LOT_JOIN', `${allocation.id} does not form the exact opening PositionLot join`);
    }
    const allocated = quantity(allocation.quantity, `${allocation.id}.quantity`, { positive: true });
    const original = quantity(lot.originalQuantity, `${lot.id}.originalQuantity`, { positive: true });
    if (allocated.unit !== executedQuantity.unit) fail('CQ_OE7_ALLOCATION_UNIT', `${allocation.id} Quantity unit differs from Execution`);
    if (original.unit !== allocated.unit || !equal(original.amount, allocated.amount)) {
      fail('CQ_OE7_POSITION_LOT_JOIN', `${lot.id} original Quantity differs from its sole opening allocation`);
    }
    const gross = money(allocation.gross, `${allocation.id}.gross`, { positive: true });
    const basis = money(allocation.costBasis, `${allocation.id}.costBasis`);
    const lotGross = money(lot.openingGross, `${lot.id}.openingGross`, { positive: true });
    const lotBasis = money(lot.openingCostBasis, `${lot.id}.openingCostBasis`);
    if (gross.currency !== executedPrice.currency || basis.currency !== executedPrice.currency
        || !equal(gross.amount, multiply(allocated.amount, executedPrice.amount))) {
      fail('CQ_OE7_COST_BASIS', `${allocation.id} direct-unit opening gross is inconsistent`);
    }
    if (lotGross.currency !== gross.currency || lotBasis.currency !== basis.currency
        || !equal(lotGross.amount, gross.amount) || !equal(lotBasis.amount, basis.amount)) {
      fail('CQ_OE7_POSITION_LOT_JOIN', `${lot.id} does not copy the exact opening gross/cost basis`);
    }
    let feeEffect = rational(0n);
    for (const feeAllocation of feeAllocations.filter((candidate) => candidate.lotAllocationVersionIri === allocation.id)) {
      const fee = exactRecord(indexes.collections.fees, feeAllocation.feeVersionIri, 'CQ_OE7_FEE_JOIN', `${feeAllocation.id}.feeVersionIri`);
      const amount = money(feeAllocation.amount, `${feeAllocation.id}.amount`, { positive: true });
      const feeAmount = money(fee.amount, `${fee.id}.amount`, { positive: true });
      if (!['charge', 'rebate'].includes(fee.effect)
          || amount.currency !== executedPrice.currency || feeAmount.currency !== amount.currency) {
        fail('CQ_OE7_FEE_JOIN', `${feeAllocation.id} has an invalid Fee effect/currency join`);
      }
      feeEffect = add(feeEffect, fee.effect === 'charge' ? amount.amount : rational(-amount.amount.n, amount.amount.d));
    }
    const unsignedBasis = add(gross.amount, feeEffect);
    const expectedBasis = execution.side === 'Buy' ? unsignedBasis : rational(-unsignedBasis.n, unsignedBasis.d);
    if (!equal(basis.amount, expectedBasis)) fail('CQ_OE7_COST_BASIS', `${allocation.id} cost basis equation is false`);
    allocatedQuantity = add(allocatedQuantity, allocated.amount);
  }
  if (!equal(allocatedQuantity, executedQuantity.amount)) {
    fail('CQ_OE7_ALLOCATION_CONSERVATION', 'complete PositionLot allocation does not conserve Execution Quantity');
  }
  for (const fee of fees) {
    const expected = money(fee.amount, `${fee.id}.amount`, { positive: true });
    const allocated = feeAllocations
      .filter((allocation) => allocation.feeVersionIri === fee.id)
      .reduce((sum, allocation) => add(
        sum,
        money(allocation.amount, `${allocation.id}.amount`, { positive: true }).amount,
      ), rational(0n));
    if (!equal(allocated, expected.amount)) {
      fail('CQ_OE7_FEE_JOIN', `${fee.id} is not exactly conserved by its complete fee-allocation set`);
    }
  }
  return [{
    executionVersionIri: execution.id,
    quotationContractVersionIri: quotation.id,
    feeVersionIris: fees.map((value) => value.id).sort(utf8Compare),
    liquidityDetermination: {
      determinationVersionIri: determinations[0].id,
      perspective: determinations[0].perspective,
      result: determinations[0].result,
      role: determinations[0].role,
      sourceRecordRef: determinations[0].sourceRecordRef,
      sourceRecordDigest: determinations[0].sourceRecordDigest,
      rawFieldLocator: determinations[0].rawFieldLocator,
      rawLexicalValue: determinations[0].rawLexicalValue,
      mappingVersionIri: determinations[0].mappingVersionIri,
    },
    allocationClosureVersionIri: closure.id,
    allocationVersionIris: allocations.map((value) => value.id).sort(utf8Compare),
    feeAllocationVersionIris: feeAllocations.map((value) => value.id).sort(utf8Compare),
    costBasis: allocations.map((value) => ({
      allocationVersionIri: value.id,
      positionLotVersionIri: value.lotVersionIri,
      ...value.costBasis,
    })),
  }];
}

function executeOe8(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  iri(query.orderIntentLogicalIri, 'orderIntentLogicalIri');
  const intents = [...indexes.collections.intents.values()]
    .filter((candidate) => candidate.logicalId === query.orderIntentLogicalIri)
    .filter((candidate) => pitEligible(candidate, pivot, indexes));
  if (intents.length !== 1) fail('CQ_OE8_INTENT_VERSION', `expected one PIT-eligible OrderIntent version, found ${intents.length}`);
  const events = [...indexes.collections.events.values()]
    .filter((event) => event.orderIntentVersionIri === intents[0].id)
    .filter((event) => pitEligible(event, pivot, indexes))
    .sort(occurrenceOrder);
  if (events.length === 0) return [];
  const logicalSelections = new Map();
  for (const event of events) {
    eventJoin(event, indexes, 'CQ_OE8_EVENT_CHAIN', pivot);
    if (logicalSelections.has(event.logicalId)) fail('CQ_OE8_OVERLAPPING_REVISIONS', `${event.logicalId} has multiple PIT-eligible revisions`);
    logicalSelections.set(event.logicalId, event.id);
  }
  const latest = events[events.length - 1];
  return [{
    orderIntentVersionIri: intents[0].id,
    derivedState: latest.state,
    stateEventVersionIri: latest.id,
    eventVersionIris: events.map((event) => event.id),
    asOfKnowledge: query.pivot.asOfKnowledge,
  }];
}

function executeOe9(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const from = instant(query.from, 'from');
  const to = instant(query.to, 'to');
  if (from >= to) fail('CQ_OE9_INTERVAL', 'execution interval must be non-empty and half-open');
  iri(query.facilityLogicalIri, 'facilityLogicalIri');
  const rows = [];
  for (const execution of indexes.collections.executions.values()) {
    const when = instant(execution.observedAt, `${execution.id}.observedAt`);
    if (when < from || when >= to || !pitEligible(execution, pivot, indexes)) continue;
    const join = executionJoin(execution, indexes, 'CQ_OE9_EXECUTION_JOIN', pivot);
    const listing = eligibleExact(indexes.collections.listings, execution.listingVersionIri, pivot, indexes, 'CQ_OE9_LISTING_JOIN', `${execution.id}.listingVersionIri`);
    if (listing.instrumentVersionIri !== join.instrument.id) fail('CQ_OE9_LISTING_JOIN', `${listing.id} lists a different instrument`);
    if (listing.facilityLogicalIri !== query.facilityLogicalIri) continue;
    rows.push({
      executionVersionIri: execution.id,
      observedAt: execution.observedAt,
      orderIntentVersionIri: join.intent.id,
      accountVersionIri: join.account.id,
      accountLogicalIri: join.account.logicalId,
      executionPartyLogicalIri: join.executionParty.id,
      contraAccountVersionIri: join.contraAccount.id,
      contraAccountLogicalIri: join.contraAccount.logicalId,
      contraPartyLogicalIri: join.contraParty.id,
      ...(join.executingBroker ? { executingBrokerLogicalIri: join.executingBroker.id } : {}),
      listingVersionIri: listing.id,
      instrumentVersionIri: join.instrument.id,
      instrumentLogicalIri: join.instrument.logicalId,
      facilityLogicalIri: listing.facilityLogicalIri,
    });
  }
  return rows.sort((left, right) => {
    const time = instant(left.observedAt, `${left.executionVersionIri}.observedAt`)
      - instant(right.observedAt, `${right.executionVersionIri}.observedAt`);
    return time < 0n ? -1 : time > 0n ? 1 : utf8Compare(left.executionVersionIri, right.executionVersionIri);
  });
}

function executeOe11(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const focus = eligibleExact(
    indexes.collections.intents,
    query.orderIntentVersionIri,
    pivot,
    indexes,
    'CQ_OE11_INTENT',
    'orderIntentVersionIri',
  );
  const rows = [];
  for (const lineage of indexes.collections.orderLineages.values()) {
    const isSource = lineage.sourceIntentVersionIris.includes(focus.id);
    const isResult = lineage.resultIntentVersionIris.includes(focus.id);
    if ((!isSource && !isResult) || !pitEligible(lineage, pivot, indexes)) continue;
    for (const endpointVersionIri of [
      ...lineage.sourceIntentVersionIris,
      ...lineage.resultIntentVersionIris,
    ]) {
      const endpoint = indexes.collections.intents.get(endpointVersionIri);
      if (!endpoint || !pitEligible(endpoint, pivot, indexes)) {
        fail('CQ_OE11_ENDPOINT_PIT', `${lineage.id} endpoint ${endpointVersionIri} is not PIT-eligible at the query pivot`);
      }
      const instrument = indexes.collections.instruments.get(endpoint.instrumentVersionIri);
      if (!instrument || !pitEligible(instrument, pivot, indexes)) {
        fail('CQ_OE11_ENDPOINT_PIT', `${endpoint.id} Instrument is not PIT-eligible at the query pivot`);
      }
    }
    rows.push({
      orderIntentVersionIri: focus.id,
      focusRole: isSource ? 'source' : 'result',
      lineageVersionIri: lineage.id,
      lineageKind: lineage.kind,
      sourceIntentVersionIris: [...lineage.sourceIntentVersionIris],
      sourceIntentCount: lineage.sourceIntentCount,
      sourceIntentVersionSetDigest: lineage.sourceIntentVersionSetDigest,
      resultIntentVersionIris: [...lineage.resultIntentVersionIris],
      resultIntentCount: lineage.resultIntentCount,
      resultIntentVersionSetDigest: lineage.resultIntentVersionSetDigest,
      orderLineageKeyDigest: lineage.orderLineageKeyDigest,
    });
  }
  return rows.sort((left, right) => utf8Compare(left.lineageVersionIri, right.lineageVersionIri));
}

function executePp1(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const rows = [];
  for (const account of indexes.collections.accounts.values()) {
    if (!pitEligible(account, pivot, indexes)) continue;
    const member = indexes.accountTypeMembers.get(account.accountTypeMemberIri);
    if (!member
        || member.codeListIri !== 'https://axiolune.ai/ontology/finance/foundation/AccountType'
        || !['cash', 'securitiesCustody', 'multiAsset'].includes(member.notation)) {
      fail('CQ_PP1_ACCOUNT_TYPE', `${account.id} does not resolve a reviewed Foundation AccountType member`);
    }
    rows.push({
      accountVersionIri: account.id,
      accountLogicalIri: account.logicalId,
      accountTypeMemberIri: member.id,
      accountTypeNotation: member.notation,
    });
  }
  return rows.sort((left, right) => utf8Compare(left.accountLogicalIri, right.accountLogicalIri));
}

function executePp2(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const portfolios = query.portfolioLogicalIri === undefined
    ? [...indexes.portfolios.values()]
    : [indexes.portfolios.get(iri(query.portfolioLogicalIri, 'portfolioLogicalIri'))].filter(Boolean);
  const rows = [];
  for (const portfolio of portfolios) {
    const mandates = [...indexes.collections.mandates.values()]
      .filter((mandate) => mandate.portfolioLogicalIri === portfolio.id)
      .filter((mandate) => pitEligible(mandate, pivot, indexes));
    for (const mandate of mandates) {
      const party = indexes.parties.get(mandate.managingPartyLogicalIri);
      if (!party) fail('CQ_PP2_MANAGER_JOIN', `${mandate.id} managing Party does not resolve`);
      if (!IRI.test(mandate.approvalRef || '') || !SHA256.test(mandate.approvalDigest || '')
          || !IRI.test(mandate.authorityLogicalIri || '') || typeof mandate.authorityScope !== 'string') {
        fail('CQ_PP2_MANDATE_EVIDENCE', `${mandate.id} lacks authority, scope, or approval evidence`);
      }
      rows.push({
        portfolioLogicalIri: portfolio.id,
        portfolioIdentifier: portfolio.portfolioIdentifier,
        portfolioName: portfolio.name,
        mandateVersionIri: mandate.id,
        managingPartyLogicalIri: party.id,
        managingPartyName: party.name,
        authorityLogicalIri: mandate.authorityLogicalIri,
        authorityScope: mandate.authorityScope,
        approvalRef: mandate.approvalRef,
        approvalDigest: mandate.approvalDigest,
      });
    }
  }
  return rows.sort((left, right) => utf8Compare(left.mandateVersionIri, right.mandateVersionIri));
}

function executeS3(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const portfolioId = iri(query.portfolioLogicalIri, 'portfolioLogicalIri');
  if (!indexes.portfolios.has(portfolioId)) return [];
  const accountVersions = new Map();
  for (const membership of indexes.collections.memberships.values()) {
    if (membership.portfolioLogicalIri !== portfolioId || !pitEligible(membership, pivot, indexes)) continue;
    const account = eligibleExact(indexes.collections.accounts, membership.accountVersionIri, pivot, indexes, 'CQ_S3_MEMBERSHIP_ACCOUNT', `${membership.id}.accountVersionIri`);
    accountVersions.set(account.id, membership);
  }
  const rows = [];
  for (const holding of indexes.collections.holdings.values()) {
    if (!accountVersions.has(holding.accountVersionIri) || !pitEligible(holding, pivot, indexes)) continue;
    const held = quantity(holding.quantity, `${holding.id}.quantity`, { nonNegative: true });
    const instrument = eligibleExact(indexes.collections.instruments, holding.instrumentVersionIri, pivot, indexes, 'CQ_S3_INSTRUMENT', `${holding.id}.instrumentVersionIri`);
    rows.push({
      portfolioLogicalIri: portfolioId,
      membershipVersionIri: accountVersions.get(holding.accountVersionIri).id,
      holdingVersionIri: holding.id,
      accountVersionIri: holding.accountVersionIri,
      instrumentVersionIri: instrument.id,
      instrumentLogicalIri: instrument.logicalId,
      quantity: { value: decimalLexical(held.amount), unit: held.unit },
    });
  }
  return rows.sort((left, right) => utf8Compare(left.holdingVersionIri, right.holdingVersionIri));
}

function exactEvidenceArtifact(indexes, ref, digest, code, label) {
  if (typeof ref !== 'string' || !IRI.test(ref)) fail(code, `${label}.ref must be an absolute IRI`);
  if (!SHA256.test(digest || '')) fail(code, `${label}.digest must be SHA-256`);
  const artifact = indexes.evidenceArtifacts.get(ref);
  if (!artifact || artifact.digest !== digest) {
    fail(code, `${label} does not resolve to the exact digest-locked artifact`);
  }
  return artifact.payload;
}

function validateValuationDefinition(header, pivot, indexes) {
  const definition = eligibleExact(
    indexes.collections.valuationDefinitions,
    header.definitionVersionIri,
    pivot,
    indexes,
    'CQ_PP5_VALUATION_DEFINITION',
    `${header.id}.definitionVersionIri`,
  );
  if (definition.valuationMethod !== 'directUnitPriceTimesQuantity'
      || typeof definition.valuationDefinitionId !== 'string'
      || definition.valuationDefinitionId.length === 0
      || !IRI.test(definition.authorityLogicalIri || '')) {
    fail('CQ_PP5_VALUATION_DEFINITION', `${definition.id} is not the locked direct-unit valuation method`);
  }
  if (!Array.isArray(definition.quotationContractVersionIris)
      || definition.quotationContractVersionIris.length === 0
      || new Set(definition.quotationContractVersionIris).size
        !== definition.quotationContractVersionIris.length
      || definition.quotationContractCount !== definition.quotationContractVersionIris.length
      || definition.quotationContractVersionSetDigest
        !== iriSetDigest(definition.quotationContractVersionIris)) {
    fail('CQ_PP5_VALUATION_DEFINITION', `${definition.id} quotation-contract closure is not an exact non-empty IRI set`);
  }
  for (const quotationVersionIri of definition.quotationContractVersionIris) {
    eligibleExact(
      indexes.collections.quotationContracts,
      quotationVersionIri,
      pivot,
      indexes,
      'CQ_PP5_VALUATION_DEFINITION',
      `${definition.id}.quotationContractVersionIris`,
    );
  }
  for (const field of ['formulaDigest', 'inputContractDigest', 'outputContractDigest', 'runtimeDigest', 'toolLockDigest']) {
    if (!SHA256.test(definition[field] || '')) {
      fail('CQ_PP5_VALUATION_DEFINITION', `${definition.id}.${field} is not a locked SHA-256 digest`);
    }
  }
  iri(definition.toolLockRef, `${definition.id}.toolLockRef`);
  const precisionPolicy = exactEvidenceArtifact(
    indexes,
    definition.precisionPolicyRef,
    definition.precisionPolicyDigest,
    'CQ_PP5_POLICY',
    `${definition.id}.precisionPolicy`,
  );
  const roundingPolicy = exactEvidenceArtifact(
    indexes,
    definition.roundingPolicyRef,
    definition.roundingPolicyDigest,
    'CQ_PP5_POLICY',
    `${definition.id}.roundingPolicy`,
  );
  if (!isValuationPrecisionPolicy(precisionPolicy)
      || !isValuationRoundingPolicy(roundingPolicy)
      || precisionPolicy.amountScale !== roundingPolicy.outputScale) {
    fail('CQ_PP5_POLICY', `${definition.id} precision/rounding policy pair is invalid`);
  }
  return {
    definition,
    precisionPolicy,
    quotationContractVersionIris: new Set(definition.quotationContractVersionIris),
    roundingPolicy,
  };
}

function exactValuationSnapshot(line, pivot, indexes) {
  exactVersionIri(line.inputSnapshotVersionIri, `${line.id}.inputSnapshotVersionIri`);
  const holding = indexes.collections.holdings.get(line.inputSnapshotVersionIri);
  const position = indexes.collections.positions.get(line.inputSnapshotVersionIri);
  if ((holding ? 1 : 0) + (position ? 1 : 0) !== 1) {
    fail('CQ_PP5_INPUT_SNAPSHOT', `${line.id} must resolve exactly one HoldingSnapshot xone PositionSnapshot`);
  }
  const snapshot = holding || position;
  if (!pitEligible(snapshot, pivot, indexes)) {
    fail('CQ_PP5_INPUT_SNAPSHOT', `${snapshot.id} is not PIT-eligible`);
  }
  return { kind: holding ? 'holding' : 'position', snapshot };
}

function replayValuationSource(line, snapshot, snapshotKind, pivot, indexes, policies) {
  const price = eligibleExact(
    indexes.collections.priceObservations,
    line.priceVersionIri,
    pivot,
    indexes,
    'CQ_PP5_PRICE',
    `${line.id}.priceVersionIri`,
  );
  const instrument = eligibleExact(
    indexes.collections.instruments,
    snapshot.instrumentVersionIri,
    pivot,
    indexes,
    'CQ_PP5_PRICE',
    `${snapshot.id}.instrumentVersionIri`,
  );
  const listing = eligibleExact(
    indexes.collections.listings,
    snapshot.listingVersionIri,
    pivot,
    indexes,
    'CQ_PP5_QUOTATION',
    `${snapshot.id}.listingVersionIri`,
  );
  const quotation = eligibleExact(
    indexes.collections.quotationContracts,
    price.quotationContractVersionIri,
    pivot,
    indexes,
    'CQ_PP5_QUOTATION',
    `${price.id}.quotationContractVersionIri`,
  );
  const held = exactScaledQuantity(
    snapshot.quantity,
    policies.precisionPolicy.quantityScale,
    `${snapshot.id}.quantity`,
    snapshotKind === 'holding' ? { nonNegative: true } : {},
  );
  const observed = exactScaledMoney(
    price.priceValue,
    policies.precisionPolicy.amountScale,
    `${price.id}.priceValue`,
  );
  if (price.instrumentVersionIri !== instrument.id
      || price.listingVersionIri !== listing.id
      || listing.instrumentVersionIri !== instrument.id
      || quotation.contextVersionIri !== listing.id
      || quotation.instrumentLogicalIri !== instrument.logicalId
      || quotation.quoteCurrency !== observed.currency
      || quotation.denominatorUnit !== held.unit) {
    fail('CQ_PP5_QUOTATION', `${line.id} snapshot, price, listing, and quotation truths do not join exactly`);
  }
  let raw;
  try {
    raw = directUnitValueRaw(
      held.raw,
      observed.raw,
      policies.precisionPolicy,
      policies.roundingPolicy,
    );
  } catch (cause) {
    fail('CQ_PP5_VALUATION_ARITHMETIC', `${line.id} direct-unit replay failed: ${cause.message}`);
  }
  return {
    amount: scaledRational(raw, policies.roundingPolicy.outputScale),
    currency: observed.currency,
    quotationContractVersionIri: quotation.id,
    raw,
  };
}

function validateFxConversion(conversion, line, source, targetCurrency, pivot, indexes, policies) {
  if (!pitEligible(conversion, pivot, indexes)) fail('CQ_PP5_FX_PIT', `${conversion.id} is not PIT-eligible`);
  const conversionPivot = {
    valid: instant(conversion.axes.validFrom, `${conversion.id}.validFrom`),
    knowledge: instant(conversion.axes.knowledgeFrom, `${conversion.id}.knowledgeFrom`),
    availability: instant(conversion.axes.availableFrom, `${conversion.id}.availableFrom`),
  };
  const rateObservation = exactRecord(
    indexes.collections.fxRates,
    conversion.rateVersionIri,
    'CQ_PP5_FX_RATE',
    `${conversion.id}.rateVersionIri`,
  );
  if (Object.hasOwn(conversion, 'rate')) {
    fail('CQ_PP5_FX_RATE', `${conversion.id} must not carry an unversioned inline rate copy`);
  }
  if (!pitEligible(rateObservation, pivot, indexes)
      || !pitEligible(rateObservation, conversionPivot, indexes)) {
    fail('CQ_PP5_FX_PIT', `${rateObservation.id} is not PIT-eligible at both query and conversion pivots`);
  }
  if (conversion.baseCurrency === conversion.quoteCurrency
      || rateObservation.baseCurrency !== conversion.baseCurrency
      || rateObservation.quoteCurrency !== conversion.quoteCurrency) {
    fail('CQ_PP5_FX_RATE', `${conversion.id} does not bind the exact FXRateObservation orientation`);
  }
  const rate = exactScaledQuantity(
    rateObservation.rate,
    policies.precisionPolicy.rateScale,
    `${rateObservation.id}.rate`,
    { positive: true },
  );
  if (rate.unit !== `urn:unit:${conversion.quoteCurrency}-per-${conversion.baseCurrency}`) {
    fail('CQ_PP5_FX_RATE', `${rateObservation.id} unit does not encode quote-per-base orientation`);
  }
  const input = exactScaledMoney(
    conversion.inputMoney,
    policies.precisionPolicy.amountScale,
    `${conversion.id}.inputMoney`,
  );
  const output = exactScaledMoney(
    conversion.outputMoney,
    policies.roundingPolicy.outputScale,
    `${conversion.id}.outputMoney`,
  );
  if (input.raw !== source.raw || input.currency !== source.currency || output.currency !== targetCurrency) {
    fail('CQ_PP5_FX_INPUT', `${conversion.id} input is not the replayed pre-FX valuation Money`);
  }
  if (!((conversion.direction === 'baseToQuote'
      && conversion.baseCurrency === input.currency
      && conversion.quoteCurrency === output.currency)
    || (conversion.direction === 'quoteToBase'
      && conversion.quoteCurrency === input.currency
      && conversion.baseCurrency === output.currency))) {
    fail('CQ_PP5_FX_DIRECTION', `${conversion.id} has a direction/currency mismatch`);
  }
  const roundingPolicy = exactEvidenceArtifact(
    indexes,
    conversion.roundingPolicyRef,
    conversion.roundingPolicyDigest,
    'CQ_PP5_FX_POLICY',
    `${conversion.id}.roundingPolicy`,
  );
  if (conversion.roundingPolicyRef !== policies.definition.roundingPolicyRef
      || conversion.roundingPolicyDigest !== policies.definition.roundingPolicyDigest
      || canonicalJcs(roundingPolicy) !== canonicalJcs(policies.roundingPolicy)) {
    fail('CQ_PP5_FX_POLICY', `${conversion.id} does not use the header definition's exact rounding policy`);
  }
  const inputContext = exactEvidenceArtifact(
    indexes,
    conversion.inputContextRef,
    conversion.inputContextRecordDigest,
    'CQ_PP5_FX_CONTEXT',
    `${conversion.id}.inputContext`,
  );
  if (Object.keys(inputContext).length !== 4
      || inputContext.schemaVersion !== '1.0'
      || typeof inputContext.contextId !== 'string'
      || inputContext.contextId.length === 0
      || inputContext.status !== 'completed'
      || instant(inputContext.completedAt, `${conversion.id}.inputContext.completedAt`)
        >= conversionPivot.knowledge
      || !IRI.test(conversion.generatingContextRef || '')) {
    fail('CQ_PP5_FX_CONTEXT', `${conversion.id} lacks a strictly prior completed input context or generating context`);
  }
  const reverseConsumers = [...indexes.collections.positionValuations.values()]
    .filter((candidate) => candidate.fxConversionVersionIri === conversion.id);
  if (conversion.valuationLineVersionIri !== line.id
      || reverseConsumers.length !== 1
      || reverseConsumers[0].id !== line.id
      || conversion.openingLotVersionIri !== undefined
      || conversion.feeAllocationVersionIri !== undefined) {
    fail('CQ_PP5_FX_CONSUMER', `${conversion.id} does not close exactly one bidirectional valuation-line consumer`);
  }
  let expectedRaw;
  try {
    expectedRaw = fxValueRaw(
      input.raw,
      rate.raw,
      conversion.direction,
      policies.precisionPolicy,
      policies.roundingPolicy,
    );
  } catch (cause) {
    fail('CQ_PP5_FX_ARITHMETIC', `${conversion.id} exact FX replay failed: ${cause.message}`);
  }
  if (expectedRaw !== output.raw) {
    fail('CQ_PP5_FX_ARITHMETIC', `${conversion.id} output does not satisfy exact scaled-integer FX arithmetic`);
  }
  return { amount: scaledRational(output.raw, policies.roundingPolicy.outputScale), currency: output.currency, raw: output.raw };
}

function executePp5(graph, query) {
  const indexes = buildIndexes(graph);
  const pivot = normalizePivot(query, indexes);
  const portfolioId = iri(query.portfolioLogicalIri, 'portfolioLogicalIri');
  const headers = [...indexes.collections.valuationHeaders.values()]
    .filter((header) => header.portfolioLogicalIri === portfolioId)
    .filter((header) => pitEligible(header, pivot, indexes));
  if (headers.length !== 1) fail('CQ_PP5_HEADER', `expected one PIT-eligible PortfolioValuation header, found ${headers.length}`);
  const header = headers[0];
  if (!/^[A-Z]{3}$/u.test(header.reportingCurrency || '')) {
    fail('CQ_PP5_HEADER', `${header.id}.reportingCurrency is invalid`);
  }
  const policies = validateValuationDefinition(header, pivot, indexes);
  const membershipClosure = eligibleExact(
    indexes.collections.membershipClosures,
    header.membershipClosureVersionIri,
    pivot,
    indexes,
    'CQ_PP5_MEMBER_CLOSURE',
    `${header.id}.membershipClosureVersionIri`,
  );
  if (membershipClosure.portfolioLogicalIri !== portfolioId
      || !Array.isArray(membershipClosure.membershipVersionIris)
      || new Set(membershipClosure.membershipVersionIris).size
        !== membershipClosure.membershipVersionIris.length
      || membershipClosure.membershipCount !== membershipClosure.membershipVersionIris.length
      || membershipClosure.membershipVersionSetDigest
        !== iriSetDigest(membershipClosure.membershipVersionIris)) {
    fail('CQ_PP5_MEMBER_CLOSURE', `${membershipClosure.id} is not a complete exact membership closure`);
  }
  const memberAccountVersionIris = [];
  for (const membershipVersionIri of membershipClosure.membershipVersionIris) {
    const membership = eligibleExact(
      indexes.collections.memberships,
      membershipVersionIri,
      pivot,
      indexes,
      'CQ_PP5_MEMBER_CLOSURE',
      `${membershipClosure.id}.membershipVersionIris`,
    );
    if (membership.portfolioLogicalIri !== portfolioId) {
      fail('CQ_PP5_MEMBER_CLOSURE', `${membership.id} belongs to a different Portfolio`);
    }
    eligibleExact(
      indexes.collections.accounts,
      membership.accountVersionIri,
      pivot,
      indexes,
      'CQ_PP5_MEMBER_CLOSURE',
      `${membership.id}.accountVersionIri`,
    );
    memberAccountVersionIris.push(membership.accountVersionIri);
  }
  if (new Set(memberAccountVersionIris).size !== memberAccountVersionIris.length) {
    fail('CQ_PP5_MEMBER_CLOSURE', `${membershipClosure.id} repeats a member FinancialAccount`);
  }
  const lines = [...indexes.collections.positionValuations.values()]
    .filter((line) => line.headerVersionIri === header.id)
    .filter((line) => pitEligible(line, pivot, indexes));
  const groups = new Map();
  const valuationIdentities = new Set();
  const replayedLines = [];
  for (const line of lines) {
    if (!memberAccountVersionIris.includes(line.accountVersionIri)) {
      fail('CQ_PP5_MEMBER_CLOSURE', `${line.id} account is outside the header member-account closure`);
    }
    const { kind: snapshotKind, snapshot } = exactValuationSnapshot(line, pivot, indexes);
    if (snapshot.accountVersionIri !== line.accountVersionIri) {
      fail('CQ_PP5_INPUT_SNAPSHOT', `${line.id} copies a different snapshot account`);
    }
    const identity = `${header.id}\0${snapshot.id}`;
    if (valuationIdentities.has(identity)) {
      fail('CQ_PP5_LINE_IDENTITY', `two PositionValuation facts share header/input identity ${identity}`);
    }
    valuationIdentities.add(identity);
    const source = replayValuationSource(line, snapshot, snapshotKind, pivot, indexes, policies);
    let finalValue;
    if (source.currency === header.reportingCurrency) {
      if (line.fxConversionVersionIri !== undefined) {
        fail('CQ_PP5_SAME_CURRENCY_FX', `${line.id} must not cite FX for same-currency valuation`);
      }
      finalValue = source;
    } else {
      if (line.fxConversionVersionIri === undefined) {
        fail('CQ_PP5_MISSING_FX', `${line.id} requires an explicit exact FXConversion`);
      }
      const conversion = exactRecord(
        indexes.collections.fxConversions,
        line.fxConversionVersionIri,
        'CQ_PP5_MISSING_FX',
        `${line.id}.fxConversionVersionIri`,
      );
      finalValue = validateFxConversion(
        conversion,
        line,
        source,
        header.reportingCurrency,
        pivot,
        indexes,
        policies,
      );
    }
    const stored = exactScaledMoney(
      line.marketValue,
      policies.roundingPolicy.outputScale,
      `${line.id}.marketValue`,
    );
    if (stored.currency !== finalValue.currency || stored.raw !== finalValue.raw) {
      fail('CQ_PP5_VALUATION_ARITHMETIC', `${line.id}.marketValue differs from exact snapshot/price/FX replay`);
    }
    const current = groups.get(source.currency) || { amount: rational(0n), count: 0 };
    current.amount = add(current.amount, source.amount);
    current.count += 1;
    groups.set(source.currency, current);
    replayedLines.push({ finalValue, line, source });
  }
  const incompatibleQuotation = replayedLines.find(
    ({ source }) => !policies.quotationContractVersionIris.has(source.quotationContractVersionIri),
  );
  if (incompatibleQuotation) {
    fail(
      'CQ_PP5_DEFINITION_QUOTATION',
      `${incompatibleQuotation.line.id} quotation ${incompatibleQuotation.source.quotationContractVersionIri}`
        + ` is outside ${policies.definition.id}'s exact quotation closure`,
    );
  }
  const byCurrency = [...groups.entries()].sort(([left], [right]) => utf8Compare(left, right))
    .map(([currency, value]) => ({
      currency,
      amount: decimalLexical(value.amount, `${currency} group total`),
      lineCount: value.count,
    }));
  if (query.targetCurrency === undefined) {
    return [{
      portfolioLogicalIri: portfolioId,
      portfolioValuationVersionIri: header.id,
      membershipClosureVersionIri: membershipClosure.id,
      byCurrency,
    }];
  }
  if (!/^[A-Z]{3}$/u.test(query.targetCurrency)
      || query.targetCurrency !== header.reportingCurrency) {
    fail('CQ_PP5_TARGET_CURRENCY', 'targetCurrency must equal the header reporting currency');
  }
  let total = rational(0n);
  const conversionVersionIris = [];
  for (const { finalValue, line } of replayedLines) {
    total = add(total, finalValue.amount);
    if (line.fxConversionVersionIri !== undefined) conversionVersionIris.push(line.fxConversionVersionIri);
  }
  return [{
    portfolioLogicalIri: portfolioId,
    portfolioValuationVersionIri: header.id,
    membershipClosureVersionIri: membershipClosure.id,
    byCurrency,
    targetCurrency: query.targetCurrency,
    convertedTotal: decimalLexical(total, 'converted portfolio total'),
    lineCount: lines.length,
    fxConversionVersionIris: conversionVersionIris.sort(utf8Compare),
  }];
}

const EXECUTORS = Object.freeze({
  'CQ-OE2': executeOe2,
  'CQ-OE3': executeOe3,
  'CQ-OE4': executeOe4,
  'CQ-OE6': executeOe6,
  'CQ-OE7': executeOe7,
  'CQ-OE8': executeOe8,
  'CQ-OE9': executeOe9,
  'CQ-OE11': executeOe11,
  'CQ-PP1': executePp1,
  'CQ-PP2': executePp2,
  'CQ-S3': executeS3,
  'CQ-PP5': executePp5,
});

function executeCq(cqId, graph, query) {
  const executor = EXECUTORS[cqId];
  if (!executor) fail('CQ_UNSUPPORTED', `unsupported Orders/Portfolio CQ ${String(cqId)}`);
  return executor(graph, query);
}

module.exports = {
  CQ_FUNCTION_VERSION,
  CqContractError,
  buildIndexes,
  decimalLexical,
  executeCq,
  executeOe2,
  executeOe3,
  executeOe4,
  executeOe6,
  executeOe7,
  executeOe8,
  executeOe9,
  executeOe11,
  executePp1,
  executePp2,
  executePp5,
  executeS3,
  iriSetDigest,
  pitEligible,
};
