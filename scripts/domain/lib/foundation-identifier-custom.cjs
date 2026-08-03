'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const FOUNDATION_BASE = 'https://axiolune.ai/ontology/finance/foundation/';
const SCHEMA_VERSION = '1.0';
const LOCAL_SCHEME_VALIDATOR_DIGEST_TAG =
  'axiolune-local-identifier-scheme-validator-v1\0';
const MAX_INPUT_UTF8_BYTES = 256;
const IDENTIFIER_CORE_PATH = path.resolve(
  __dirname,
  '..',
  'identifier-custom-profile',
  'v0.3.0',
  'foundation-identifier-core.wasm',
);
const EXPECTED_WASM_EXPORTS = Object.freeze([
  'memory',
  'validate_isin',
  'validate_lei',
  'validate_local',
  'validate_mic',
]);
const LOCAL_SCHEME_VALIDATORS = Object.freeze({
  'https://axiolune.ai/validators/local/account-id-v1': Object.freeze({
    flags: 'u',
    kind: 'regex',
    pattern: '^[A-Z0-9][A-Z0-9._-]{0,63}$',
    schemeId: 1,
  }),
  'https://axiolune.ai/validators/local/internal-instrument-id-v1': Object.freeze({
    flags: 'u',
    kind: 'regex',
    pattern: '^[A-Z0-9][A-Z0-9._:-]{0,63}$',
    schemeId: 2,
  }),
});

const CONSTRAINTS = Object.freeze({
  [`${FOUNDATION_BASE}ISINValidation`]: Object.freeze({
    capabilityId: 'foundation-isin-validation',
    profile: 'ISIN',
    targetIdentifierTypeIri: `${FOUNDATION_BASE}ISIN`,
  }),
  [`${FOUNDATION_BASE}LEIValidation`]: Object.freeze({
    capabilityId: 'foundation-lei-validation',
    profile: 'LEI',
    targetIdentifierTypeIri: `${FOUNDATION_BASE}LEI`,
  }),
  [`${FOUNDATION_BASE}LocalIdentifierValidation`]: Object.freeze({
    capabilityId: 'foundation-local-identifier-validation',
    profile: 'LocalIdentifier',
    targetIdentifierTypeIri: `${FOUNDATION_BASE}LocalIdentifier`,
  }),
  [`${FOUNDATION_BASE}MICValidation`]: Object.freeze({
    capabilityId: 'foundation-mic-validation',
    profile: 'MIC',
    targetIdentifierTypeIri: `${FOUNDATION_BASE}MIC`,
  }),
});

