'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const SOURCE_ELEMENT_KEY_TAG = 'axiolune-source-element-key-v1\0';
const PUBLIC_SYMBOL_MANIFEST_TAG = 'axiolune-public-symbol-manifest-v1\0';
const MONEY_VALUE = 'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount';
const QUANTITY_VALUE = 'https://axiolune.ai/ontology/meta/core/values/QuantityValue';
const ROLE_ID_RE = /^[a-z][A-Za-z0-9]*$/u;

const CONTAINER_META_TYPES = Object.freeze({
  objectTypes: 'ObjectTypeDefinition',
  associationTypes: 'AssociationTypeDefinition',
  relationTypes: 'RelationTypeDefinition',
  attributeTypes: 'AttributeTypeDefinition',
  identifierTypes: 'IdentifierTypeDefinition',
  codeLists: 'CodeListTypeDefinition',
  constraints: 'ConstraintDefinition',
});

class PublicSymbolCompilationError extends Error {
  constructor(errors) {
    super(errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join('\n'));
    this.name = 'PublicSymbolCompilationError';
    this.errors = errors;
  }
}

function issue(errors, code, path, message) {
  errors.push({ code, path, message });
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function artifactDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function isAbsoluteCanonicalIri(value) {
  if (typeof value !== 'string' || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
}

function taggedJcsDigest(tag, value) {
  return artifactDigest(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function classifier(containerKind, element) {
  if (containerKind !== 'attributeTypes') return CONTAINER_META_TYPES[containerKind];
  if (element.valueType === MONEY_VALUE) return 'MoneyTypeDefinition';
  if (element.valueType === QUANTITY_VALUE) return 'QuantityTypeDefinition';
  return 'AttributeTypeDefinition';
}

function sourceKey(source) {
  return taggedJcsDigest(SOURCE_ELEMENT_KEY_TAG, source);
}

function validateModuleInput(doc, moduleIndex, errors) {
  const at = `modules[${moduleIndex}]`;
  if (!isPlainObject(doc) || !isPlainObject(doc.module) || !isPlainObject(doc.domain)) {
    issue(errors, 'INVALID_MODULE', at, 'expected a module/domain object');
    return false;
  }
  if (!isAbsoluteCanonicalIri(doc.module.moduleIri)) {
    issue(errors, 'INVALID_MODULE_IRI', `${at}.module.moduleIri`, 'expected a canonical absolute IRI');
  }
  if (!Array.isArray(doc.module.exports)) {
    issue(errors, 'INVALID_EXPORTS', `${at}.module.exports`, 'expected an array');
  }
  return true;
}

function compilePublicSymbolManifest(moduleDocs, options = {}) {
  const errors = [];
  const profileRef = options.profileRef || PROFILE_REF;
  if (!isAbsoluteCanonicalIri(profileRef)) {
    issue(errors, 'INVALID_PROFILE_REF', 'profileRef', 'expected a canonical absolute IRI');
  }
  if (!Array.isArray(moduleDocs) || moduleDocs.length === 0) {
    issue(errors, 'EMPTY_MODULE_SET', 'modules', 'expected a non-empty module list');
    throw new PublicSymbolCompilationError(errors);
  }

  const symbols = [];
  const publicIris = new Map();
  const sourceKeys = new Map();

  function addSymbol(symbol, source, path) {
    if (publicIris.has(symbol.publicIri)) {
      issue(
        errors,
        'DUPLICATE_PUBLIC_IRI',
        path,
        `public IRI already emitted from ${publicIris.get(symbol.publicIri)}`,
      );
      return;
    }
    const key = sourceKey(source);
    if (sourceKeys.has(key)) {
      issue(
        errors,
        'DUPLICATE_SOURCE_ELEMENT_KEY',
        path,
        `semantic source already emitted at ${sourceKeys.get(key)}`,
      );
      return;
    }
    publicIris.set(symbol.publicIri, path);
    sourceKeys.set(key, path);
    symbols.push({ ...symbol, sourceElementKey: key });
  }

  for (let moduleIndex = 0; moduleIndex < moduleDocs.length; moduleIndex += 1) {
    const doc = moduleDocs[moduleIndex];
    if (!validateModuleInput(doc, moduleIndex, errors)) continue;
    const ownerModule = doc.module.moduleIri;
    const explicitExports = new Set(doc.module.exports || []);
    if (explicitExports.size !== (doc.module.exports || []).length) {
      issue(errors, 'DUPLICATE_EXPORT', `modules[${moduleIndex}].module.exports`, 'exports must be unique');
    }
    const exportsAll = explicitExports.size === 0;
    const authoredByIri = new Map();

    for (const [containerKind, metaType] of Object.entries(CONTAINER_META_TYPES)) {
      const container = doc.domain[containerKind];
      if (container === undefined) continue;
      if (!isPlainObject(container)) {
        issue(
          errors,
          'INVALID_TYPED_CONTAINER',
          `modules[${moduleIndex}].domain.${containerKind}`,
          'expected an object map',
        );
        continue;
      }
      for (const [localName, element] of Object.entries(container)) {
        const path = `modules[${moduleIndex}].domain.${containerKind}.${localName}`;
        if (!isPlainObject(element)
            || !isAbsoluteCanonicalIri(element.iri)) {
          issue(errors, 'INVALID_AUTHORED_ELEMENT', path, 'element must have a canonical absolute IRI');
          continue;
        }
        if (containerKind === 'objectTypes'
            && Object.hasOwn(element, 'abstract')
            && typeof element.abstract !== 'boolean') {
          issue(errors, 'INVALID_ABSTRACT_FLAG', `${path}.abstract`, 'expected boolean');
        }
        if (authoredByIri.has(element.iri)) {
          issue(errors, 'DUPLICATE_AUTHORED_IRI', `${path}.iri`, 'duplicate authored IRI in module');
          continue;
        }
        authoredByIri.set(element.iri, { containerKind, element, localName, metaType });
      }
    }

    for (const exportedIri of explicitExports) {
      if (!authoredByIri.has(exportedIri)) {
        issue(
          errors,
          'ORPHAN_EXPLICIT_EXPORT',
          `modules[${moduleIndex}].module.exports`,
          `${exportedIri} does not select one authored element`,
        );
      }
    }

    const selected = [...authoredByIri.values()]
      .filter(({ element }) => exportsAll || explicitExports.has(element.iri));
    for (const { containerKind, element, localName } of selected) {
      const path = `modules[${moduleIndex}].domain.${containerKind}.${localName}`;
      addSymbol(
        {
          publicIri: element.iri,
          origin: 'authored',
          ownerModule,
        },
        {
          kind: 'authoredElement',
          ownerModule,
          containerKind,
          metaType: classifier(containerKind, element),
          elementIri: element.iri,
        },
        path,
      );

      if (containerKind === 'associationTypes') {
        if (!Array.isArray(element.participantRoles)) {
          issue(errors, 'INVALID_PARTICIPANT_ROLES', `${path}.participantRoles`, 'expected an array');
        } else {
          for (let roleIndex = 0; roleIndex < element.participantRoles.length; roleIndex += 1) {
            const role = element.participantRoles[roleIndex];
            const rolePath = `${path}.participantRoles[${roleIndex}]`;
            if (!isPlainObject(role) || typeof role.id !== 'string' || !ROLE_ID_RE.test(role.id)) {
              issue(errors, 'INVALID_ROLE_ID', `${rolePath}.id`, 'expected canonical lowerCamelCase ASCII role ID');
              continue;
            }
            addSymbol(
              {
                publicIri: `${element.iri}/role/${role.id}`,
                origin: 'generated',
                ownerModule,
                generatedKind: 'rolePredicate',
              },
              {
                kind: 'participantRole',
                containingType: element.iri,
                roleId: role.id,
              },
              rolePath,
            );
          }
        }
      }

      if (containerKind === 'codeLists') {
        if (!Array.isArray(element.values)) {
          issue(errors, 'INVALID_CODE_VALUES', `${path}.values`, 'expected an array');
        } else {
          for (let valueIndex = 0; valueIndex < element.values.length; valueIndex += 1) {
            const value = element.values[valueIndex];
            const valuePath = `${path}.values[${valueIndex}]`;
            if (!isPlainObject(value)
                || !isAbsoluteCanonicalIri(value.iri)) {
              issue(errors, 'INVALID_CODE_VALUE_IRI', `${valuePath}.iri`, 'expected a canonical absolute IRI');
              continue;
            }
            addSymbol(
              {
                publicIri: value.iri,
                origin: 'generated',
                ownerModule,
                generatedKind: 'codeMember',
              },
              {
                kind: 'codeValue',
                codeListIri: element.iri,
                codeValueIri: value.iri,
              },
              valuePath,
            );
          }
        }
      }

      if ((containerKind === 'objectTypes' || containerKind === 'associationTypes')
          && element.abstract !== true) {
        addSymbol(
          {
            publicIri: `${element.iri}/LogicalIdentity`,
            origin: 'generated',
            ownerModule,
            generatedKind: 'logicalIdentityClass',
          },
          {
            kind: 'logicalIdentityClass',
            typeIri: element.iri,
          },
          `${path}#logicalIdentityClass`,
        );
      }
    }
  }

  if (errors.length > 0) throw new PublicSymbolCompilationError(errors);
  symbols.sort((left, right) => utf8Compare(left.publicIri, right.publicIri));
  const manifest = {
    schemaVersion: '1.0',
    profileRef,
    symbols,
  };
  return {
    manifest,
    manifestDigest: taggedJcsDigest(PUBLIC_SYMBOL_MANIFEST_TAG, manifest),
  };
}

module.exports = {
  CONTAINER_META_TYPES,
  MONEY_VALUE,
  PROFILE_REF,
  PUBLIC_SYMBOL_MANIFEST_TAG,
  PublicSymbolCompilationError,
  QUANTITY_VALUE,
  SOURCE_ELEMENT_KEY_TAG,
  artifactDigest,
  classifier,
  compilePublicSymbolManifest,
  sourceKey,
  taggedJcsDigest,
  utf8Compare,
};
