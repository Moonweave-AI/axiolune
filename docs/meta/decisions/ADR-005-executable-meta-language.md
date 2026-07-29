# ADR-005: Executable Meta-Language

**Status**: Proposed  
**Date**: 2026-07-28  
**Supersedes**: Parts of ADR-003  
**Requires**: ADR-004 (meta-model foundation)

## Context

ADR-004 established the basic threshold: naming rules, module system, and symbol resolution. However, the meta-model itself remains "soft schema" — type references are free strings, unknown fields are silently ignored, and there's no mechanical validation of cross-references.

To make the meta-model truly executable and prevent drift between documentation and implementation, we need:

1. **JSON Schema for Meta-Model**: The meta-model must validate itself
2. **TypeRef Semantic Validation**: Cross-reference checking beyond string matching
3. **Strict Field Validation**: Unknown fields rejected, nullable semantics explicit
4. **IRI and Version Rules**: Syntax and format enforcement
5. **Dependency Closure**: Transitive import validation and cycle detection

## Decision

### 1. JSON Schema for Meta-Model

We will provide `ontology/meta/schema/meta-model.schema.json` that:
- Validates all `*Definition` types from core-meta-model.yaml
- Enforces module metadata structure (moduleIri, baseIri, preferredPrefix, imports)
- Validates TypeRef syntax patterns
- Rejects unknown fields by default (`additionalProperties: false`)

### 2. TypeRef Validation Rules

TypeRef strings must follow these patterns:

**Primitive Types** (no validation needed):
```
string | integer | decimal | boolean | datetime | duration | uri | iri
```

**Structured Types**:
```
list[T]           // T must be valid TypeRef
map[K,V]          // K must be primitive, V must be valid TypeRef
enum[val1,val2]   // values must be valid identifiers
union[T1,T2,...]  // each Ti must be valid TypeRef
T?                // T must be valid TypeRef (optional marker)
```

**Constrained Types**:
```
string[pattern=/regex/]
integer[min=0,max=100]
decimal[precision=2]
```

**Named Types** (require cross-reference validation):
```
{full-iri}                        // Must resolve to exported symbol
prefix:localName                  // prefix must be in imports, localName must exist
localName                         // Must resolve in current module's baseIri
```

### 3. Semantic Validation Rules

The validator must check:

#### 3.1 Module-Level Rules
- `moduleIri` must be valid IRI (RFC 3987)
- `baseIri` must end with `/` or `#`
- `preferredPrefix` must match `[a-z][a-z0-9-]*`
- `version` must be semantic version `\d+\.\d+\.\d+`
- All `imports[].moduleIri` must be resolvable
- `imports[].artifactDigest` must match `sha256:[0-9a-f]{64}`
- No cyclic imports (transitive closure check)

#### 3.2 Symbol Resolution Rules
- All TypeRef named types must resolve to:
  - Local symbol in current module's exports, OR
  - Imported symbol from dependencies
- Forward references within same module allowed
- Cross-module forward references forbidden

#### 3.3 Pattern Composition Rules
- `Pattern.dependencies[]` must resolve to valid pattern IRIs
- `Pattern.conflicts[]` must resolve to valid pattern IRIs
- Dependency graph must be acyclic
- Conflict relationships must be symmetric (if A conflicts with B, B must conflict with A)

#### 3.4 OWL Projection Rules
- `AttributeTypeDefinition.valueType` determines default OWL projection:
  - Primitive types → `owl:DatatypeProperty`
  - IdentifierType/CodeListType → `owl:DatatypeProperty`
  - StructuredValueType → `owl:ObjectProperty`
- `owlProjectionOverride` can override defaults
- Range IRI must resolve for ObjectProperty projections

### 4. Nullable and Optional Semantics

**Explicit nullable marker**:
- `T?` means the field can be absent or null
- Without `?`, fields in `requiredFields` are mandatory and non-null
- Fields in `optionalFields` can be absent but cannot be null unless marked `T?`

**Examples**:
```yaml
AttributeTypeDefinition:
  requiredFields:
    iri: {type: iri}                    # mandatory, non-null
    valueType: {type: string}           # mandatory, non-null TypeRef
  optionalFields:
    defaultValue: {type: string?}       # optional, nullable
    documentation: {type: string}       # optional, but if present must be non-null
```

### 5. Unknown Fields Policy

**Strict mode (default)**:
- Unknown fields in `*Definition` types → validation error
- Rationale: prevents typos and schema drift

**Extension fields**:
- Fields prefixed with `x-` are allowed for tooling extensions
- Example: `x-codegen-hint`, `x-ui-display-name`

### 6. Implementation Plan

#### Phase 1: Schema Definition
- [ ] Create `ontology/meta/schema/meta-model.schema.json`
- [ ] Define JSON Schema for all 12 `*Definition` types
- [ ] Add `$ref` and `definitions` for reusable patterns

#### Phase 2: TypeRef Parser
- [ ] Implement `scripts/validate-typeref.js` (or Python)
- [ ] Parse structured types (list, map, enum, union, optional)
- [ ] Parse constrained types (pattern, min, max, precision)
- [ ] Extract named type references for resolution

#### Phase 3: Cross-Reference Validator
- [ ] Implement `scripts/validate-cross-refs.js`
- [ ] Load all modules and build symbol table
- [ ] Resolve imports transitively
- [ ] Check all TypeRef named types resolve
- [ ] Detect cyclic imports

#### Phase 4: Pattern Validator
- [ ] Implement `scripts/validate-patterns.js`
- [ ] Build pattern dependency graph
- [ ] Detect cycles in dependencies
- [ ] Validate conflict symmetry
- [ ] Compute transitive attribute injection

#### Phase 5: Integration
- [ ] Add validation to CI pipeline
- [ ] Create pre-commit hook for validation
- [ ] Document validation error messages

## Acceptance Criteria

- [ ] JSON Schema validates all four current meta-model YAML files without errors
- [ ] TypeRef parser correctly handles all syntax forms (primitive, structured, constrained, named)
- [ ] Cross-reference validator detects:
  - [ ] Undefined local symbols
  - [ ] Undefined imported symbols
  - [ ] Cyclic import chains
  - [ ] Invalid module IRIs
- [ ] Pattern validator detects:
  - [ ] Cyclic pattern dependencies
  - [ ] Asymmetric conflict declarations
  - [ ] Attribute injection conflicts
- [ ] Unknown fields in meta-model definitions are rejected
- [ ] Nullable semantics (`T?`) are enforced
- [ ] All validation runs in CI and blocks merges on failure

## Consequences

### Positive
- **Mechanical correctness**: Syntax and reference errors caught before runtime
- **Living documentation**: Schema is source of truth, not comments
- **Refactoring safety**: Renames and moves are validated
- **Deterministic builds**: artifactDigest ensures reproducibility

### Negative
- **Additional tooling**: Requires maintaining validators
- **Stricter discipline**: Typos and shortcuts now break builds
- **Schema evolution cost**: Changes to meta-model require schema updates

### Risks
- **Validator bugs**: False positives could block valid models
- **Performance**: Large ontologies might have slow validation
- **Complexity**: Cross-module resolution adds debugging burden

## Migration Path

1. Run schema validator on current v0.3.0 meta-models (expect failures)
2. Fix validation errors incrementally
3. Add CI integration (warning mode first)
4. Switch to blocking mode after one release cycle
5. Document common validation errors and fixes

## References

- ADR-004: Meta-Model Foundation (naming, module system, symbol resolution)
- JSON Schema 2020-12 specification
- RFC 3987: Internationalized Resource Identifiers (IRIs)
- Semantic Versioning 2.0.0
