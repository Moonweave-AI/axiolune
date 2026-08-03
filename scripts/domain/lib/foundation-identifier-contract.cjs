'use strict';

const FOUNDATION_MODULE_IRI = 'https://axiolune.ai/ontology/finance/foundation';
const ISIN_STANDARD = 'ISO 6166:2021';
const ISIN_ISSUING_AUTHORITY = 'ANNA-recognized National Numbering Agency or Derivatives Service Bureau, according to instrument scope';
const LEI_STANDARD = 'ISO 17442-1:2020';
const LEI_ISSUING_AUTHORITY = 'a GLEIF-accredited LEI Issuer (Local Operating Unit)';
const MIC_STANDARD = 'ISO 10383:2012';
const MIC_ISSUING_AUTHORITY = 'SWIFT as ISO 10383 Registration Authority';
const ISIN_DEFINITION = '12-character alphanumeric ISO 6166 identifier with a two-alpha-character ISIN prefix, '
  + 'nine-character basic number (body), and modulus-10 Double-Add-Double check digit';
const LEI_DEFINITION = '20-character uppercase alphanumeric identifier based on ISO 17442-1:2020 that uniquely '
  + 'identifies a legal entity, consisting of a 4-character issuer prefix, 14-character entity-specific section, '
  + 'and 2 numeric check digits calculated under ISO 7064';
const MIC_DEFINITION = 'four-character uppercase ASCII alphanumeric code allocated under ISO 10383 to identify '
  + 'an exchange, trading platform, market, or trade-reporting facility; operating/segment classification remains '
  + 'separate registry data';
const COUNTRY_ONLY_ISIN_PREFIX = ['ISO 3166-1', 'country code'].join(' ');
const COUNTRY_ONLY_ISIN_PREFIX_RE = new RegExp(COUNTRY_ONLY_ISIN_PREFIX, 'iu');

const IDENTIFIER_PROFILES = Object.freeze({
  ISIN: Object.freeze({
    standard: ISIN_STANDARD,
    authority: ISIN_ISSUING_AUTHORITY,
    definition: ISIN_DEFINITION,
  }),
  LEI: Object.freeze({
    standard: LEI_STANDARD,
    authority: LEI_ISSUING_AUTHORITY,
    definition: LEI_DEFINITION,
  }),
  MIC: Object.freeze({
    standard: MIC_STANDARD,
    authority: MIC_ISSUING_AUTHORITY,
    definition: MIC_DEFINITION,
  }),
});