const INPUT_FIELDS = Object.freeze([
  'constraintDefinitionIri',
  'focusNode',
  'lexicalValue',
  'schemaVersion',
  'schemeValidatorRef',
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function absoluteIri(value) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return parsed.href === value;
  } catch {
    return false;
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function localSchemeValidatorDigest(value) {
  const payload = {
    flags: value.flags,
    kind: value.kind,
    pattern: value.pattern,
    validatorRef: value.validatorRef,
  };
  return sha256(Buffer.concat([
    Buffer.from(LOCAL_SCHEME_VALIDATOR_DIGEST_TAG, 'utf8'),
    Buffer.from(canonicalJcs(payload), 'utf8'),
  ]));
}

function validateIsolatedWasmModule(bytes) {
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (cause) {
    const error = new Error(`identifier WASM is invalid: ${cause.message}`);
    error.code = 'IDENTIFIER_WASM_INVALID';
    throw error;
  }
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    const error = new Error(`identifier WASM must have zero imports; found ${imports.length}`);
    error.code = 'IDENTIFIER_WASM_HOST_IMPORT';
    throw error;
  }
  const exports = WebAssembly.Module.exports(module)
    .map((entry) => entry.name)
    .sort(compareUtf8);
  if (exports.length !== EXPECTED_WASM_EXPORTS.length
      || exports.some((name, index) => name !== [...EXPECTED_WASM_EXPORTS].sort(compareUtf8)[index])) {
    const error = new Error(`identifier WASM exports differ: ${exports.join(',')}`);
    error.code = 'IDENTIFIER_WASM_EXPORTS';
    throw error;
  }
  const instance = new WebAssembly.Instance(module, {});
  if (!(instance.exports.memory instanceof WebAssembly.Memory)
      || instance.exports.memory.buffer.byteLength !== 65536) {
    const error = new Error('identifier WASM memory must begin at exactly one 64-KiB page');
    error.code = 'IDENTIFIER_WASM_MEMORY';
    throw error;
  }
  let growthDenied = false;
  try {
    instance.exports.memory.grow(1);
  } catch (cause) {
    growthDenied = cause instanceof RangeError;
  }
  if (!growthDenied || instance.exports.memory.buffer.byteLength !== 65536) {
    const error = new Error('identifier WASM memory maximum must be exactly one 64-KiB page');
    error.code = 'IDENTIFIER_WASM_MEMORY_MAXIMUM';
    throw error;
  }
  return { instance, module };
}

const identifierCoreBytes = fs.readFileSync(IDENTIFIER_CORE_PATH);
const identifierCore = validateIsolatedWasmModule(identifierCoreBytes);

function wasmCoreValidate(exportName, value, schemeId = 0) {
  if (typeof value !== 'string') return 1;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_INPUT_UTF8_BYTES) return 6;
  const memory = new Uint8Array(identifierCore.instance.exports.memory.buffer);
  memory.fill(0, 0, 2048);
  memory.set(bytes, 0);
  const operation = identifierCore.instance.exports[exportName];
  if (typeof operation !== 'function') throw new Error(`missing identifier WASM export ${exportName}`);
  return exportName === 'validate_local'
    ? operation(0, bytes.length, schemeId)
    : operation(0, bytes.length);
}

function normalizeSchemeValidatorRegistry(registry) {
  if (!isPlainObject(registry)
      || Object.keys(registry).sort().join('\0') !== ['schemaVersion', 'validators'].sort().join('\0')
      || registry.schemaVersion !== SCHEMA_VERSION
      || !Array.isArray(registry.validators)
      || registry.validators.length === 0) {
    throw new TypeError('scheme-validator registry is outside its closed v1 contract');
  }
  const result = new Map();
  let previous = null;
  for (const [index, validator] of registry.validators.entries()) {
    const expectedFields = ['digest', 'flags', 'kind', 'pattern', 'validatorRef'];
    if (!isPlainObject(validator)
        || Object.keys(validator).sort().join('\0') !== expectedFields.sort().join('\0')) {
      throw new TypeError(`scheme-validator registry entry ${index} has unknown or missing fields`);
    }
    if (!absoluteIri(validator.validatorRef)
        || validator.kind !== 'regex'
        || validator.flags !== 'u'
        || typeof validator.pattern !== 'string'
        || validator.pattern === ''
        || validator.pattern !== validator.pattern.normalize('NFC')
        || Buffer.byteLength(validator.pattern, 'utf8') > 512) {
      throw new TypeError(`scheme-validator registry entry ${index} is invalid`);
    }
    if (previous !== null && compareUtf8(previous, validator.validatorRef) >= 0) {
      throw new TypeError('scheme-validator registry entries must be strictly UTF-8 sorted and unique');
    }
    if (validator.digest !== localSchemeValidatorDigest(validator)) {
      throw new TypeError(`scheme-validator registry entry ${index} digest mismatch`);
    }
    const locked = LOCAL_SCHEME_VALIDATORS[validator.validatorRef];
    if (!locked
        || validator.kind !== locked.kind
        || validator.pattern !== locked.pattern
        || validator.flags !== locked.flags) {
      throw new TypeError(`scheme-validator registry entry ${index} is not implemented by the WASM core`);
    }
    result.set(validator.validatorRef, Object.freeze({ ...validator, schemeId: locked.schemeId }));
    previous = validator.validatorRef;
  }
  return result;
}

function isinChecksumValid(value) {
  return wasmCoreValidate('validate_isin', value) === 0;
}

