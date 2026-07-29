# ADR-007: Value Objects and Data Mapping

**Status**: Proposed  
**Date**: 2026-07-28  
**Requires**: ADR-004 (meta-model foundation), ADR-005 (executable meta-language), ADR-006 (pattern and time semantics)

## Context

The evaluation feedback identified critical issues with value objects and data mapping:

1. **Money/Quantity OWL Projection**: AttributeTypeDefinition now has conditional projection logic, but no proof this generates correct M1 facts
2. **Data Binding Truth Source**: Multiple overlapping mechanisms for semantic mapping:
   - `Dataset.semanticMappings` (array of field→attribute mappings)
   - `Field.semanticMapping` (single attribute per field)
   - `FieldMappingDefinition` (standalone mapping objects)
3. **Value Object Semantics**: MoneyType, QuantityType, IdentifierType need clear mapping to OWL individuals and RDF literals
4. **Transformation Expressions**: Still using free strings instead of typed references

## Decision

### 1. Value Object OWL Projection Proof

We will prove the OWL projection creates correct M1 facts by working through concrete examples.

#### 1.1 Primitive Attribute Example (ISIN)

**M3 Meta-Model**:
```yaml
IdentifierTypeDefinition:
  iri: "fin:ISINType"
  definition: "12-character securities identifier"
  format: "ISIN"
  validationPattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$"
  owlProjection:
    kind: rdfsDatatype
    baseType: xsd:string

AttributeTypeDefinition:
  iri: "fin:hasISIN"
  definition: "ISIN identifier of a security"
  valueType: "fin:ISINType"
  owlProjection:
    kind: datatypeProperty
    range: fin:ISINType
```

**M2 Ontology (OWL Output)**:
```turtle
fin:ISINType a rdfs:Datatype ;
  rdfs:subClassOf xsd:string ;
  owl:onDatatype xsd:string ;
  owl:withRestrictions ( [ xsd:pattern "^[A-Z]{2}[A-Z0-9]{9}[0-9]$" ] ) .

fin:hasISIN a owl:DatatypeProperty ;
  rdfs:domain fin:Instrument ;
  rdfs:range fin:ISINType .
```

**M1 Business Fact**:
```turtle
fin:_instrument_123 a fin:EquitySecurity ;
  fin:hasISIN "US0378331005"^^fin:ISINType .
```

**Validation**: ✅ ISIN value is RDF literal with datatype, OWL reasoner can validate pattern constraint.

#### 1.2 Structured Value Attribute Example (Price)

**M3 Meta-Model**:
```yaml
StructuredValueTypeDefinition:
  iri: "fin:MoneyType"
  definition: "monetary amount with currency"
  requiredFields:
    amount: {type: decimal}
    currency: {type: "fin:CurrencyCode"}
  owlProjection:
    kind: valueClass
    classIri: "fin:MonetaryAmount"

AttributeTypeDefinition:
  iri: "fin:quotedPrice"
  definition: "price at which security is quoted"
  valueType: "fin:MoneyType"
  owlProjection:
    kind: objectProperty
    range: fin:MonetaryAmount
```

**M2 Ontology (OWL Output)**:
```turtle
fin:MonetaryAmount a owl:Class ;
  rdfs:comment "Value object for monetary amounts" .

fin:monetaryAmount a owl:DatatypeProperty ;
  rdfs:domain fin:MonetaryAmount ;
  rdfs:range xsd:decimal .

fin:currencyCode a owl:DatatypeProperty ;
  rdfs:domain fin:MonetaryAmount ;
  rdfs:range fin:CurrencyCode .

fin:quotedPrice a owl:ObjectProperty ;
  rdfs:domain fin:PriceObservation ;
  rdfs:range fin:MonetaryAmount .
```

**M1 Business Fact (Option A: Blank Node)**:
```turtle
fin:_priceObs_456 a fin:PriceObservation ;
  fin:instrument fin:_instrument_123 ;
  fin:observedAt "2026-07-28T10:30:00Z"^^xsd:dateTime ;
  fin:quotedPrice [
    a fin:MonetaryAmount ;
    fin:monetaryAmount "150.05"^^xsd:decimal ;
    fin:currencyCode "USD"^^fin:CurrencyCode
  ] .
```

**M1 Business Fact (Option B: Named Node with IRI)**:
```turtle
fin:_money_789 a fin:MonetaryAmount ;
  fin:monetaryAmount "150.05"^^xsd:decimal ;
  fin:currencyCode "USD"^^fin:CurrencyCode .

fin:_priceObs_456 a fin:PriceObservation ;
  fin:instrument fin:_instrument_123 ;
  fin:observedAt "2026-07-28T10:30:00Z"^^xsd:dateTime ;
  fin:quotedPrice fin:_money_789 .
```

