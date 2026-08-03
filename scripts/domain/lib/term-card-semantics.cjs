'use strict';

const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  CONTAINER_META_TYPES,
  MONEY_VALUE,
  QUANTITY_VALUE,
  classifier,
} = require('./public-symbol-compiler.cjs');

const CORE_META_BASE = 'https://axiolune.ai/ontology/meta/core/';
const MONEY_M3_TYPE = `${CORE_META_BASE}MoneyTypeDefinition`;
const QUANTITY_M3_TYPE = `${CORE_META_BASE}QuantityTypeDefinition`;

const CANDIDATE_M3_TYPES = Object.freeze(Object.fromEntries(
  Object.entries(CONTAINER_META_TYPES).map(([containerKind, metaType]) => [
    containerKind,
    `${CORE_META_BASE}${metaType}`,
  ]),
));

const CANDIDATE_M3_TYPE_IRIS = Object.freeze([
  ...new Set([
    ...Object.values(CANDIDATE_M3_TYPES),
    MONEY_M3_TYPE,
    QUANTITY_M3_TYPE,
  ]),
].sort(utf8Compare));

function candidateM3TypeFor(containerKind, element) {
  if (!Object.prototype.hasOwnProperty.call(CANDIDATE_M3_TYPES, containerKind)) {
    throw new Error(`unsupported term-card source container ${String(containerKind)}`);
  }
  return `${CORE_META_BASE}${classifier(containerKind, element)}`;
}

function candidateM3TypeAllowedForContainer(containerKind, candidateM3Type) {
  if (containerKind === 'attributeTypes') {
    return [CANDIDATE_M3_TYPES.attributeTypes, MONEY_M3_TYPE, QUANTITY_M3_TYPE]
      .includes(candidateM3Type);
  }
  return CANDIDATE_M3_TYPES[containerKind] === candidateM3Type;
}

const COMMON_ELEMENT_FIELDS = Object.freeze([
  'iri', 'namespace', 'localName', 'label', 'definition',
]);

// Adding an M3 field without deciding how that field participates in reviewed
// term semantics must fail closed.  Otherwise a source edit to a newly added
// semantic field could retain an older accepted card and review undetected.
const REVIEW_BOUND_FIELDS = Object.freeze({
  associationTypes: Object.freeze([
    ...COMMON_ELEMENT_FIELDS,
    'participantRoles', 'attributeUses', 'patternBindings',
    'projectedRelations', 'alignments',
  ]),
  attributeTypes: Object.freeze([
    ...COMMON_ELEMENT_FIELDS,
    'valueType', 'owlProjectionOverride', 'defaultCardinality',
    'enumValues', 'pattern', 'unit', 'alignments',
  ]),
  codeLists: Object.freeze([
    ...COMMON_ELEMENT_FIELDS,
    'vocabulary', 'version', 'maintainer', 'sourceEvidenceRef',
    'values', 'alignments',
  ]),
  constraints: Object.freeze([
    ...COMMON_ELEMENT_FIELDS,
    'constraintType', 'scope', 'expression', 'severity', 'message',
    'targetElement', 'note', 'parameters', 'dependencies', 'alignments',
  ]),
  identifierTypes: Object.freeze([
    ...COMMON_ELEMENT_FIELDS,
    'baseType', 'standard', 'validatorRef', 'issuingAuthority', 'alignments',
  ]),
  objectTypes: Object.freeze([
    ...COMMON_ELEMENT_FIELDS,
    'superTypes', 'attributeUses', 'patternBindings', 'constraints',
    'alignments', 'governance', 'abstract',
  ]),
  relationTypes: Object.freeze([
    ...COMMON_ELEMENT_FIELDS,
    'domain', 'range', 'inverseOf', 'characteristics', 'alignments',
  ]),
});

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactText(value) {
  if (typeof value === 'string') return value;
  return canonicalJcs(value);
}

function sortedText(values) {
  return [...new Set(values)].sort(utf8Compare);
}

function cardinalityText(minCount, maxCount) {
  const minimum = Number.isInteger(minCount) ? String(minCount) : 'unspecified';
  const maximum = Number.isInteger(maxCount) ? String(maxCount) : 'unbounded';
  return `[${minimum}, ${maximum}]`;
}

function commonDifferentia(element) {
  const facts = [];
  if (Array.isArray(element.alignments) && element.alignments.length > 0) {
    facts.push(`declares authored alignments ${canonicalJcs(element.alignments)}`);
  }
  return facts;
}

function optionalExactFact(element, field, description) {
  return Object.prototype.hasOwnProperty.call(element, field)
    ? [`${description} ${exactText(element[field])}`]
    : [];
}

