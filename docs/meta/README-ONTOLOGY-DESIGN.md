# Ontology Design Documentation

This directory contains the comprehensive design plan and architectural decision records for the Axiolune ontology engineering project.

---

## Architectural Decision Records

### [ADR-001: Ontology Meta-Model Architecture](decisions/ADR-001-ontology-meta-model-architecture.md) ⭐ **Foundation**
**Status**: Accepted | **Date**: 2026-07-28

Core architectural decisions defining the four-layer ontology infrastructure:

1. **Layer 1: Semantic Core** - What entities exist
   - ObjectType, ValueType, AttributeType, RelationType, AssociationType
   - Identity via IRI + namespace + localName
   - OWL projection separated from FIBO alignment

2. **Layer 2: Cross-Domain Patterns** - How facts are structured
   - Temporal (validTime, knowledgeTime, observedAt)
   - Provenance (source, confidence, evidence)
   - Lifecycle (state machines)

3. **Layer 3: Platform Behavior** - What operations are available
   - QueryType (read-only), FunctionType (pure), ActionType (state-changing)
   - Authorization, approval, compensation semantics

4. **Layer 4: Data Binding** - How data maps to ontology
   - DataSource, Dataset, SemanticMapping
   - Temporal mapping for Point-in-Time correctness

**Key Decisions**:
- AssociationType for n-ary relations (PriceObservation, Holding, Execution)
- No generic `number` for financial amounts (use MoneyType)
- Cardinality via RelationUse (not global RelationType)
- Constraint separation: definition vs binding
- SKOS/RDFS/OWL alignment relations (not just exactMatch)

---

## Meta-Model Implementation (v0.2.0)

### Four-Layer Meta-Model Files

Located in `ontology/meta/`:

1. **[core-meta-model.yaml](../../ontology/meta/core-meta-model.yaml)** - Layer 1: Semantic Core
   - OntologyModule, ObjectType, AttributeType, RelationType, AssociationType
   - Value type system (ValueType, IdentifierType, MoneyType, QuantityType, CodeListType)
   - AttributeUse, RelationUse, PatternBinding, Alignment structures
   - Governance metadata
   - **Status**: ✓ YAML syntax validated

2. **[cross-domain-patterns.yaml](../../ontology/meta/cross-domain-patterns.yaml)** - Layer 2: Cross-Domain Patterns
   - Identity, Classification, Temporal (3 variants), Provenance (2 variants)
   - Evidence, Lifecycle, Versioning patterns
   - Pattern composition examples (PriceObservation, Order, ResearchAssertion)
   - **Status**: ✓ YAML syntax validated

3. **[behavior-meta-model.yaml](../../ontology/meta/behavior-meta-model.yaml)** - Layer 3: Platform Behavior
   - QueryType (read-only data access)
   - FunctionType (side-effect-free computation)
   - ActionType (trading actions with authorization, pre/post conditions, compensation)
   - PolicyType (authorization, risk limits, compliance)
   - Examples: SubmitOrder, CancelOrder, PublishResearchReport
   - **Status**: ✓ YAML syntax validated

4. **[data-binding-meta-model.yaml](../../ontology/meta/data-binding-meta-model.yaml)** - Layer 4: Data Binding
   - DataSource, Dataset, Field definitions
   - SemanticMapping (6 mapping types)
   - Identity, Temporal, Provenance mapping specifications
   - DataLineage, IngestionPipeline
   - Examples: EquityPriceMapping, HoldingMapping
   - **Status**: ✓ YAML syntax validated

---

## Reference Documents