**Choice**: Use **Option A (blank nodes)** for ephemeral value objects, **Option B (named nodes)** when value object needs independent identity (e.g., for provenance tracking).

**Validation**: ✅ Price is object property pointing to structured value, all components have defined semantics.

#### 1.3 Projection Rule Summary

| Value Type | OWL Property | Range | M1 Fact Representation |
|------------|--------------|-------|------------------------|
| Primitive (string, integer, decimal, boolean, datetime, duration) | owl:DatatypeProperty | xsd:* or rdfs:Literal | RDF literal with datatype |
| IdentifierType | owl:DatatypeProperty | Custom datatype (subclass of xsd:string) | RDF literal with custom type |
| CodeListType | owl:DatatypeProperty | Enumerated datatype or skos:Concept | RDF literal or IRI reference |
| StructuredValueType | owl:ObjectProperty | Generated value class (e.g., fin:MonetaryAmount) | Blank node or named node |

### 2. Data Binding Truth Source

**Problem**: Three overlapping mechanisms for semantic mappings create confusion and inconsistency.

**Decision**: Establish a single source of truth with clear hierarchy.

#### 2.1 Unified Semantic Mapping Model

```yaml
DatasetDefinition:
  iri: "data:MarketDataFeed"
  definition: "real-time market data from Bloomberg"
  ontologyType: "fin:PriceObservation"
  
  fields:
    - name: "ticker"
      type: string
      semanticMapping:
        targetAttribute: "fin:instrument"
        transformation: "data:TickerToISIN"
    
    - name: "price"
      type: decimal
      semanticMapping:
        targetAttribute: "fin:quotedPrice.amount"
        transformation: null  # direct copy
    
    - name: "currency"
      type: string
      semanticMapping:
        targetAttribute: "fin:quotedPrice.currency"
        transformation: "data:CurrencyStringToCode"
    
    - name: "timestamp"
      type: datetime
      semanticMapping:
        targetAttribute: "fin:observedAt"
        transformation: null
```

**Key Changes**:
- **Remove `Dataset.semanticMappings`**: Redundant with field-level mappings
- **Keep `Field.semanticMapping`**: Inline, co-located with field definition
- **Remove standalone `FieldMappingDefinition`**: Mappings always belong to a dataset
- **Dot notation for nested fields**: `quotedPrice.amount` targets field within structured value

#### 2.2 Transformation Reference

Replace free strings with typed references:

```yaml
TransformationDefinition:
  iri: "data:TickerToISIN"
  definition: "map exchange ticker to ISIN identifier"
  kind: LookupTransformation
  sourceType: string
  targetType: "fin:ISINType"
  implementation:
    lookupTable: "data:TickerISINMapping"
    cacheSeconds: 3600
    onMissingKey: "error"

TransformationDefinition:
  iri: "data:CurrencyStringToCode"
  definition: "map currency string to ISO 4217 code"
  kind: MappingTransformation
  sourceType: string
  targetType: "fin:CurrencyCode"
  implementation:
    mapping:
      "US Dollar": "USD"
      "Euro": "EUR"
      "Japanese Yen": "JPY"
```

**Field Mapping with Transformation**:
```yaml
fields:
  - name: "ticker"
    type: string
    semanticMapping:
      targetAttribute: "fin:instrument"
      transformation:
        transformationIri: "data:TickerToISIN"
        parameters: {}
```

### 3. Value Object Field Path Resolution

For structured value types, semantic mappings can target nested fields:

**Notation**: `attributeIri.fieldName`

**Example**:
```yaml
semanticMapping:
  targetAttribute: "fin:quotedPrice.amount"
```

**Resolution Algorithm**:
1. Parse target into `(attributeIri, fieldPath)`
   - `fin:quotedPrice.amount` → attribute=`fin:quotedPrice`, field=`amount`
2. Look up attribute definition: `fin:quotedPrice` has `valueType: fin:MoneyType`
3. Look up value type definition: `fin:MoneyType` has field `amount: {type: decimal}`
4. Validate source field type matches target field type (with transformation if specified)
5. Generate M1 fact construction code:
   ```python
   price_value = MonetaryAmount(
       amount=Decimal(row['price']),
       currency=transform_currency(row['currency'])
   )
   fact.quotedPrice = price_value
   ```

### 4. M1 Fact Generation Pipeline

**Input**: Dataset records (CSV, JSON, database rows)  
**Output**: M1 facts (RDF/Turtle, PostgreSQL JSONB, FoundationDB tuples)

**Pipeline Stages**:

