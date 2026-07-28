# ADR-001: Ontology Meta-Model Architecture

**Status**: Accepted  
**Date**: 2026-07-28  
**Decision Makers**: Project Team  
**Supersedes**: Initial prototype in core-meta-model.yaml v0.1

---

## Context

Initial meta-model prototype (v0.1) mixed semantic ontology, data validation, and platform capabilities in a single layer. This prevents clean extension to quantitative research and trading domains, where temporal semantics, provenance, multi-party relationships, and action execution are first-class concerns.

## Decision

### 1. Four-Layer Architecture

```
Layer 1: Semantic Core
  - OntologyModule, ObjectType, ValueType, AttributeType
  - RelationType (binary semantic relations)
  - AssociationType (reifiable n-ary relations with context)
  - ConstraintDefinition, Alignment

Layer 2: Cross-Domain Fact Patterns
  - Identity (IRI + namespace + localName)
  - Classification (code lists, taxonomies)
  - Temporal (validTime, knowledgeTime, observedAt)
  - Provenance (source, evidence, confidence, revision)
  - Evidence, Lifecycle

Layer 3: Platform Behavior
  - QueryType (read-only queries)
  - FunctionType (side-effect-free computation)
  - ActionType (trading actions with authorization, pre/post conditions, compensation)
  - PolicyType (authorization, approval)

Layer 4: Data Binding
  - DataSource, Dataset, Field
  - Transformation, SemanticMapping
```

### 2. AssociationType for N-ary Relations

**Rationale**: Many financial facts cannot be modeled as binary edges:
- Price observations need instrument, market, timestamp, source, confidence
- Holdings need account, portfolio, instrument, quantity, cost basis, validity period
- Order execution needs strategy, approval, account, broker, order, fills, audit trail

**Design**:
- AssociationType projects to `owl:Class` in OWL (standard reification pattern)
- Has `participantRoles` with typed ranges and cardinality
- Binds cross-domain patterns (Temporal, Provenance) rather than repeating fields
- Only elevate to AssociationType when the relation itself needs identity, context, or lifecycle

**Examples**:
- PriceObservation: AssociationType
- Holding: AssociationType or Position ObjectType (depends on batch/lifecycle needs)
- Order: ObjectType (created by SubmitOrder ActionType)
- Execution: AssociationType / Event
- ResearchAssertion: Assertion ObjectType with Association-style participants