### [REFERENCE-PROJECTS-ALIGNMENT.md](REFERENCE-PROJECTS-ALIGNMENT.md) ⭐ **Essential Reading**
Critical guide for preventing "making up your own ontology":
- FIBO ISO 704 definition requirements with correct/incorrect examples
- FIBO's 21 minimal compliance hygiene tests for CI/CD
- Qlib Point-in-Time database requirements for backtest correctness
- Lean Security and Order system alignment
- NautilusTrader Event Sourcing and dual timestamp pattern
- Comprehensive checklist for every ObjectType design
- **"不自己捏一套"原则** (don't make up your own ontology)

### [ONTOLOGY-DESIGN-MASTER-PLAN.md](ONTOLOGY-DESIGN-MASTER-PLAN.md)
**Status**: Legacy (v0.1.0) - Superseded by ADR-001 and four-layer meta-model

Original design blueprint - historical reference:
- Meta-model architecture prototype
- Domain model structure (12 domain divisions)
- Interface capabilities
- Action execution framework
- 2-week implementation sprint plan

---

## Key Design Principles

1. **Layer Separation**
   - Layer 1: Semantic ontology (independent of platform)
   - Layer 2: Cross-domain patterns (reusable, composable)
   - Layer 3: Platform capabilities (behavior, not ontology)
   - Layer 4: Data bindings (physical, not conceptual)

2. **FIBO Alignment**
   - All ObjectTypes must have alignment to external standards
   - Use appropriate SKOS/RDFS/OWL relations (not just exactMatch)
   - Version-locked, auditable alignments

3. **Temporal Correctness**
   - Bi-temporal semantics (validTime + knowledgeTime)
   - Point-in-Time queries for backtest correctness (Qlib requirement)
   - Immutable recordedAt timestamp

4. **Financial Type Safety**
   - MoneyType for amounts (not generic number)
   - Separate types for percentages, basis points, quantities
   - IdentifierType with validators (ISIN, CUSIP, LEI)

5. **N-ary Relations**
   - Use AssociationType when relation needs context
   - Examples: PriceObservation, Holding, Execution, ResearchAssertion
   - Standard W3C reification pattern

6. **Constraint Governance**
   - ConstraintDefinition (reusable, versioned, testable)
   - ConstraintBinding (contextual application)
   - Separate OWL axioms from SHACL validation

7. **Action Semantics**
   - Authorization, approval workflows
   - Pre/post conditions, idempotency
   - Compensation/rollback strategies
   - Full audit trails

---

## Next Steps

### Completed (P0 Refactoring)
- ✅ ADR-001 architectural decisions documented
- ✅ Four-layer meta-model implemented in YAML
- ✅ YAML syntax validated
- ✅ Fixed: owlProjection / alignment separation
- ✅ Fixed: IRI + namespace + localName identity
- ✅ Fixed: Value type system (no generic number)
- ✅ Fixed: AssociationType for n-ary relations
- ✅ Fixed: Constraint definition vs binding

### In Progress
- ⏳ Five validation examples (Week 1 Day 1-3)
  1. Securities Identification (ISIN, CUSIP, LEI)
  2. Market Quote (PriceObservation)
  3. Holding (Position with bi-temporal semantics)
  4. Order Execution (Order + SubmitOrder action)
  5. Research Assertion (with evidence chain)

### Upcoming
- Data binding examples with physical tables
- FIBO 21 hygiene tests in CI/CD
- OWL/SHACL export tooling
- Semantic mapping compiler

---

## Directory Structure

```
docs/
├── README-ONTOLOGY-DESIGN.md           # This file
├── decisions/
│   └── ADR-001-ontology-meta-model-architecture.md
├── ONTOLOGY-DESIGN-MASTER-PLAN.md      # Legacy v0.1.0
└── REFERENCE-PROJECTS-ALIGNMENT.md     # Essential reading

ontology/
├── meta/                                # Meta-model definitions (v0.2.0)
│   ├── core-meta-model.yaml            # Layer 1: Semantic Core
│   ├── cross-domain-patterns.yaml      # Layer 2: Fact Patterns
│   ├── behavior-meta-model.yaml        # Layer 3: Platform Behavior
│   └── data-binding-meta-model.yaml    # Layer 4: Data Binding
├── domain/                              # (To be created) Domain ontologies
├── aspects/                             # (To be created) Reusable aspects
└── schemas/                             # (To be created) JSON/SHACL schemas

scripts/
└── validate-yaml.js                     # YAML syntax validator
```

---

## Tools and Validation

### YAML Validation
```bash
# Validate all meta-model files
node scripts/meta/validate-yaml.js ontology/meta/*.yaml
```

### Future Tooling
- OWL 2 DL export from meta-model
- SHACL shape generation from constraints
- Semantic mapping compiler
- Point-in-Time query engine
- FIBO alignment validator