function assertReviewBoundSourceShape(containerKind, element) {
  if (element === null || typeof element !== 'object' || Array.isArray(element)) {
    throw new Error(`term-card source ${containerKind} must be an object`);
  }
  const allowed = REVIEW_BOUND_FIELDS[containerKind];
  if (!allowed) throw new Error(`unsupported term-card source container ${String(containerKind)}`);
  const allowedSet = new Set(allowed);
  const unbound = Object.keys(element).filter((field) => !allowedSet.has(field)).sort(utf8Compare);
  if (unbound.length > 0) {
    throw new Error(
      `term-card semantics do not review-bind ${containerKind} field(s): ${unbound.join(', ')}`,
    );
  }
}

function assertReviewBoundNestedShape(value, allowedFields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`term-card nested source ${label} must be an object`);
  }
  const allowed = new Set(allowedFields);
  const unbound = Object.keys(value).filter((field) => !allowed.has(field)).sort(utf8Compare);
  if (unbound.length > 0) {
    throw new Error(
      `term-card semantics do not review-bind ${label} field(s): ${unbound.join(', ')}`,
    );
  }
}

function objectTypeSemantics(element) {
  const superTypes = Array.isArray(element.superTypes) ? element.superTypes : [];
  const attributes = Array.isArray(element.attributeUses) ? element.attributeUses : [];
  const patterns = Array.isArray(element.patternBindings) ? element.patternBindings : [];
  const genus = superTypes.length > 0
    ? `domain object type specializing ${sortedText(superTypes).join(', ')}`
    : 'identity-bearing domain object type with no declared supertype';
  const differentia = [
    element.abstract === true ? 'is declared non-instantiable' : 'is instantiable',
    attributes.length > 0
      ? `binds authored attribute uses ${canonicalJcs(attributes)}`
      : 'binds no authored attribute use',
    patterns.length > 0
      ? `binds cross-domain patterns ${canonicalJcs(patterns)}`
      : 'binds no cross-domain pattern',
    ...optionalExactFact(element, 'constraints', 'binds authored constraint bindings'),
    ...optionalExactFact(element, 'governance', 'binds authored element governance'),
    ...commonDifferentia(element),
  ];
  return {
    genus,
    differentia,
    excludes: [
      'a literal-valued attribute type whose instances are values rather than domain records',
      'a reified association type whose semantics are defined by participant roles',
    ],
  };
}

function associationTypeSemantics(element) {
  const roles = Array.isArray(element.participantRoles) ? element.participantRoles : [];
  const attributes = Array.isArray(element.attributeUses) ? element.attributeUses : [];
  const patterns = Array.isArray(element.patternBindings) ? element.patternBindings : [];
  // A generated role predicate inherits the role definition under the review
  // of its containing association card.  Consequently the containing card
  // must bind the *complete* authored ParticipantRole record, not merely its
  // id/range/cardinality.  Otherwise a label/definition edit can be resealed
  // into a new inheritance digest without invalidating the human review.
  const roleFacts = roles.map((role) => (
    `binds exact authored participant role ${canonicalJcs(role)}`
  ));
  return {
    genus: `reified domain association type with ${roles.length} authored participant roles`,
    differentia: [
      ...roleFacts,
      attributes.length > 0
        ? `binds authored attribute uses ${canonicalJcs(attributes)}`
        : 'binds no authored attribute use',
      patterns.length > 0
        ? `binds cross-domain patterns ${canonicalJcs(patterns)}`
        : 'binds no cross-domain pattern',
      ...optionalExactFact(element, 'projectedRelations', 'binds authored projected relations'),
      ...commonDifferentia(element),
    ],
    excludes: [
      'a binary relation type that carries no reified association context',
      'a standalone domain object type without participant-role semantics',
    ],
  };
}

function relationTypeSemantics(element) {
  const characteristics = Array.isArray(element.characteristics)
    ? sortedText(element.characteristics)
    : [];
  return {
    genus: `binary semantic relation from ${exactText(element.domain)} to ${exactText(element.range)}`,
    differentia: [
      characteristics.length > 0
        ? `declares relation characteristics ${characteristics.join(', ')}`
        : 'declares no additional relation characteristic',
      ...optionalExactFact(element, 'inverseOf', 'declares authored inverse relation'),
      ...commonDifferentia(element),
    ],
    excludes: [
      'a literal-valued attribute type whose range is a value space',
      'a reified association type with participant roles and contextual attributes',
    ],
  };
}

function attributeTypeSemantics(element) {
  const facts = [];
  if (element.defaultCardinality && typeof element.defaultCardinality === 'object') {
    assertReviewBoundNestedShape(
      element.defaultCardinality,
      ['minCount', 'maxCount'],
      'attributeTypes.defaultCardinality',
    );
    facts.push(
      `has default cardinality ${cardinalityText(
        element.defaultCardinality.minCount,
        element.defaultCardinality.maxCount,
      )}`,
    );
  } else {
    facts.push('declares no default cardinality');
  }
  if (Object.prototype.hasOwnProperty.call(element, 'pattern')) {
    facts.push(`restricts lexical form with pattern ${exactText(element.pattern)}`);
  } else {
    facts.push('declares no lexical pattern restriction');
  }
  facts.push(...optionalExactFact(
    element,
    'owlProjectionOverride',
    'declares authored OWL projection override',
  ));
  facts.push(...optionalExactFact(element, 'enumValues', 'declares authored enum values'));
  facts.push(...optionalExactFact(element, 'unit', 'declares authored unit'));
  return {
    genus: `attribute type whose declared value type is ${exactText(element.valueType)}`,
    differentia: [...facts, ...commonDifferentia(element)],
    excludes: [
      'a binary semantic relation between domain records',
      'a reified association type with participant-role semantics',
    ],
  };
}

