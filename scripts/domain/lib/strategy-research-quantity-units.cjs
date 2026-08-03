'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0/strategy-research';
const REGISTRY_KIND = 'axioluneStrategyResearchQuantityUnitRegistry';
const REGISTRY_TAG = 'axiolune-strategy-research-quantity-unit-registry-v1\0';
const DEFAULT_REGISTRY_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'strategy-research-v03-profile',
  'quantity-unit-registry.json',
);

const UNIT_ONE = 'https://axiolune.ai/units/one';
const UNIT_TRADING_DAY = 'https://axiolune.ai/units/trading-day';

const APPLICATIONS = Object.freeze([
  'annualizationFactor',
  'attributionQuantityValue',
  'calculationWindow',
  'confidenceLevel',
  'factorValue',
  'performanceQuantityValue',
  'riskFreeRate',
  'signalStrength',
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function digestRegistryPayload(payload) {
  return `sha256:${crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(REGISTRY_TAG, 'utf8'),
    Buffer.from(canonicalJcs(payload), 'utf8'),
  ])).digest('hex')}`;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields differ`);
  }
}

function registryPayload() {
  return {
    authorityKind: 'axioluneOperational',
    definition: 'Closed Axiolune operational Quantity-unit subset for the Strategy/Research v0.3 executable profile; it is not asserted to be a complete SI or financial-unit registry.',
    ownerRef: 'urn:axiolune:principal:repository-owner',
    profileRef: PROFILE_REF,
    registryKind: REGISTRY_KIND,
    schemaVersion: '1.0',
    units: [
      {
        allowedApplications: [
          'annualizationFactor',
          'attributionQuantityValue',
          'confidenceLevel',
          'factorValue',
          'performanceQuantityValue',
          'riskFreeRate',
          'signalStrength',
        ],
        definition: 'Multiplicative unit one for dimensionless ratios, scores, rates, and factor or performance values in this profile.',
        label: 'one',
        quantityKind: 'dimensionlessNumber',
        unitIri: UNIT_ONE,
      },
      {
        allowedApplications: ['calculationWindow'],
        definition: 'Count of trading sessions selected by the exact calendar snapshot of the consuming run; it is not a fixed SI duration.',
        label: 'trading day',
        quantityKind: 'tradingSessionCount',
        unitIri: UNIT_TRADING_DAY,
      },
    ],
  };
}

function buildQuantityUnitRegistry() {
  return sealQuantityUnitRegistry(registryPayload());
}

function sealQuantityUnitRegistry(payload) {
  return { ...structuredClone(payload), registryDigest: digestRegistryPayload(payload) };
}

function validateQuantityUnitRegistry(registry, options = {}) {
  exactKeys(
    registry,
    [
      'authorityKind', 'definition', 'ownerRef', 'profileRef', 'registryDigest',
      'registryKind', 'schemaVersion', 'units',
    ],
    'Strategy/Research Quantity-unit registry',
  );
  if (registry.schemaVersion !== '1.0'
      || registry.profileRef !== PROFILE_REF
      || registry.registryKind !== REGISTRY_KIND
      || registry.authorityKind !== 'axioluneOperational'
      || registry.ownerRef !== 'urn:axiolune:principal:repository-owner') {
    throw new Error('Strategy/Research Quantity-unit registry header is invalid');
  }
  const payload = {
    authorityKind: registry.authorityKind,
    definition: registry.definition,
    ownerRef: registry.ownerRef,
    profileRef: registry.profileRef,
    registryKind: registry.registryKind,
    schemaVersion: registry.schemaVersion,
    units: registry.units,
  };
  if (registry.registryDigest !== digestRegistryPayload(payload)) {
    throw new Error('Strategy/Research Quantity-unit registry digest is invalid');
  }
  if (!Array.isArray(registry.units) || registry.units.length === 0) {
    throw new Error('Strategy/Research Quantity-unit registry must be non-empty');
  }
  const applicationSet = new Set(APPLICATIONS);
  let priorIri = null;
  const units = new Map();
  for (const [index, unit] of registry.units.entries()) {
    exactKeys(
      unit,
      ['allowedApplications', 'definition', 'label', 'quantityKind', 'unitIri'],
      `Strategy/Research Quantity-unit registry.units[${index}]`,
    );
    if (typeof unit.unitIri !== 'string'
        || !/^https:\/\/axiolune\.ai\/units\/[a-z0-9-]+$/u.test(unit.unitIri)
        || typeof unit.label !== 'string'
        || unit.label.length === 0
        || typeof unit.definition !== 'string'
        || unit.definition.length === 0
        || !['dimensionlessNumber', 'tradingSessionCount'].includes(unit.quantityKind)) {
      throw new Error(`Strategy/Research Quantity-unit registry.units[${index}] is malformed`);
    }
    if (priorIri !== null && compareUtf8(priorIri, unit.unitIri) >= 0) {
      throw new Error('Strategy/Research Quantity-unit registry units must be strictly IRI-sorted and unique');
    }
    priorIri = unit.unitIri;
    if (!Array.isArray(unit.allowedApplications) || unit.allowedApplications.length === 0) {
      throw new Error(`Strategy/Research Quantity-unit registry.units[${index}] has no applications`);
    }
    let priorApplication = null;
    for (const application of unit.allowedApplications) {
      if (!applicationSet.has(application)) {
        throw new Error(`Strategy/Research Quantity-unit registry.units[${index}] has unknown application ${String(application)}`);
      }
      if (priorApplication !== null && compareUtf8(priorApplication, application) >= 0) {
        throw new Error(`Strategy/Research Quantity-unit registry.units[${index}] applications must be strictly sorted and unique`);
      }
      priorApplication = application;
    }
    units.set(unit.unitIri, unit);
  }
  if (options.requireCanonicalProfile !== false
      && canonicalJcs(registry) !== canonicalJcs(buildQuantityUnitRegistry())) {
    throw new Error('Strategy/Research Quantity-unit registry differs from the reviewed v0.3 profile');
  }
  return { registry, units };
}

function loadQuantityUnitRegistry(file = DEFAULT_REGISTRY_PATH) {
  const bytes = fs.readFileSync(file);
  let registry;
  try {
    registry = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`Strategy/Research Quantity-unit registry is not JSON: ${cause.message}`);
  }
  if (!bytes.equals(Buffer.from(canonicalJcs(registry), 'utf8'))) {
    throw new Error('Strategy/Research Quantity-unit registry is not exact UTF-8 RFC 8785 JCS');
  }
  return validateQuantityUnitRegistry(registry);
}

function quantityUnitForApplication(registryIndex, unitIri, application) {
  if (!APPLICATIONS.includes(application)) {
    throw new TypeError(`unknown Strategy/Research Quantity application ${String(application)}`);
  }
  const unit = registryIndex.units.get(unitIri);
  return unit && unit.allowedApplications.includes(application) ? unit : null;
}

module.exports = {
  APPLICATIONS,
  DEFAULT_REGISTRY_PATH,
  PROFILE_REF,
  REGISTRY_KIND,
  UNIT_ONE,
  UNIT_TRADING_DAY,
  buildQuantityUnitRegistry,
  loadQuantityUnitRegistry,
  quantityUnitForApplication,
  sealQuantityUnitRegistry,
  validateQuantityUnitRegistry,
};
