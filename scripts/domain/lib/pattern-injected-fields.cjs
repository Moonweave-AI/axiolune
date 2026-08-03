'use strict';

const TEMPORAL_FACT = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCED_FACT = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * Effective RFC-001 M2 pattern profile.
 *
 * The M3 pattern remains the vocabulary source. M2 tightens that vocabulary for
 * concrete immutable FactVersion records: all three `from` axes, source, and
 * revision are required; knowledge/availability closure is represented by a
 * separate closure assertion rather than mutable `*To` values. Keeping this
 * profile here gives validators and both projections one semantic source.
 */
const PATTERN_INJECTED_ATTRIBUTE_USES = Object.freeze({
  [TEMPORAL_FACT]: Object.freeze([
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/validFrom',
      minCount: 1,
      maxCount: 1,
      datatype: `${XSD}dateTimeStamp`,
      scope: 'temporal',
    }),
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom',
      minCount: 1,
      maxCount: 1,
      datatype: `${XSD}dateTimeStamp`,
      scope: 'temporal',
    }),
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom',
      minCount: 1,
      maxCount: 1,
      datatype: `${XSD}dateTimeStamp`,
      scope: 'temporal',
    }),
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/validTo',
      minCount: 0,
      maxCount: 1,
      datatype: `${XSD}dateTimeStamp`,
      scope: 'temporal',
    }),
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeTo',
      maxCount: 0,
      datatype: `${XSD}dateTimeStamp`,
      scope: 'immutable-version',
    }),
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableTo',
      maxCount: 0,
      datatype: `${XSD}dateTimeStamp`,
      scope: 'immutable-version',
    }),
  ]),
  [PROVENANCED_FACT]: Object.freeze([
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/source',
      minCount: 1,
      maxCount: 1,
      datatype: `${XSD}anyURI`,
      scope: 'provenance',
    }),
    Object.freeze({
      attribute: 'https://axiolune.ai/ontology/meta/patterns/attributes/revision',
      minCount: 1,
      maxCount: 1,
      datatype: `${XSD}nonNegativeInteger`,
      scope: 'provenance',
      owlCardinality: true,
    }),
  ]),
});

const PATTERN_INJECTED_FIELDS = Object.freeze({
  ...Object.fromEntries(Object.entries(PATTERN_INJECTED_ATTRIBUTE_USES).map(
    ([pattern, uses]) => [pattern, Object.freeze(uses.map((use) => use.attribute))],
  )),
});

function effectivePatternInjectedAttributeUses(element) {
  const effective = [];
  for (const binding of element?.patternBindings || []) {
    if (!binding || typeof binding !== 'object') continue;
    for (const use of PATTERN_INJECTED_ATTRIBUTE_USES[binding.pattern] || []) {
      effective.push(Object.freeze({ pattern: binding.pattern, ...use }));
    }
  }
  return Object.freeze(effective);
}

function effectivePatternInjectedAttributeUse(element, attribute) {
  const matches = effectivePatternInjectedAttributeUses(element)
    .filter((use) => use.attribute === attribute);
  return matches.length === 1 ? matches[0] : null;
}

function patternInjectedAttributeUseCollisions(element) {
  const boundPatterns = new Set(
    (element.patternBindings || [])
      .filter((binding) => binding && typeof binding === 'object')
      .map((binding) => binding.pattern),
  );
  const injectedByAttribute = new Map();
  for (const [pattern, attributes] of Object.entries(PATTERN_INJECTED_FIELDS)) {
    if (!boundPatterns.has(pattern)) continue;
    for (const attribute of attributes) injectedByAttribute.set(attribute, pattern);
  }
  const collisions = [];
  for (const [attributeUseIndex, use] of (element.attributeUses || []).entries()) {
    if (!use || typeof use !== 'object') continue;
    const pattern = injectedByAttribute.get(use.attribute);
    if (pattern) {
      collisions.push(Object.freeze({
        attributeUseIndex,
        attribute: use.attribute,
        pattern,
      }));
    }
  }
  return collisions;
}

module.exports = {
  PATTERN_INJECTED_ATTRIBUTE_USES,
  PATTERN_INJECTED_FIELDS,
  PROVENANCED_FACT,
  TEMPORAL_FACT,
  effectivePatternInjectedAttributeUse,
  effectivePatternInjectedAttributeUses,
  patternInjectedAttributeUseCollisions,
};