function leiChecksumValid(value) {
  return wasmCoreValidate('validate_lei', value) === 0;
}

function validateInput(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  const fields = Object.keys(input).sort();
  if (fields.join('\0') !== [...INPUT_FIELDS].sort().join('\0')) {
    return `input fields differ from the closed contract: ${fields.join(',')}`;
  }
  if (input.schemaVersion !== SCHEMA_VERSION) return 'schemaVersion must equal 1.0';
  if (!absoluteIri(input.constraintDefinitionIri)) {
    return 'constraintDefinitionIri must be a canonical absolute IRI';
  }
  if (!absoluteIri(input.focusNode)) return 'focusNode must be a canonical absolute IRI';
  if (typeof input.lexicalValue !== 'string'
      || hasUnpairedSurrogate(input.lexicalValue)
      || input.lexicalValue !== input.lexicalValue.normalize('NFC')) {
    // Non-NFC is a domain violation, so only type and scalar validity are input-contract failures.
    if (typeof input.lexicalValue !== 'string' || hasUnpairedSurrogate(input.lexicalValue)) {
      return 'lexicalValue must be a Unicode scalar string';
    }
  }
  if (Buffer.byteLength(input.lexicalValue, 'utf8') > MAX_INPUT_UTF8_BYTES) {
    return `lexicalValue exceeds ${MAX_INPUT_UTF8_BYTES} UTF-8 bytes`;
  }
  if (input.schemeValidatorRef !== null && !absoluteIri(input.schemeValidatorRef)) {
    return 'schemeValidatorRef must be null or a canonical absolute IRI';
  }
  return null;
}

function violation(input, code, message) {
  return {
    code,
    constraintDefinitionIri: input.constraintDefinitionIri,
    focusNode: input.focusNode,
    message,
  };
}

function engineFailure(input, code, message) {
  return {
    constraintDefinitionIri: absoluteIri(input?.constraintDefinitionIri)
      ? input.constraintDefinitionIri : null,
    errors: [{ code, message }],
    focusNode: absoluteIri(input?.focusNode) ? input.focusNode : null,
    outcome: 'engineFailure',
    schemaVersion: SCHEMA_VERSION,
    violations: [],
  };
}