function identifierTypeSemantics(element) {
  return {
    genus: `identifier type whose lexical base type is ${exactText(element.baseType)}`,
    differentia: [
      `is governed by standard ${exactText(element.standard)}`,
      ...(Object.prototype.hasOwnProperty.call(element, 'issuingAuthority')
        ? [`is issued under authority ${exactText(element.issuingAuthority)}`]
        : ['declares no issuing authority']),
      `is validated by constraint ${exactText(element.validatorRef)}`,
      ...commonDifferentia(element),
    ],
    excludes: [
      'a controlled code-list type with an enumerated member set',
      'an identity-bearing domain object type represented by versioned records',
    ],
  };
}

function codeListSemantics(element) {
  const values = Array.isArray(element.values) ? element.values : [];
  const notations = values.map((value) => exactText(value.notation));
  return {
    genus: `versioned closed code-list type maintained by ${exactText(element.maintainer)}`,
    differentia: [
      `has vocabulary title ${exactText(element.vocabulary)}`,
      `has authored vocabulary version ${exactText(element.version)}`,
      `contains exactly ${values.length} members with canonical notations ${sortedText(notations).join(', ')}`,
      // Code-member IRIs are generated entries whose definition is inherited
      // from CodeValueDefinition.  Binding every exact value record into the
      // reviewed containing card prevents an unreviewed member label or
      // definition change from passing by updating only the inheritance digest.
      ...values.map((value) => `binds exact authored code value ${canonicalJcs(value)}`),
      `binds source evidence ${exactText(element.sourceEvidenceRef)}`,
      ...commonDifferentia(element),
    ],
    excludes: [
      'an identifier type whose valid lexical space is not an enumerated member set',
      'an attribute type that merely selects values from this vocabulary',
    ],
  };
}

function constraintSemantics(element) {
  const expression = element.expression && typeof element.expression === 'object'
    ? element.expression
    : {};
  assertReviewBoundNestedShape(
    expression,
    ['language', 'expression', 'expressionDigest'],
    'constraints.expression',
  );
  const target = Object.prototype.hasOwnProperty.call(element, 'targetElement')
    ? `targets ${exactText(element.targetElement)}`
    : 'declares module scope without a single target element';
  return {
    genus: `${exactText(element.constraintType)} constraint with ${exactText(element.scope)} scope`,
    differentia: [
      target,
      `evaluates ${exactText(expression.language)} expression ${exactText(expression.expression)}`,
      ...optionalExactFact(expression, 'expressionDigest', 'binds authored expression digest'),
      `reports severity ${exactText(element.severity)} with message ${exactText(element.message)}`,
      ...optionalExactFact(element, 'note', 'binds authored explanatory note'),
      ...optionalExactFact(element, 'parameters', 'binds authored constraint parameters'),
      ...optionalExactFact(element, 'dependencies', 'binds authored constraint dependencies'),
      ...commonDifferentia(element),
    ],
    excludes: [
      'a non-enforceable explanatory note without constraint severity or expression semantics',
      'an ontology type or property declaration rather than an enforceable rule',
    ],
  };
}

const DERIVERS = Object.freeze({
  associationTypes: associationTypeSemantics,
  attributeTypes: attributeTypeSemantics,
  codeLists: codeListSemantics,
  constraints: constraintSemantics,
  identifierTypes: identifierTypeSemantics,
  objectTypes: objectTypeSemantics,
  relationTypes: relationTypeSemantics,
});

function deriveTermCardSemantics(containerKind, element) {
  if (!Object.prototype.hasOwnProperty.call(DERIVERS, containerKind)) {
    throw new Error(`unsupported term-card source container ${String(containerKind)}`);
  }
  assertReviewBoundSourceShape(containerKind, element);
  const derived = DERIVERS[containerKind](element);
  return {
    candidateM3Type: candidateM3TypeFor(containerKind, element),
    genus: derived.genus,
    differentia: sortedText(derived.differentia),
    excludes: sortedText(derived.excludes),
  };
}

module.exports = {
  CANDIDATE_M3_TYPE_IRIS,
  CANDIDATE_M3_TYPES,
  MONEY_M3_TYPE,
  MONEY_VALUE,
  QUANTITY_M3_TYPE,
  QUANTITY_VALUE,
  candidateM3TypeAllowedForContainer,
  candidateM3TypeFor,
  deriveTermCardSemantics,
};
