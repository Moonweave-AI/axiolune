#!/usr/bin/env node

/**
 * Meta-Model Validator
 *
 * Validates Axiolune ontology YAML files against the meta-model JSON Schema
 * and performs semantic cross-reference validation.
 *
 * Usage:
 *   node validate-meta-model.js <yaml-file>
 *   node validate-meta-model.js --all
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

// TypeRef parser
class TypeRefParser {
  constructor() {
    this.primitiveTypes = new Set([
      'string', 'integer', 'decimal', 'boolean',
      'datetime', 'duration', 'uri', 'iri'
    ]);
  }

  parse(typeRef) {
    if (!typeRef || typeof typeRef !== 'string') {
      throw new Error(`Invalid TypeRef: ${typeRef}`);
    }

    // Check for optional marker
    const isOptional = typeRef.endsWith('?');
    const baseType = isOptional ? typeRef.slice(0, -1) : typeRef;

    // Primitive types
    if (this.primitiveTypes.has(baseType)) {
      return { kind: 'primitive', type: baseType, isOptional };
    }

    // Structured types
    if (baseType.startsWith('list[') && baseType.endsWith(']')) {
      const elementType = baseType.slice(5, -1);
      return {
        kind: 'list',
        elementType: this.parse(elementType),
        isOptional
      };
    }

    if (baseType.startsWith('map[') && baseType.endsWith(']')) {
      const inner = baseType.slice(4, -1);
      const commaIdx = this.findTopLevelComma(inner);
      if (commaIdx === -1) {
        throw new Error(`Invalid map TypeRef: ${typeRef}`);
      }
      const keyType = inner.slice(0, commaIdx).trim();
      const valueType = inner.slice(commaIdx + 1).trim();
      return {
        kind: 'map',
        keyType: this.parse(keyType),
        valueType: this.parse(valueType),
        isOptional
      };
    }

    if (baseType.startsWith('enum[') && baseType.endsWith(']')) {
      const values = baseType.slice(5, -1).split(',').map(v => v.trim());
      return { kind: 'enum', values, isOptional };
    }

    if (baseType.startsWith('union[') && baseType.endsWith(']')) {
      const inner = baseType.slice(6, -1);
      const types = this.splitUnionTypes(inner);
      return {
        kind: 'union',
        types: types.map(t => this.parse(t)),
        isOptional
      };
    }

    // Constrained types
    const constraintMatch = baseType.match(/^(string|integer|decimal)\[(.+)\]$/);
    if (constraintMatch) {
      const [, baseKind, constraints] = constraintMatch;
      return {
        kind: 'constrained',
        baseType: baseKind,
        constraints: this.parseConstraints(constraints),
        isOptional
      };
    }

    // Named types (IRI, prefix:local, or local)
    if (baseType.startsWith('http://') || baseType.startsWith('https://')) {
      return { kind: 'namedIRI', iri: baseType, isOptional };
    }

    if (baseType.includes(':')) {
      const [prefix, localName] = baseType.split(':', 2);
      return { kind: 'namedPrefixed', prefix, localName, isOptional };
    }

    // Local name
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(baseType)) {
      return { kind: 'namedLocal', localName: baseType, isOptional };
    }

    throw new Error(`Unrecognized TypeRef: ${typeRef}`);
  }

  findTopLevelComma(str) {
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '[') depth++;
      else if (str[i] === ']') depth--;
      else if (str[i] === ',' && depth === 0) return i;
    }
    return -1;
  }

  splitUnionTypes(str) {
    const types = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        types.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) types.push(current.trim());
    return types;
  }

  parseConstraints(constraintStr) {
    const constraints = {};
    const parts = constraintStr.split(',').map(p => p.trim());
    for (const part of parts) {
      const [key, value] = part.split('=').map(s => s.trim());
      if (key === 'pattern') {
        constraints.pattern = value.replace(/^\/|\/$/g, '');
      } else if (key === 'min' || key === 'max') {
        constraints[key] = parseInt(value, 10);
      } else if (key === 'precision') {
        constraints.precision = parseInt(value, 10);
      }
    }
    return constraints;
  }
}

// Cross-reference validator
class CrossReferenceValidator {
  constructor() {
    this.modules = new Map();
    this.symbolTable = new Map();
    this.typeRefParser = new TypeRefParser();
  }

  loadModule(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = yaml.load(content);

    if (!data.module) {
      throw new Error(`Missing module metadata in ${filePath}`);
    }

    const moduleIri = data.module.moduleIri;
    this.modules.set(moduleIri, {
      filePath,
      metadata: data.module,
      definitions: data.definitions || []
    });

    // Build symbol table
    const baseIri = data.module.baseIri;
    for (const def of data.definitions || []) {
      if (def.iri) {
        this.symbolTable.set(def.iri, {
          moduleIri,
          definition: def
        });
      }
    }
  }

  loadAllModules(directory) {
    const files = fs.readdirSync(directory);
    for (const file of files) {
      if (file.endsWith('.yaml') && !file.includes('schema')) {
        const filePath = path.join(directory, file);
        try {
          this.loadModule(filePath);
        } catch (err) {
          console.error(`Error loading ${file}: ${err.message}`);
        }
      }
    }
  }

  validateImports() {
    const errors = [];
    for (const [moduleIri, module] of this.modules) {
      const imports = module.metadata.imports || [];
      for (const imp of imports) {
        if (!this.modules.has(imp.moduleIri)) {
          errors.push({
            module: moduleIri,
            error: `Import not found: ${imp.moduleIri}`
          });
        }
      }
    }
    return errors;
  }

  detectCyclicImports() {
    const cycles = [];
    for (const moduleIri of this.modules.keys()) {
      const visited = new Set();
      const path = [];
      if (this.hasCycle(moduleIri, visited, path)) {
        cycles.push(path);
      }
    }
    return cycles;
  }

  hasCycle(moduleIri, visited, path) {
    if (path.includes(moduleIri)) {
      path.push(moduleIri);
      return true;
    }
    if (visited.has(moduleIri)) {
      return false;
    }

    visited.add(moduleIri);
    path.push(moduleIri);

    const module = this.modules.get(moduleIri);
    if (module) {
      const imports = module.metadata.imports || [];
      for (const imp of imports) {
        if (this.hasCycle(imp.moduleIri, visited, [...path])) {
          return true;
        }
      }
    }

    path.pop();
    return false;
  }

  validateTypeRefs() {
    const errors = [];
    for (const [moduleIri, module] of this.modules) {
      for (const def of module.definitions) {
        this.checkTypeRefsInDefinition(def, module, errors);
      }
    }
    return errors;
  }

  checkTypeRefsInDefinition(def, module, errors) {
    const checkTypeRef = (typeRef, context) => {
      if (!typeRef) return;
      try {
        const parsed = this.typeRefParser.parse(typeRef);
        if (parsed.kind === 'namedIRI') {
          if (!this.symbolTable.has(parsed.iri)) {
            errors.push({
              module: module.metadata.moduleIri,
              definition: def.iri || def.pattern,
              context,
              error: `Undefined symbol: ${parsed.iri}`
            });
          }
        } else if (parsed.kind === 'namedPrefixed') {
          // Check if prefix is imported
          const imports = module.metadata.imports || [];
          const importFound = imports.find(imp => {
            const importedModule = this.modules.get(imp.moduleIri);
            return importedModule && importedModule.metadata.preferredPrefix === parsed.prefix;
          });
          if (!importFound) {
            errors.push({
              module: module.metadata.moduleIri,
              definition: def.iri || def.pattern,
              context,
              error: `Undefined prefix: ${parsed.prefix}`
            });
          }
        } else if (parsed.kind === 'namedLocal') {
          // Check local symbol
          const localIri = module.metadata.baseIri + parsed.localName;
          if (!this.symbolTable.has(localIri)) {
            errors.push({
              module: module.metadata.moduleIri,
              definition: def.iri || def.pattern,
              context,
              error: `Undefined local symbol: ${parsed.localName} (resolved to ${localIri})`
            });
          }
        }
      } catch (err) {
        errors.push({
          module: module.metadata.moduleIri,
          definition: def.iri || def.pattern,
          context,
          error: err.message
        });
      }
    };

    // Check different definition types
    if (def.kind === 'AttributeTypeDefinition') {
      checkTypeRef(def.valueType, 'valueType');
    } else if (def.kind === 'RelationTypeDefinition') {
      checkTypeRef(def.domain, 'domain');
      checkTypeRef(def.range, 'range');
    } else if (def.kind === 'ObjectTypeDefinition') {
      (def.superTypes || []).forEach((st, i) => checkTypeRef(st, `superTypes[${i}]`));
    }
  }
}

// Pattern validator
class PatternValidator {
  constructor(crossRefValidator) {
    this.crossRefValidator = crossRefValidator;
  }

  validatePatterns() {
    const errors = [];
    const patterns = this.collectPatterns();

    // Check dependencies
    for (const pattern of patterns) {
      for (const depIri of pattern.dependencies || []) {
        if (!patterns.find(p => p.iri === depIri)) {
          errors.push({
            pattern: pattern.iri,
            error: `Dependency not found: ${depIri}`
          });
        }
      }
    }

    // Check for cycles in dependencies
    for (const pattern of patterns) {
      if (this.hasCyclicDependency(pattern, patterns, new Set())) {
        errors.push({
          pattern: pattern.iri,
          error: 'Cyclic dependency detected'
        });
      }
    }

    // Check conflict symmetry
    for (const pattern of patterns) {
      for (const conflictIri of pattern.conflicts || []) {
        const conflictPattern = patterns.find(p => p.iri === conflictIri);
        if (conflictPattern) {
          if (!(conflictPattern.conflicts || []).includes(pattern.iri)) {
            errors.push({
              pattern: pattern.iri,
              error: `Asymmetric conflict: ${pattern.iri} conflicts with ${conflictIri}, but not vice versa`
            });
          }
        }
      }
    }

    return errors;
  }

  collectPatterns() {
    const patterns = [];
    for (const [, module] of this.crossRefValidator.modules) {
      for (const def of module.definitions) {
        if (def.kind === 'PatternDefinition') {
          patterns.push(def);
        }
      }
    }
    return patterns;
  }

  hasCyclicDependency(pattern, allPatterns, visited) {
    if (visited.has(pattern.iri)) {
      return true;
    }
    visited.add(pattern.iri);

    for (const depIri of pattern.dependencies || []) {
      const depPattern = allPatterns.find(p => p.iri === depIri);
      if (depPattern && this.hasCyclicDependency(depPattern, allPatterns, new Set(visited))) {
        return true;
      }
    }

    return false;
  }
}

// Main validator
function validateMetaModel(filePath) {
  console.log(`\n=== Validating ${path.basename(filePath)} ===\n`);

  // Load JSON Schema
  const schemaPath = path.join(__dirname, '..', 'ontology', 'meta', 'schema', 'meta-model.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  // Setup AJV
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  // Load YAML
  const content = fs.readFileSync(filePath, 'utf8');
  const data = yaml.load(content);

  // JSON Schema validation
  const valid = validate(data);
  if (!valid) {
    console.error('❌ JSON Schema validation failed:\n');
    for (const error of validate.errors) {
      console.error(`  ${error.instancePath}: ${error.message}`);
      if (error.params) {
        console.error(`    ${JSON.stringify(error.params)}`);
      }
    }
    return false;
  }

  console.log('✅ JSON Schema validation passed');
  return true;
}

function validateAllModules(directory) {
  console.log('\n=== Cross-Reference Validation ===\n');

  const validator = new CrossReferenceValidator();
  validator.loadAllModules(directory);

  console.log(`Loaded ${validator.modules.size} modules`);
  console.log(`Symbol table has ${validator.symbolTable.size} symbols\n`);

  // Validate imports
  const importErrors = validator.validateImports();
  if (importErrors.length > 0) {
    console.error('❌ Import errors:');
    for (const err of importErrors) {
      console.error(`  ${err.module}: ${err.error}`);
    }
  } else {
    console.log('✅ All imports resolved');
  }

  // Detect cyclic imports
  const cycles = validator.detectCyclicImports();
  if (cycles.length > 0) {
    console.error('\n❌ Cyclic imports detected:');
    for (const cycle of cycles) {
      console.error(`  ${cycle.join(' → ')}`);
    }
  } else {
    console.log('✅ No cyclic imports');
  }

  // Validate TypeRefs
  const typeRefErrors = validator.validateTypeRefs();
  if (typeRefErrors.length > 0) {
    console.error('\n❌ TypeRef errors:');
    for (const err of typeRefErrors.slice(0, 20)) {
      console.error(`  ${err.module}`);
      console.error(`    ${err.definition} (${err.context}): ${err.error}`);
    }
    if (typeRefErrors.length > 20) {
      console.error(`  ... and ${typeRefErrors.length - 20} more errors`);
    }
  } else {
    console.log('✅ All TypeRefs resolved');
  }

  // Validate patterns
  const patternValidator = new PatternValidator(validator);
  const patternErrors = patternValidator.validatePatterns();
  if (patternErrors.length > 0) {
    console.error('\n❌ Pattern errors:');
    for (const err of patternErrors) {
      console.error(`  ${err.pattern}: ${err.error}`);
    }
  } else {
    console.log('✅ Pattern validation passed');
  }

  const totalErrors = importErrors.length + cycles.length + typeRefErrors.length + patternErrors.length;
  return totalErrors === 0;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage:');
    console.log('  node validate-meta-model.js <yaml-file>');
    console.log('  node validate-meta-model.js --all');
    process.exit(0);
  }

  if (args[0] === '--all') {
    const metaDir = path.join(__dirname, '..', 'ontology', 'meta');
    const files = fs.readdirSync(metaDir).filter(f => f.endsWith('.yaml') && !f.includes('schema'));

    let allValid = true;
    for (const file of files) {
      const filePath = path.join(metaDir, file);
      if (!validateMetaModel(filePath)) {
        allValid = false;
      }
    }

    if (allValid) {
      allValid = validateAllModules(metaDir);
    }

    process.exit(allValid ? 0 : 1);
  } else {
    const filePath = path.resolve(args[0]);
    const valid = validateMetaModel(filePath);
    process.exit(valid ? 0 : 1);
  }
}

module.exports = {
  TypeRefParser,
  CrossReferenceValidator,
  PatternValidator,
  validateMetaModel,
  validateAllModules
};