function executeIdentifierConstraint(input, registry) {
  const inputError = validateInput(input);
  if (inputError) return engineFailure(input, 'IDENTIFIER_INPUT_CONTRACT', inputError);
  const definition = CONSTRAINTS[input.constraintDefinitionIri];
  if (!definition) {
    return engineFailure(
      input,
      'IDENTIFIER_CUSTOM_UNBOUND',
      `no locked capability is bound to ${input.constraintDefinitionIri}`,
    );
  }

  let validators;
  try {
    validators = registry instanceof Map ? registry : normalizeSchemeValidatorRegistry(registry);
  } catch (cause) {
    return engineFailure(input, 'IDENTIFIER_SCHEME_REGISTRY', cause.message);
  }

  const violations = [];
  if (definition.profile !== 'LocalIdentifier' && input.schemeValidatorRef !== null) {
    return engineFailure(
      input,
      'IDENTIFIER_INPUT_CONTRACT',
      `${definition.profile} does not accept a schemeValidatorRef`,
    );
  }

  if (definition.profile === 'ISIN') {
    const result = wasmCoreValidate('validate_isin', input.lexicalValue);
    if (result === 1) {
      violations.push(violation(
        input,
        'ISIN_LEXICAL_FORM',
        'ISIN must contain exactly 12 uppercase ASCII alphanumeric characters with a numeric check digit',
      ));
    } else if (result === 2) {
      violations.push(violation(input, 'ISIN_CHECK_DIGIT', 'ISIN Luhn check digit is invalid'));
    } else if (result !== 0) {
      return engineFailure(input, 'IDENTIFIER_WASM_RESULT', `unexpected ISIN WASM result ${result}`);
    }
  } else if (definition.profile === 'LEI') {
    const result = wasmCoreValidate('validate_lei', input.lexicalValue);
    if (result === 1) {
      violations.push(violation(
        input,
        'LEI_LEXICAL_FORM',
        'LEI must contain exactly 18 uppercase ASCII alphanumeric characters and two numeric check digits',
      ));
    } else if (result === 2) {
      violations.push(violation(
        input,
        'LEI_CHECK_DIGIT',
        'LEI does not satisfy ISO/IEC 7064 MOD 97-10',
      ));
    } else if (result !== 0) {
      return engineFailure(input, 'IDENTIFIER_WASM_RESULT', `unexpected LEI WASM result ${result}`);
    }
  } else if (definition.profile === 'MIC') {
    const result = wasmCoreValidate('validate_mic', input.lexicalValue);
    if (result === 1) {
      violations.push(violation(
        input,
        'MIC_LEXICAL_FORM',
        'MIC must contain exactly four uppercase ASCII alphanumeric characters',
      ));
    } else if (result !== 0) {
      return engineFailure(input, 'IDENTIFIER_WASM_RESULT', `unexpected MIC WASM result ${result}`);
    }
  } else if (definition.profile === 'LocalIdentifier') {
    if (input.lexicalValue !== input.lexicalValue.normalize('NFC')) {
      violations.push(violation(input, 'LOCAL_IDENTIFIER_NOT_NFC', 'local identifier must be Unicode NFC'));
    }
    if (input.schemeValidatorRef === null) {
      violations.push(violation(
        input,
        'LOCAL_IDENTIFIER_SCHEME_VALIDATOR_REQUIRED',
        'local identifier requires a source-locked scheme validator',
      ));
    } else {
      const validator = validators.get(input.schemeValidatorRef);
      if (!validator) {
        return engineFailure(
          input,
          'LOCAL_IDENTIFIER_SCHEME_VALIDATOR_UNBOUND',
          `scheme validator ${input.schemeValidatorRef} is absent from the locked registry`,
        );
      }
      const result = wasmCoreValidate('validate_local', input.lexicalValue, validator.schemeId);
      if (result === 3) {
        violations.push(violation(input, 'LOCAL_IDENTIFIER_EMPTY', 'local identifier must be non-empty'));
      } else if (result === 4) {
        violations.push(violation(
          input,
          'LOCAL_IDENTIFIER_SCHEME_SYNTAX',
          `local identifier does not satisfy locked scheme validator ${input.schemeValidatorRef}`,
        ));
      } else if (result !== 0) {
        return engineFailure(input, 'IDENTIFIER_WASM_RESULT', `unexpected LocalIdentifier WASM result ${result}`);
      }
    }
  }

  return {
    constraintDefinitionIri: input.constraintDefinitionIri,
    errors: [],
    focusNode: input.focusNode,
    outcome: violations.length === 0 ? 'conforms' : 'violation',
    schemaVersion: SCHEMA_VERSION,
    violations,
  };
}

function validateIsin(value, label = 'ISIN') {
  if (typeof value !== 'string' || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/u.test(value)) {
    const error = new Error(`${label} is not a 12-character ISIN`);
    error.code = 'CQ_IDENTIFIER_LEXICAL_FORM';
    throw error;
  }
  if (!isinChecksumValid(value)) {
    const error = new Error(`${label} has an invalid ISIN check digit`);
    error.code = 'CQ_IDENTIFIER_LEXICAL_FORM';
    throw error;
  }
}

module.exports = {
  CONSTRAINTS,
  FOUNDATION_BASE,
  IDENTIFIER_CORE_PATH,
  INPUT_FIELDS,
  LOCAL_SCHEME_VALIDATORS,
  LOCAL_SCHEME_VALIDATOR_DIGEST_TAG,
  MAX_INPUT_UTF8_BYTES,
  SCHEMA_VERSION,
  absoluteIri,
  executeIdentifierConstraint,
  isinChecksumValid,
  leiChecksumValid,
  localSchemeValidatorDigest,
  normalizeSchemeValidatorRegistry,
  validateIsolatedWasmModule,
  validateIsin,
  wasmCoreValidate,
};
