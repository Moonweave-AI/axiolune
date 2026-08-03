'use strict';

const { TextDecoder } = require('node:util');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const EXPECTED_RULE = {
  rules: {
    codeMember: {
      sourceField: 'codeValueIri',
    },
    logicalIdentityClass: {
      sourceField: 'typeIri',
      suffix: '/LogicalIdentity',
    },
    rolePredicate: {
      containingTypeField: 'containingType',
      roleField: 'roleId',
      separator: '/role/',
    },
  },
  schemaVersion: '1.0',
};

function parseLockedRule(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('generation rule must be non-empty bytes');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`generation rule is not valid UTF-8: ${error.message}`);
  }
  let rule;
  try {
    rule = JSON.parse(text);
  } catch (error) {
    throw new Error(`generation rule is not JSON: ${error.message}`);
  }
  if (`${canonicalJcs(rule)}\n` !== text) {
    throw new Error('generation rule must be exact UTF-8 JCS followed by one LF');
  }
  if (canonicalJcs(rule) !== canonicalJcs(EXPECTED_RULE)) {
    throw new Error('generation rule does not equal the v1 closed rule contract');
  }
  return rule;
}

function requireAbsoluteIri(value, field) {
  if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) {
    throw new Error(`${field} must be an absolute normalized IRI`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) throw new Error('not canonical');
  } catch {
    throw new Error(`${field} must be an absolute normalized IRI`);
  }
}

function evaluatePublicIriGeneration({ bytes, generatedKind, source }) {
  parseLockedRule(bytes);
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('generation source must be an object');
  }
  if (generatedKind === 'codeMember') {
    if (canonicalJcs(Object.keys(source).sort())
        !== canonicalJcs(['codeListIri', 'codeValueIri', 'kind'].sort())
        || source.kind !== 'codeValue') {
      throw new Error('codeMember requires the exact CodeValue source tuple');
    }
    requireAbsoluteIri(source.codeListIri, 'source.codeListIri');
    requireAbsoluteIri(source.codeValueIri, 'source.codeValueIri');
    return source.codeValueIri;
  }
  if (generatedKind === 'logicalIdentityClass') {
    if (canonicalJcs(Object.keys(source).sort())
        !== canonicalJcs(['kind', 'typeIri'].sort())
        || source.kind !== 'logicalIdentityClass') {
      throw new Error('logicalIdentityClass requires the exact type source tuple');
    }
    requireAbsoluteIri(source.typeIri, 'source.typeIri');
    return `${source.typeIri}/LogicalIdentity`;
  }
  if (generatedKind === 'rolePredicate') {
    if (canonicalJcs(Object.keys(source).sort())
        !== canonicalJcs(['containingType', 'kind', 'roleId'].sort())
        || source.kind !== 'participantRole') {
      throw new Error('rolePredicate requires the exact ParticipantRole source tuple');
    }
    requireAbsoluteIri(source.containingType, 'source.containingType');
    if (typeof source.roleId !== 'string' || !/^[a-z][A-Za-z0-9]*$/u.test(source.roleId)) {
      throw new Error('source.roleId must be canonical lowerCamelCase ASCII');
    }
    return `${source.containingType}/role/${source.roleId}`;
  }
  throw new Error(`unsupported generatedKind ${generatedKind}`);
}

module.exports = {
  EXPECTED_RULE,
  evaluatePublicIriGeneration,
  parseLockedRule,
};
