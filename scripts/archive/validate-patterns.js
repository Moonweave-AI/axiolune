#!/usr/bin/env node

/**
 * Pattern Composition Validator
 *
 * Validates pattern dependencies, conflicts, and field injection for Axiolune ontologies.
 *
 * Usage:
 *   node validate-patterns.js <yaml-file>
 *   node validate-patterns.js --all
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class PatternCompositionValidator {
  constructor() {
    this.patterns = new Map();
    this.objects = new Map();
  }

  loadModule(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = yaml.load(content);

    for (const def of data.definitions || []) {
      if (def.kind === 'PatternDefinition') {
        this.patterns.set(def.iri, def);
      } else if (def.kind === 'ObjectTypeDefinition') {
        this.objects.set(def.iri, def);
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

  /**
   * Resolve transitive closure of pattern dependencies
   * Returns patterns in depth-first, post-order (base patterns first)
   */
  resolveDependencies(patternIri, visited = new Set(), stack = new Set()) {
    if (stack.has(patternIri)) {
      throw new Error(`Cyclic dependency detected: ${Array.from(stack).join(' → ')} → ${patternIri}`);
    }

    if (visited.has(patternIri)) {
      return [];
    }

    const pattern = this.patterns.get(patternIri);
    if (!pattern) {
      throw new Error(`Pattern not found: ${patternIri}`);
    }

    visited.add(patternIri);
    stack.add(patternIri);

    const resolved = [];
    for (const depIri of pattern.dependencies || []) {
      resolved.push(...this.resolveDependencies(depIri, visited, new Set(stack)));
    }

    stack.delete(patternIri);
    resolved.push(pattern);

    return resolved;
  }

  /**
   * Check if two patterns conflict (directly or transitively)
   */
  hasConflict(pattern1Iri, pattern2Iri, visited = new Set()) {
    if (pattern1Iri === pattern2Iri) return false;
    if (visited.has(pattern1Iri)) return false;

    const pattern1 = this.patterns.get(pattern1Iri);
    if (!pattern1) return false;

    visited.add(pattern1Iri);

    // Direct conflict
    if ((pattern1.conflicts || []).includes(pattern2Iri)) {
      return true;
    }

    // Transitive conflict through dependencies
    for (const depIri of pattern1.dependencies || []) {
      if (this.hasConflict(depIri, pattern2Iri, new Set(visited))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validate conflict symmetry
   */
  validateConflictSymmetry() {
    const errors = [];

    for (const [iri, pattern] of this.patterns) {
      for (const conflictIri of pattern.conflicts || []) {
        const conflictPattern = this.patterns.get(conflictIri);
        if (!conflictPattern) {
          errors.push({
            pattern: iri,
            error: `Conflict target not found: ${conflictIri}`
          });
          continue;
        }

        if (!(conflictPattern.conflicts || []).includes(iri)) {
          errors.push({
            pattern: iri,
            error: `Asymmetric conflict: ${iri} conflicts with ${conflictIri}, but not vice versa`
          });
        }
      }
    }

    return errors;
  }

  /**
   * Compute effective attributes for an object with applied patterns
   */
  computeEffectiveAttributes(objectIri) {
    const obj = this.objects.get(objectIri);
    if (!obj) {
      throw new Error(`Object not found: ${objectIri}`);
    }

    const appliedPatterns = obj.appliedPatterns || [];
    const injectedAttributes = new Map(); // attrIri -> {pattern, isRequired}
    const errors = [];

    // Resolve all patterns (with dependencies) for this object
    const allPatterns = [];
    const visited = new Set();

    for (const patternIri of appliedPatterns) {
      try {
        const resolved = this.resolveDependencies(patternIri, visited);
        allPatterns.push(...resolved);
      } catch (err) {
        errors.push({
          object: objectIri,
          error: err.message
        });
        return { injectedAttributes: [], errors };
      }
    }

    // Check for conflicts between applied patterns
    for (let i = 0; i < appliedPatterns.length; i++) {
      for (let j = i + 1; j < appliedPatterns.length; j++) {
        if (this.hasConflict(appliedPatterns[i], appliedPatterns[j])) {
          errors.push({
            object: objectIri,
            error: `Pattern conflict: ${appliedPatterns[i]} and ${appliedPatterns[j]} cannot be applied together`
          });
        }
      }
    }

    // Inject attributes (first declaration wins)
    for (const pattern of allPatterns) {
      for (const attr of pattern.injectedAttributes || []) {
        const attrIri = attr.attribute;
        if (!injectedAttributes.has(attrIri)) {
          injectedAttributes.set(attrIri, {
            pattern: pattern.iri,
            isRequired: attr.isRequired || false
          });
        }
        // If already injected by earlier pattern, skip (no re-injection)
      }
    }

    return {
      injectedAttributes: Array.from(injectedAttributes.entries()).map(([iri, info]) => ({
        attribute: iri,
        pattern: info.pattern,
        isRequired: info.isRequired
      })),
      errors
    };
  }

  /**
   * Validate all object type definitions
   */
  validateAllObjects() {
    const results = [];

    for (const [objectIri, obj] of this.objects) {
      if ((obj.appliedPatterns || []).length > 0) {
        const result = this.computeEffectiveAttributes(objectIri);
        results.push({
          object: objectIri,
          patterns: obj.appliedPatterns,
          injectedAttributes: result.injectedAttributes,
          errors: result.errors
        });
      }
    }

    return results;
  }

  /**
   * Run all validations
   */
  validate() {
    console.log(`\n=== Pattern Composition Validation ===\n`);
    console.log(`Loaded ${this.patterns.size} patterns and ${this.objects.size} object types\n`);

    // Check conflict symmetry
    console.log('Checking conflict symmetry...');
    const symmetryErrors = this.validateConflictSymmetry();
    if (symmetryErrors.length > 0) {
      console.error('❌ Conflict symmetry errors:');
      for (const err of symmetryErrors) {
        console.error(`  ${err.pattern}: ${err.error}`);
      }
    } else {
      console.log('✅ All conflicts are symmetric\n');
    }

    // Validate object compositions
    console.log('Validating object type pattern compositions...');
    const objectResults = this.validateAllObjects();

    let totalErrors = symmetryErrors.length;
    for (const result of objectResults) {
      if (result.errors.length > 0) {
        console.error(`\n❌ ${result.object}:`);
        for (const err of result.errors) {
          console.error(`  ${err.error}`);
        }
        totalErrors += result.errors.length;
      } else {
        console.log(`\n✅ ${result.object}:`);
        console.log(`  Applied patterns: ${result.patterns.join(', ')}`);
        console.log(`  Effective attributes (${result.injectedAttributes.length}):`);
        for (const attr of result.injectedAttributes) {
          const required = attr.isRequired ? ' [required]' : '';
          console.log(`    - ${attr.attribute} (from ${attr.pattern})${required}`);
        }
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total errors: ${totalErrors}`);
    return totalErrors === 0;
  }
}

// Test cases
function runTests() {
  console.log('\n=== Running Pattern Composition Tests ===\n');

  const validator = new PatternCompositionValidator();

  // Test 1: Dependency resolution
  console.log('Test 1: Dependency Resolution');
  try {
    // Create test patterns
    validator.patterns.set('test:Base', {
      iri: 'test:Base',
      dependencies: [],
      injectedAttributes: [{attribute: 'test:baseAttr'}]
    });
    validator.patterns.set('test:Mid', {
      iri: 'test:Mid',
      dependencies: ['test:Base'],
      injectedAttributes: [{attribute: 'test:midAttr'}]
    });
    validator.patterns.set('test:Top', {
      iri: 'test:Top',
      dependencies: ['test:Mid'],
      injectedAttributes: [{attribute: 'test:topAttr'}]
    });

    const resolved = validator.resolveDependencies('test:Top');
    const order = resolved.map(p => p.iri.split(':')[1]);
    const expected = ['Base', 'Mid', 'Top'];

    if (JSON.stringify(order) === JSON.stringify(expected)) {
      console.log(`✅ Dependency order correct: ${order.join(' → ')}\n`);
    } else {
      console.error(`❌ Expected ${expected.join(' → ')}, got ${order.join(' → ')}\n`);
    }
  } catch (err) {
    console.error(`❌ Test failed: ${err.message}\n`);
  }

  // Test 2: Cycle detection
  console.log('Test 2: Cycle Detection');
  try {
    validator.patterns.set('test:A', {
      iri: 'test:A',
      dependencies: ['test:B'],
      injectedAttributes: []
    });
    validator.patterns.set('test:B', {
      iri: 'test:B',
      dependencies: ['test:C'],
      injectedAttributes: []
    });
    validator.patterns.set('test:C', {
      iri: 'test:C',
      dependencies: ['test:A'],
      injectedAttributes: []
    });

    validator.resolveDependencies('test:A');
    console.error('❌ Cycle not detected\n');
  } catch (err) {
    if (err.message.includes('Cyclic dependency')) {
      console.log(`✅ Cycle correctly detected: ${err.message}\n`);
    } else {
      console.error(`❌ Wrong error: ${err.message}\n`);
    }
  }

  // Test 3: Attribute deduplication
  console.log('Test 3: Attribute Deduplication (first wins)');
  validator.patterns.clear();
  validator.objects.clear();

  validator.patterns.set('test:PublicationTiming', {
    iri: 'test:PublicationTiming',
    dependencies: [],
    injectedAttributes: [
      {attribute: 'test:publishedAt'},
      {attribute: 'test:receivedAt'}
    ]
  });
  validator.patterns.set('test:TemporalFact', {
    iri: 'test:TemporalFact',
    dependencies: ['test:PublicationTiming'],
    injectedAttributes: [
      {attribute: 'test:observedAt'}
    ]
  });
  validator.patterns.set('test:ProvenancedFact', {
    iri: 'test:ProvenancedFact',
    dependencies: ['test:PublicationTiming'],
    injectedAttributes: [
      {attribute: 'test:source'}
    ]
  });

  validator.objects.set('test:PriceObservation', {
    iri: 'test:PriceObservation',
    appliedPatterns: ['test:TemporalFact', 'test:ProvenancedFact']
  });

  const result = validator.computeEffectiveAttributes('test:PriceObservation');
  const attrIris = result.injectedAttributes.map(a => a.attribute);
  const expected = ['test:publishedAt', 'test:receivedAt', 'test:observedAt', 'test:source'];

  if (JSON.stringify(attrIris.sort()) === JSON.stringify(expected.sort())) {
    console.log(`✅ No duplicate attributes:`);
    for (const attr of result.injectedAttributes) {
      console.log(`  - ${attr.attribute} (from ${attr.pattern})`);
    }
    console.log();
  } else {
    console.error(`❌ Expected ${expected.length} unique attributes, got ${attrIris.length}\n`);
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage:');
    console.log('  node validate-patterns.js --all          Validate all meta-model files');
    console.log('  node validate-patterns.js --test         Run test cases');
    process.exit(0);
  }

  if (args[0] === '--test') {
    runTests();
    process.exit(0);
  }

  if (args[0] === '--all') {
    const metaDir = path.join(__dirname, '..', 'ontology', 'meta');
    const validator = new PatternCompositionValidator();
    validator.loadAllModules(metaDir);
    const success = validator.validate();
    process.exit(success ? 0 : 1);
  }
}

module.exports = { PatternCompositionValidator };