1. **Schema Validation**: Check source data against `Dataset.fields` schema
2. **Transformation**: Apply transformations to mapped fields
3. **Value Object Construction**: Build structured values from multiple source fields
4. **Fact Assembly**: Create M1 fact instance with all attributes
5. **Pattern Application**: Inject pattern attributes (publishedAt, receivedAt, etc.)
6. **Validation**: Check required fields, data type constraints, logical key uniqueness
7. **Persistence**: Write to fact store with bi-temporal metadata

**Pseudocode**:
```python
def generate_m1_fact(dataset_def, source_row):
    fact = {}
    fact['@type'] = dataset_def.ontologyType
    
    # Group fields by target attribute (for structured values)
    attr_fields = defaultdict(dict)
    for field in dataset_def.fields:
        if field.semanticMapping:
            target = field.semanticMapping.targetAttribute
            if '.' in target:
                attr_iri, field_name = target.split('.', 1)
                attr_fields[attr_iri][field_name] = transform_field(field, source_row[field.name])
            else:
                fact[target] = transform_field(field, source_row[field.name])
    
    # Construct structured values
    for attr_iri, field_values in attr_fields.items():
        attr_def = lookup_attribute(attr_iri)
        value_type_def = lookup_type(attr_def.valueType)
        fact[attr_iri] = construct_value_object(value_type_def, field_values)
    
    # Apply patterns (inject temporal, provenance metadata)
    apply_patterns(fact, dataset_def)
    
    # Validate
    validate_fact(fact, dataset_def.ontologyType)
    
    return fact
```

## Acceptance Criteria

- [ ] OWL projection documented for all value type categories (primitive, identifier, codelist, structured)
- [ ] Concrete examples showing M3 → M2 → M1 transformation for:
  - [ ] Primitive attribute (ISIN)
  - [ ] Structured value attribute (Money)
  - [ ] CodeList attribute (Currency)
- [ ] Data binding simplified:
  - [ ] `Dataset.semanticMappings` removed (deprecated)
  - [ ] `FieldMappingDefinition` removed as standalone type
  - [ ] `Field.semanticMapping` is sole truth source
- [ ] Transformation references use typed IRIs, not free strings
- [ ] Dot notation field paths resolve correctly for nested fields
- [ ] M1 fact generation pipeline implemented with all 7 stages
- [ ] Test cases cover:
  - [ ] Simple field mapping (string → ISIN)
  - [ ] Structured value construction (price+currency → Money)
  - [ ] Transformation with lookup table
  - [ ] Missing required field errors
  - [ ] Type mismatch errors

## Implementation Plan

### Phase 1: Update Meta-Model
- [ ] Remove `Dataset.semanticMappings` field
- [ ] Remove `FieldMappingDefinition` type
- [ ] Add `TransformationDefinition` type
- [ ] Document field path notation in ADR

### Phase 2: Transformation Library
- [ ] Define standard transformation types (Lookup, Mapping, Expression, Script)
- [ ] Implement transformation executor
- [ ] Add transformation result caching

### Phase 3: Value Object Constructors
- [ ] Generate constructor code from StructuredValueTypeDefinition
- [ ] Implement field path resolver
- [ ] Add validation for required fields

### Phase 4: M1 Fact Generator
- [ ] Implement 7-stage pipeline
- [ ] Add OWL/Turtle serializer
- [ ] Add PostgreSQL JSONB serializer
- [ ] Add FoundationDB tuple serializer

### Phase 5: Test Suite
- [ ] Unit tests for each transformation type
- [ ] Integration tests for end-to-end pipeline
- [ ] Property-based tests for type safety

## Consequences

### Positive
- **Clear semantics**: One way to define semantic mappings
- **Type safety**: Transformations are checked at build time
- **Composability**: Structured values can nest arbitrarily
- **Provable correctness**: M1 facts mechanically derived from M3 definitions

### Negative
- **Breaking change**: Existing `Dataset.semanticMappings` must migrate
- **Learning curve**: Dot notation and transformation references are new concepts
- **Implementation effort**: M1 fact generator is substantial code

### Risks
- **Transformation bugs**: Incorrect transformations corrupt data silently
- **Performance**: Complex transformations may be slow at scale
- **Version skew**: Transformation logic changes require data backfill

## Migration Path

1. Audit existing datasets using `semanticMappings`
2. Generate migration script to convert to field-level `semanticMapping`
3. Deprecate `Dataset.semanticMappings` (warning in v0.4.0)
4. Remove `Dataset.semanticMappings` (error in v0.5.0)
5. Backfill transformed data with new transformation IRIs

## References

- ADR-004: Meta-Model Foundation
- ADR-005: Executable Meta-Language
- ADR-006: Pattern and Time Semantics
- OWL 2 Web Ontology Language: RDF-Based Semantics (W3C Recommendation)
- JSON-LD 1.1: A JSON-based Serialization for Linked Data