**Reference**: [W3C N-ary Relations](https://www.w3.org/TR/swbp-n-aryRelations/)

### 3. Identity: IRI + Namespace + LocalName

**Problem**: Bare `id: "Equity"` has no namespace, cannot guarantee global uniqueness.

**Decision**:
```yaml
ObjectType:
  iri: https://moonweave.ai/ontology/finance/Equity  # globally unique
  namespace: fin
  localName: Equity
```

- IRI is the stable identity
- localName only needs to be unique within namespace
- Follows FIBO and W3C best practices

### 4. Separation of OWL Projection and Alignment

**Problem**: `fiboMapping: owl:Class` mixes OWL type projection with FIBO alignment, and creates contradiction (owl:Class is not a FIBO URI).

**Decision**:
```yaml
ObjectType:
  owlProjection:
    kind: class  # or individual, property
  alignments:
    - vocabulary: FIBO
      version: "2026Q1"
      targetIri: https://spec.edmcouncil.org/fibo/ontology/SEC/Equity/EquityInstruments/Equity
      relation: exactMatch  # or closeMatch, subClassOf, etc.
      rationale: "Direct semantic equivalence"
      verification: reviewed
      verifiedBy: ontology-team
      verifiedAt: 2026-07-28
```

- `owlProjection` defines how to generate OWL/RDF
- `alignments` is optional, auditable, supports multiple vocabularies
- Use SKOS match relations appropriately:
  - `skos:closeMatch` — semantically related, discoverable
  - `skos:exactMatch` — high-confidence equivalence (but not OWL logical equivalence)
  - `rdfs:subClassOf` / `rdfs:subPropertyOf` — local concept is narrower
  - `owl:equivalentClass` / `owl:equivalentProperty` — proven formal equivalence

**Reference**: [SKOS Reference](https://www.w3.org/TR/skos-reference/)

### 5. Value Type System

**Problem**: Mixing `string`, `number`, `isin`, `amount`, `currency` in one enum loses semantic precision. Financial amounts, percentages, basis points, and quantities must be distinct types.

**Decision**:
```yaml
ValueType:        # Base types
  - string, decimal, integer, boolean, date, instant, duration, uri

IdentifierType:   # Standard identifiers with validators
  - ISIN, CUSIP, LEI, SEDOL
  - Contains: standard, validator, issuingAuthority

QuantityType:     # Value + unit + precision
  - value: decimal
  - unit: string
  - precision, rounding

MoneyType:        # Amount (NOT generic number)
  - amount: decimal
  - currency: CurrencyCode
  - scale: integer

CodeListType:     # Controlled vocabularies
  - vocabulary, version, maintainer
```

**No generic `number` for financial amounts.**

### 6. Cardinality: RelationUse with Outbound/Inbound

**Problem**: `sourceCardinality` / `targetCardinality` are ambiguous.

**Decision**:
```yaml
RelationUse:
  relation: fin:isIssuedBy
  subjectType: fin:Equity
  objectType: fin:Organization
  outboundCardinality: {min: 1, max: 1}   # one Equity → how many Organizations
  inboundCardinality: {min: 0, max: null} # one Organization ← how many Equities
```

- Use `max: null` (not `-1`) for unbounded
- `min: 0` is default and can be omitted
- Cardinality is contextual (RelationUse), not global (RelationType), because subclasses may have different constraints

**OWL vs SHACL**:
- OWL cardinality restrictions are open-world axioms (for reasoning)
- SHACL validates closed-world completeness (data must explicitly satisfy constraints)

**Reference**: [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/), [SHACL](https://www.w3.org/TR/shacl/)

### 7. ConstraintDefinition: Separate Definition from Binding

**Problem**: Mixing rule definition, target, severity, and phase prevents reuse and audit.

**Decision**:
```yaml
ConstraintDefinition:
  iri: fin:constraint:IsinLexicalFormat
  version: 1.0.0
  status: approved
  scope: data  # metamodel | data | action
  implementation:
    engine: shacl-core
    artifactRef: constraints/isin.ttl
    artifactDigest: sha256:...
    entrypoint: fin:IsinShape
  parametersSchema: {}
  testSuite:
    - fixtureRef: tests/isin-valid.ttl
      expectedConforms: true
  governance:
    ownerRef: fin:OntologyTeam
    approvedBy: fin:DataGovernanceRole
    approvedAt: 2026-07-28
    rationale: "ISO 6166 lexical rule"

ConstraintBinding:
  definition: fin:constraint:IsinLexicalFormat
  targetSelector:
    class: fin:Instrument
    path: fin:hasISIN
  severity: violation
  enforcementMode: blocking  # blocking | reporting | monitoring
  trigger: ingest            # compile | ingest | preCommit | runtime
```

**Key points**:
- `ConstraintDefinition` is reusable, versioned, testable
- `ConstraintBinding` applies it to specific targets with enforcement policy
- Python validators must be version-locked, digested, sandboxed (not ontology semantics)
- Distinguish lexical format checks from checksum validation

### 8. Temporal Semantics: Four Timestamps

**Decision**:
```yaml
Temporal pattern:
  validTime: [validFrom, validTo]  # when the fact holds in reality/market
  knowledgeTime: [recordedAt]      # when the platform recorded this version
  observedAt: Instant              # when the source observed/measured
  publishedAt: Instant             # when the source published (Provenance)
  receivedAt: Instant              # when the platform received (Provenance)
```

- `validTime` — business time (bi-temporal databases)
- `knowledgeTime` / `systemTime` — system time (for Point-in-Time queries)
- `observedAt` — source observation timestamp
- `publishedAt` / `receivedAt` — provenance timestamps

**Aligned with Qlib Point-in-Time correctness requirements.**

### 9. Cross-Domain Patterns as Bindings, Not Mixins

**Problem**: Treating Temporal, Provenance as `aspects` creates confusion between "what it is" (semantics) and "what it must have" (validation).

**Decision**:
- Temporal, Provenance, Evidence, Identity, Lifecycle are **Layer 2 patterns**
- They bind to ObjectType or AssociationType via `patternBindings`:
  ```yaml
  AssociationType:
    id: PriceObservation
    patternBindings:
      - pattern: fin:TemporalFact
      - pattern: fin:ProvenancedFact
  ```
- Generate SHACL shapes for validation, not OWL class inheritance (unless semantically justified)

### 10. Platform Behavior Layer Separation

**Decision**:
- Remove `InterfaceType` from semantic core
- Introduce Layer 3:
  - `QueryType` — read-only queries
  - `FunctionType` — pure functions
  - `ActionType` — trading actions with:
    - Authorization / approval
    - Pre-conditions / post-conditions
    - Idempotency
    - Audit events
    - Rollback / compensation semantics

**Order vs SubmitOrder**:
- `Order` is a domain ObjectType (business fact)
- `SubmitOrder` is an ActionType (platform behavior)

### 11. No Redundant Links Maintenance

**Problem**: `ObjectType.links` duplicates information already in `LinkType.sourceType` / `targetType`.

**Decision**:
- Remove `links` field from ObjectType
- Compiler generates reverse index from LinkType definitions
- Single source of truth

---

## Consequences

### Positive
- Clean separation of concerns (semantics / validation / behavior / data)
- AssociationType enables financial facts with context
- Identity system supports federated ontologies
- Alignment system is auditable and version-locked
- Constraint system is testable and reusable
- Temporal semantics support Point-in-Time queries (Qlib requirement)

### Negative
- More complex than flat single-file prototype
- Requires compiler/validator tooling
- Learning curve for contributors

### Neutral
- Must physically split into 4 meta-model files
- Requires ADRs for major design decisions

---

## Validation

Five test cases for acceptance:
1. **Securities Identification**: ISIN, CUSIP, LEI with validators
2. **Market Quote**: PriceObservation with instrument, market, time, source
3. **Holding**: Position with account, instrument, quantity, cost basis, validity
4. **Order Execution**: Order ObjectType + SubmitOrder ActionType + Execution event
5. **Research Assertion**: Statement with hypothesis, evidence, data version, model run, confidence

---

## References

- [W3C N-ary Relations](https://www.w3.org/TR/swbp-n-aryRelations/)
- [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/)
- [SHACL Recommendation](https://www.w3.org/TR/shacl/)
- [SKOS Reference](https://www.w3.org/TR/skos-reference/)
- [FIBO Official Overview](https://spec.edmcouncil.org/fibo/)
- [FIBO isIssuedBy](https://spec.edmcouncil.org/fibo/ontology/FND/Relations/Relations/isIssuedBy?version=master%2F2026Q1)
- [ISO 704:2022 Terminology Principles](https://www.iso.org/standard/38109.html)