function validateFoundationIdentifierContract(document) {
  const findings = [];
  const identifiers = document?.domain?.identifierTypes;
  const constraints = document?.domain?.constraints;
  const bindings = Array.isArray(document?.domain?.constraintBindings)
    ? document.domain.constraintBindings : [];

  function report(code, location, message) {
    findings.push({ code, location, message });
  }

  if (!identifiers || typeof identifiers !== 'object' || Array.isArray(identifiers)) {
    report(
      'FOUNDATION_IDENTIFIER_TYPES_MISSING',
      'domain.identifierTypes',
      'Foundation must declare the reviewed identifier-type contracts',
    );
    return findings;
  }

  const isin = identifiers.ISIN;
  if (!isin || typeof isin !== 'object' || Array.isArray(isin)) {
    report('FOUNDATION_ISIN_MISSING', 'domain.identifierTypes.ISIN', 'ISIN identifier type is required');
  } else {
    if (isin.standard !== ISIN_STANDARD) {
      report(
        'FOUNDATION_ISIN_STANDARD_MISMATCH',
        'domain.identifierTypes.ISIN.standard',
        `expected exact standard ${ISIN_STANDARD}`,
      );
    }
    if (isin.issuingAuthority !== ISIN_ISSUING_AUTHORITY) {
      report(
        'FOUNDATION_ISIN_ISSUER_MISMATCH',
        'domain.identifierTypes.ISIN.issuingAuthority',
        `expected exact issuing authority ${ISIN_ISSUING_AUTHORITY}`,
      );
    }
    const definition = typeof isin.definition === 'string' ? isin.definition : '';
    const requiredTerms = [
      ['ISIN prefix', /\bISIN prefix\b/iu],
      ['basic number', /\bbasic number\b/iu],
      ['modulus-10 Double-Add-Double check digit', /modulus-10 Double-Add-Double check digit/iu],
    ];
    for (const [term, pattern] of requiredTerms) {
      if (!pattern.test(definition)) {
        report(
          'FOUNDATION_ISIN_DEFINITION_INCOMPLETE',
          'domain.identifierTypes.ISIN.definition',
          `ISIN definition must state the ${term}`,
        );
      }
    }
    if (COUNTRY_ONLY_ISIN_PREFIX_RE.test(definition)) {
      report(
        'FOUNDATION_ISIN_COUNTRY_ONLY_PREFIX',
        'domain.identifierTypes.ISIN.definition',
        'ISIN prefixes must not be narrowed to country-code assignments; Registration Authority substitute prefixes are valid',
      );
    }
  }

  const lei = identifiers.LEI;
  if (!lei || typeof lei !== 'object' || Array.isArray(lei)) {
    report('FOUNDATION_LEI_MISSING', 'domain.identifierTypes.LEI', 'LEI identifier type is required');
  } else {
    if (lei.standard !== LEI_STANDARD) {
      report(
        'FOUNDATION_LEI_STANDARD_MISMATCH',
        'domain.identifierTypes.LEI.standard',
        `expected exact standard ${LEI_STANDARD}`,
      );
    }
    if (lei.issuingAuthority !== LEI_ISSUING_AUTHORITY) {
      report(
        'FOUNDATION_LEI_ISSUER_MISMATCH',
        'domain.identifierTypes.LEI.issuingAuthority',
        `expected exact issuing authority ${LEI_ISSUING_AUTHORITY}`,
      );
    }
    const definition = typeof lei.definition === 'string' ? lei.definition : '';
    const requiredTerms = [
      [LEI_STANDARD, /ISO 17442-1:2020/iu],
      ['4-character issuer prefix', /4-character issuer prefix/iu],
      ['14-character entity-specific section', /14-character entity-specific section/iu],
      ['2 numeric check digits', /2 numeric check digits/iu],
      ['ISO 7064 check-digit semantics', /ISO 7064/iu],
    ];
    for (const [term, pattern] of requiredTerms) {
      if (!pattern.test(definition)) {
        report(
          'FOUNDATION_LEI_DEFINITION_INCOMPLETE',
          'domain.identifierTypes.LEI.definition',
          `LEI definition must state ${term}`,
        );
      }
    }
  }

  const mic = identifiers.MIC;
  if (!mic || typeof mic !== 'object' || Array.isArray(mic)) {
    report('FOUNDATION_MIC_MISSING', 'domain.identifierTypes.MIC', 'MIC identifier type is required');
  } else {
    if (mic.standard !== MIC_STANDARD) {
      report(
        'FOUNDATION_MIC_STANDARD_MISMATCH',
        'domain.identifierTypes.MIC.standard',
        `expected exact standard ${MIC_STANDARD}`,
      );
    }
    if (mic.issuingAuthority !== MIC_ISSUING_AUTHORITY) {
      report(
        'FOUNDATION_MIC_ISSUER_MISMATCH',
        'domain.identifierTypes.MIC.issuingAuthority',
        `expected exact issuing authority ${MIC_ISSUING_AUTHORITY}`,
      );
    }
    const definition = typeof mic.definition === 'string' ? mic.definition : '';
    const requiredTerms = [
      ['four-character uppercase ASCII alphanumeric code', /four-character uppercase ASCII alphanumeric code/iu],
      ['ISO 10383', /ISO 10383/iu],
      ['trade-reporting facility', /trade-reporting facility/iu],
      ['separate operating/segment registry data', /operating\/segment classification remains separate registry data/iu],
    ];
    for (const [term, pattern] of requiredTerms) {
      if (!pattern.test(definition)) {
        report(
          'FOUNDATION_MIC_DEFINITION_INCOMPLETE',
          'domain.identifierTypes.MIC.definition',
          `MIC definition must state ${term}`,
        );
      }
    }
    if (/4\s*\+\s*4/iu.test(definition)) {
      report(
        'FOUNDATION_MIC_EIGHT_CHARACTER_CONCATENATION',
        'domain.identifierTypes.MIC.definition',
        'MIC lexical identity must not concatenate operating and segment codes',
      );
    }
  }

  for (const identifierName of ['ISIN', 'LEI', 'MIC', 'LocalIdentifier']) {
    const identifier = identifiers[identifierName];
    const validatorRef = identifier?.validatorRef;
    const constraint = Object.values(constraints || {}).find((value) => (
      value?.iri === validatorRef
    ));
    const exactBindings = bindings.filter((binding) => (
      binding?.constraintRef === validatorRef
      && binding?.targetElement === identifier?.iri
      && binding?.enforcementLevel === 'Mandatory'
    ));
    const allValidatorBindings = bindings.filter((binding) => (
      binding?.constraintRef === validatorRef
    ));
    if (!constraint || constraint.expression?.language !== 'Custom'
        || constraint.targetElement !== identifier?.iri) {
      report(
        'FOUNDATION_IDENTIFIER_VALIDATOR_CONSTRAINT_MISMATCH',
        `domain.identifierTypes.${identifierName}.validatorRef`,
        `${identifierName} validatorRef must resolve to its exact targeted Custom ConstraintDefinition`,
      );
    }
    if (exactBindings.length !== 1 || allValidatorBindings.length !== 1) {
      report(
        'FOUNDATION_IDENTIFIER_VALIDATOR_BINDING_MISSING',
        'domain.constraintBindings',
        `${identifierName} validator must have exactly one exact Mandatory ConstraintBinding`,
      );
    }
  }

  return findings;
}

module.exports = {
  FOUNDATION_MODULE_IRI,
  IDENTIFIER_PROFILES,
  ISIN_DEFINITION,
  ISIN_ISSUING_AUTHORITY,
  ISIN_STANDARD,
  LEI_DEFINITION,
  LEI_ISSUING_AUTHORITY,
  LEI_STANDARD,
  MIC_DEFINITION,
  MIC_ISSUING_AUTHORITY,
  MIC_STANDARD,
  validateFoundationIdentifierContract,
};
