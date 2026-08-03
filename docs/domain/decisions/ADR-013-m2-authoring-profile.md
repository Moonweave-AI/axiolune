# ADR-013: M2 Authoring Profile

**Status**: Accepted (G0 baseline)  
**Date**: 2026-07-30  
**Supersedes**: none  
**Governance**: M2-PLAN §4 (G0 gate)

## Context

M3 defines meta-types (`OntologyModuleDefinition`, `ObjectTypeDefinition`, `AssociationTypeDefinition`, etc.) but does not specify how a *domain* YAML file instantiates them. M3's own four YAML files use a root section key (`MetaModel:`, `CrossDomainPatterns:`, `PlatformBehavior:`, `DataBinding:`) that is specific to the meta-model itself. M2 needs its own root convention — an "Authoring Profile" — that the compiler, schema, and validator all accept, before any `fin-*` module can be declared formal.

## Decision

### 0. Source layout (canonical path)

Domain (M2) finance modules live under:

```text
ontology/domain/finance/
  registry/
  foundation/
  ...
scripts/domain/          # validators + generators + test-all-domain
```

The earlier draft path `ontology/m2/` was renamed to `ontology/domain/` for phase clarity (M3=`meta`, M2=`domain`). M2-PLAN §4.4 examples that still say `ontology/m2/` are superseded by this ADR for layout only; semantic contracts in the plan remain authoritative.

### 1. File root: `module` + `domain` envelope


Every M2 YAML file has exactly two top-level keys:

```yaml
module:                    # OntologyModuleDefinition instance (M3 core L1)
  moduleIri: "..."
  baseIri: "..."
  preferredPrefix: "..."
  version: "..."
  label: "..."
  definition: "..."
  imports: [...]
  exports: [...]
  status: draft | review | approved | deprecated

domain:                    # element container — the M2 authoring root
  # ObjectTypeDefinition / AssociationTypeDefinition / RelationTypeDefinition /
  # AttributeTypeDefinition / IdentifierTypeDefinition / CodeListTypeDefinition /
  # EnumTypeDefinition / ValueTypeDefinition instances keyed by localName
```

`module` is the M3 `OntologyModuleDefinition` instance (required fields per M3).  
`domain` is the element container: a map from `localName` to an M3 type instance.

No other top-level keys are allowed. Sidecar evidence (references.bibliography, terminology cards, alignments, CQ) lives in separate files, not injected into the YAML.

### 2. Element container: keyed by localName, type inferred from structure

Each entry under `domain:` is keyed by its `localName`. The type is inferred from which M3-required-fields are present (the same convention M3 uses internally):

```yaml
domain:
  FinancialInstrument:           # has iri+namespace+localName+label+definition+superTypes → ObjectTypeDefinition
    iri: "https://axiolune.ai/ontology/finance/foundation/FinancialInstrument"
    namespace: "fin"
    localName: "FinancialInstrument"
    label: "Financial Instrument"
    definition: "..."
    superTypes: []

  ISIN:                          # has iri+namespace+localName+pattern+validator → IdentifierTypeDefinition
    iri: "..."
    namespace: "fin"
    localName: "ISIN"
    label: "ISIN"
    definition: "..."
    pattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$"

  hasPrimaryIdentifier:          # has iri+namespace+localName+valueType → AttributeTypeDefinition
    iri: "..."
    namespace: "fin"
    localName: "hasPrimaryIdentifier"
    label: "Has Primary Identifier"
    definition: "..."
    valueType: "string"
```

This follows M3's own convention: type-classifiers and instances are keyed by name, not by a `kind:` discriminant field. The `validate-m2-core` validator infers the M3 type from the presence of M3-defined required fields (see §5 below).

### 3. IRI rules

- **Canonical form**: absolute IRI (`https://axiolune.ai/ontology/finance/foundation/FinancialInstrument`)
- **CURIE form**: `prefix:localName` (e.g. `fin:FinancialInstrument`) as a convenience alias, expanded via the prefix registry
- **baseIri** must end with `/`; concept IRIs are `baseIri + localName`
- **moduleIri** is distinct from baseIri (no trailing slash)
- **Uniqueness**: no two elements across all M2 modules may share the same IRI; no two elements in the same module may share the same localName

### 4. Import / export lock

- `imports` use M3 `ModuleImportDefinition` with required `moduleIri`, `version`, `importMode` (no `artifactDigest` byte locks per ADR-015 / RFC-001)
- Only `approved` modules may be imported
- `importMode: Selective` requires `importedSymbols` listing exact symbol IRIs
- `exports`: empty list = export all; non-empty = export only listed IRIs
- Circular imports are forbidden (DAG)
- Forward references to not-yet-approved modules are forbidden

### 5. validate-m2-core rules (minimum)

The G0 validator checks:

| Check | What | Fail example |
|-------|------|-------------|
| Root shape | Exactly `module` + `domain` top-level keys | Unknown top-level key |
| Module metadata | All OntologyModuleDefinition required fields present + valid | Missing version; bad semver |
| Element identity | Every element has iri, namespace, localName, label, definition | Missing iri |
| IRI uniqueness | No duplicate IRIs across the module | Two elements same iri |
| IRI format | Absolute IRI or registered CURIE | Unregistered prefix |
| Import lock | Every import has semver `version` + `importMode`; imported module must be `approved` when policy requires | Missing version; importing draft without exception ADR |
| Dialect unity | Forbidden: `participants`, `attributes` (as uses), `patternIri`, `attributeIri` | E5 alternate dialect |
| Pattern IRI | `patternBindings[].pattern` under `…/meta/patterns/` | `…/foundation/patterns/` |
| Type inference | Element's fields match at least one M3 meta-type | Unknown required field combination |
| Sidecar separation | No `kind:` field; no evidence fields in domain YAML | `kind: ObjectTypeDefinition` |

`--strict` additionally rejects bare `decimal` money/quantity attributes. Digest/byte-lock checks are removed (ADR-015).


### 6. Generator contract

- `generate-owl` and `generate-shacl` must accept M2 files with the `domain` root
- Each `ObjectTypeDefinition` instance → `owl:Class` (with `rdfs:label`, `rdfs:comment`, optional `rdfs:subClassOf`)
- Each `AttributeTypeDefinition` instance → `owl:DatatypeProperty` (or `owl:ObjectProperty` if valueType is Money/Quantity)
- Each `IdentifierTypeDefinition` instance → `owl:DatatypeProperty` with `sh:pattern`
- Determinism: two runs produce byte-identical output
- Drift: `git diff --exit-code` after regeneration must be zero

## Consequences

- M2 files use `module:` + `domain:` envelope, not M3's `MetaModel:` / `CrossDomainPatterns:` keys
- No `kind:` discriminant field — type is inferred from M3 required-field presence (consistent with M3's own convention)
- Sidecar evidence stays in separate files under `docs/ontology/`
- `validate-m2-core` is the G0 gate; domain-specific validators are added per-module later
- The first real M2 fixture (`fin-foundation` with Instrument + ISIN) must pass this profile before any domain work begins
