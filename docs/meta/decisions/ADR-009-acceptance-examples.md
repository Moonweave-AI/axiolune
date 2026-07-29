# ADR-009: Acceptance Examples

**Status**: Proposed  
**Date**: 2026-07-28  
**Requires**: ADR-004 through ADR-008

## Context

The evaluation feedback requested five concrete acceptance examples that prove the meta-model works end-to-end:

1. **Securities Identifier Assignment** (ISIN/CUSIP/LEI)
2. **Market Price Observation** (PriceObservation)
3. **Position** (with bi-temporal semantics)
4. **Order Lifecycle** (Order → SubmitOrder Action → Fill → Complete)
5. **Research Assertion** (Claim → Evidence → Model Run)

These examples must demonstrate:
- M3 meta-model definitions
- M2 ontology (OWL projection)
- M1 business facts (concrete instances)
- Pattern application (temporal, provenance)
- Data mapping (from source systems)
- Behavior execution (actions and queries)

## Decision

We will provide complete, compilable examples for each of the five scenarios.

---

## Example 1: Securities Identifier Assignment

### Business Context

A new equity security is issued and must be assigned standardized identifiers (ISIN, CUSIP) and linked to the issuing entity (LEI).

### M3 Meta-Model Definitions

```yaml
# Identifier types
IdentifierTypeDefinition:
  iri: "fin:ISINType"
  definition: "International Securities Identification Number"
  format: "ISIN"
  validationPattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$"
  issuingAuthority: "Association of National Numbering Agencies (ANNA)"
  owlProjection:
    kind: rdfsDatatype
    baseType: xsd:string

IdentifierTypeDefinition:
  iri: "fin:CUSIPType"
  definition: "Committee on Uniform Securities Identification Procedures code"
  format: "CUSIP"
  validationPattern: "^[0-9]{3}[0-9A-Z]{5}[0-9]$"
  issuingAuthority: "CUSIP Global Services"
  owlProjection:
    kind: rdfsDatatype
    baseType: xsd:string

IdentifierTypeDefinition:
  iri: "fin:LEIType"
  definition: "Legal Entity Identifier"
  format: "LEI"
  validationPattern: "^[0-9A-Z]{18}[0-9]{2}$"
  issuingAuthority: "Global Legal Entity Identifier Foundation (GLEIF)"
  owlProjection:
    kind: rdfsDatatype
    baseType: xsd:string

# Attributes
AttributeTypeDefinition:
  iri: "fin:hasISIN"
  definition: "ISIN identifier of a security"
  valueType: "fin:ISINType"
  owlProjection:
    kind: datatypeProperty

AttributeTypeDefinition:
  iri: "fin:hasCUSIP"
  definition: "CUSIP identifier of a security"
  valueType: "fin:CUSIPType"
  owlProjection:
    kind: datatypeProperty

AttributeTypeDefinition:
  iri: "fin:hasLEI"
  definition: "LEI of legal entity"
  valueType: "fin:LEIType"
  owlProjection:
    kind: datatypeProperty

# Object types
ObjectTypeDefinition:
  iri: "fin:EquitySecurity"
  definition: "ownership share in a corporation"
  localAttributes:
    - "fin:hasISIN"
    - "fin:hasCUSIP"
    - "fin:securityName"
    - "fin:issuer"
  logicalKey:
    - "fin:hasISIN"
  owlProjection:
    kind: class

ObjectTypeDefinition:
  iri: "fin:LegalEntity"
  definition: "corporation, partnership, or other legal person"
  localAttributes:
    - "fin:hasLEI"
    - "fin:legalName"
  logicalKey:
    - "fin:hasLEI"
  owlProjection:
    kind: class
```

### M2 Ontology (OWL Projection)

```turtle
@prefix fin: <https://axiolune.ai/ontology/finance/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

fin:ISINType a rdfs:Datatype ;
  rdfs:subClassOf xsd:string ;
  owl:onDatatype xsd:string ;
  owl:withRestrictions ( [ xsd:pattern "^[A-Z]{2}[A-Z0-9]{9}[0-9]$" ] ) .

fin:CUSIPType a rdfs:Datatype ;
  rdfs:subClassOf xsd:string ;
  owl:onDatatype xsd:string ;
  owl:withRestrictions ( [ xsd:pattern "^[0-9]{3}[0-9A-Z]{5}[0-9]$" ] ) .

fin:LEIType a rdfs:Datatype ;
  rdfs:subClassOf xsd:string ;
  owl:onDatatype xsd:string ;
  owl:withRestrictions ( [ xsd:pattern "^[0-9A-Z]{18}[0-9]{2}$" ] ) .

fin:hasISIN a owl:DatatypeProperty ;
  rdfs:domain fin:EquitySecurity ;
  rdfs:range fin:ISINType .

fin:hasCUSIP a owl:DatatypeProperty ;
  rdfs:domain fin:EquitySecurity ;
  rdfs:range fin:CUSIPType .

fin:hasLEI a owl:DatatypeProperty ;
  rdfs:domain fin:LegalEntity ;
  rdfs:range fin:LEIType .

fin:EquitySecurity a owl:Class ;
  rdfs:subClassOf fin:Security .

fin:LegalEntity a owl:Class .
```

### M1 Business Facts

```turtle
# Legal entity (issuer)
fin:_entity_apple a fin:LegalEntity ;
  fin:hasLEI "549300K5MRUSN8ZAJ128"^^fin:LEIType ;
  fin:legalName "Apple Inc." .

# Equity security
fin:_security_aapl a fin:EquitySecurity ;
  fin:hasISIN "US0378331005"^^fin:ISINType ;
  fin:hasCUSIP "037833100"^^fin:CUSIPType ;
  fin:securityName "Apple Inc. Common Stock" ;
  fin:issuer fin:_entity_apple .
```

### Validation

```python
import re

def validate_isin(isin: str) -> bool:
    return bool(re.match(r'^[A-Z]{2}[A-Z0-9]{9}[0-9]$', isin))

def validate_cusip(cusip: str) -> bool:
    return bool(re.match(r'^[0-9]{3}[0-9A-Z]{5}[0-9]$', cusip))

def validate_lei(lei: str) -> bool:
    return bool(re.match(r'^[0-9A-Z]{18}[0-9]{2}$', lei))

assert validate_isin("US0378331005")
assert validate_cusip("037833100")
assert validate_lei("549300K5MRUSN8ZAJ128")
```

---

## Example 2: Market Price Observation

### Business Context

Real-time market data feeds publish price observations (bid, ask, last) with timestamps and provenance.

### M3 Meta-Model Definitions

```yaml
# Structured value types
StructuredValueTypeDefinition:
  iri: "fin:MoneyType"
  definition: "monetary amount with currency"
  requiredFields:
    amount: {type: decimal}
    currency: {type: "fin:CurrencyCode"}
  owlProjection:
    kind: valueClass
    classIri: "fin:MonetaryAmount"

CodeListTypeDefinition:
  iri: "fin:PriceType"
  definition: "type of price quote"
  codes:
    - {code: "Bid", label: "Bid price"}
    - {code: "Ask", label: "Ask price"}
    - {code: "Last", label: "Last traded price"}
    - {code: "Mid", label: "Mid-point of bid-ask"}
  owlProjection:
    kind: enumeration

# Attributes
AttributeTypeDefinition:
  iri: "fin:instrument"
  definition: "financial instrument being priced"
  valueType: "fin:Instrument"
  owlProjection:
    kind: objectProperty

AttributeTypeDefinition:
  iri: "fin:priceType"
  definition: "type of price quote"
  valueType: "fin:PriceType"
  owlProjection:
    kind: datatypeProperty

AttributeTypeDefinition:
  iri: "fin:quotedPrice"
  definition: "price value"
  valueType: "fin:MoneyType"
  owlProjection:
    kind: objectProperty
    range: fin:MonetaryAmount

# Object type with patterns
ObjectTypeDefinition:
  iri: "fin:PriceObservation"
  definition: "observed market price at a point in time"
  appliedPatterns:
    - "ax-pattern:TemporalFact"
    - "ax-pattern:ProvenancedFact"
  localAttributes:
    - "fin:instrument"
    - "fin:priceType"
    - "fin:quotedPrice"
  logicalKey:
    - "fin:instrument"
    - "fin:priceType"
    - "fin:observedAt"
  owlProjection:
    kind: class
```

### Pattern Application

```yaml
# Injected from TemporalFact → PublicationTiming
- fin:publishedAt      # When source published
- fin:receivedAt       # When we received
- fin:observedAt       # When price was observed (valid time)
- fin:availableAt      # When price became available

# Injected from ProvenancedFact → PublicationTiming (already injected, skip)
- fin:source           # Data source
- fin:sourceVersion    # Source schema version
- fin:confidence       # Data quality score
- fin:revision         # Revision number
- fin:derivedFrom      # Previous version IRI
```

### M2 Ontology (OWL Projection)

```turtle
fin:MonetaryAmount a owl:Class .

fin:monetaryAmount a owl:DatatypeProperty ;
  rdfs:domain fin:MonetaryAmount ;
  rdfs:range xsd:decimal .

fin:currencyCode a owl:DatatypeProperty ;
  rdfs:domain fin:MonetaryAmount ;
  rdfs:range fin:CurrencyCode .

fin:PriceType a owl:Class ;
  owl:oneOf ( "Bid" "Ask" "Last" "Mid" ) .

fin:quotedPrice a owl:ObjectProperty ;
  rdfs:domain fin:PriceObservation ;
  rdfs:range fin:MonetaryAmount .

fin:PriceObservation a owl:Class ;
  rdfs:subClassOf [
    a owl:Restriction ;
    owl:onProperty fin:instrument ;
    owl:cardinality 1
  ] ;
  rdfs:subClassOf [
    a owl:Restriction ;
    owl:onProperty fin:quotedPrice ;
    owl:cardinality 1
  ] .
```

### M1 Business Facts

```turtle
fin:_priceObs_20260728_103000_aapl_last a fin:PriceObservation ;
  # Local attributes
  fin:instrument fin:_security_aapl ;
  fin:priceType "Last"^^fin:PriceType ;
  fin:quotedPrice [
    a fin:MonetaryAmount ;
    fin:monetaryAmount "150.05"^^xsd:decimal ;
    fin:currencyCode "USD"^^fin:CurrencyCode
  ] ;
  
  # From TemporalFact
  fin:observedAt "2026-07-28T10:30:00.000Z"^^xsd:dateTime ;
  fin:availableAt "2026-07-28T10:30:00.125Z"^^xsd:dateTime ;
  fin:publishedAt "2026-07-28T10:30:00.100Z"^^xsd:dateTime ;
  fin:receivedAt "2026-07-28T10:30:00.523Z"^^xsd:dateTime ;
  
  # From ProvenancedFact
  fin:source "Bloomberg Market Data Feed"^^xsd:string ;
  fin:sourceVersion "v2.5.1"^^xsd:string ;
  fin:confidence "0.99"^^xsd:decimal ;
  fin:revision 1 .
```

### Data Mapping

```yaml
DatasetDefinition:
  iri: "data:BloombergPriceFeed"
  definition: "real-time price feed from Bloomberg"
  ontologyType: "fin:PriceObservation"
  
  fields:
    - name: "ticker"
      type: string
      semanticMapping:
        targetAttribute: "fin:instrument"
        transformation:
          transformationIri: "data:TickerToInstrumentIRI"
    
    - name: "priceType"
      type: string
      semanticMapping:
        targetAttribute: "fin:priceType"
    
    - name: "price"
      type: decimal
      semanticMapping:
        targetAttribute: "fin:quotedPrice.amount"
    
    - name: "currency"
      type: string
      semanticMapping:
        targetAttribute: "fin:quotedPrice.currency"
    
    - name: "timestamp"
      type: datetime
      semanticMapping:
        targetAttribute: "fin:observedAt"
```

### Query Example

```yaml
QueryTypeDefinition:
  iri: "fin:GetLatestPrice"
  definition: "get most recent price for instrument"
  querySemantics: current
  parameters:
    instrument: {type: "fin:Instrument"}
    priceType: {type: "fin:PriceType"}
  returnType: "fin:PriceObservation?"

# SQL implementation
SELECT *
FROM price_observations
WHERE instrument = :instrument
  AND price_type = :priceType
  AND received_at <= NOW()
ORDER BY revision DESC, received_at DESC
LIMIT 1
```

---

## Example 3: Position (Bi-Temporal)

### Business Context

Track holdings of securities over time, supporting both transaction time (when facts recorded) and valid time (when holdings changed).

### M3 Meta-Model Definitions

```yaml
StructuredValueTypeDefinition:
  iri: "fin:QuantityType"
  definition: "quantity with unit of measure"
  requiredFields:
    amount: {type: decimal}
    unit: {type: string}
  owlProjection:
    kind: valueClass
    classIri: "fin:Quantity"

ObjectTypeDefinition:
  iri: "fin:Position"
  definition: "holding of a security at a point in time"
  appliedPatterns:
    - "ax-pattern:TemporalFact"
    - "ax-pattern:ProvenancedFact"
  localAttributes:
    - "fin:account"
    - "fin:instrument"
    - "fin:quantity"
    - "fin:costBasis"
  logicalKey:
    - "fin:account"
    - "fin:instrument"
    - "fin:observedAt"
  owlProjection:
    kind: class
```

### M1 Business Facts (Time Series)

```turtle
# Initial position (t0)
fin:_pos_acct123_aapl_t0 a fin:Position ;
  fin:account fin:_account_123 ;
  fin:instrument fin:_security_aapl ;
  fin:quantity [
    a fin:Quantity ;
    fin:amount "0"^^xsd:decimal ;
    fin:unit "shares"^^xsd:string
  ] ;
  fin:observedAt "2026-07-28T09:00:00Z"^^xsd:dateTime ;
  fin:receivedAt "2026-07-28T09:00:05Z"^^xsd:dateTime ;
  fin:revision 1 .

# After buy order (t1)
fin:_pos_acct123_aapl_t1 a fin:Position ;
  fin:account fin:_account_123 ;
  fin:instrument fin:_security_aapl ;
  fin:quantity [
    a fin:Quantity ;
    fin:amount "100"^^xsd:decimal ;
    fin:unit "shares"^^xsd:string
  ] ;
  fin:observedAt "2026-07-28T10:30:00Z"^^xsd:dateTime ;
  fin:receivedAt "2026-07-28T10:30:15Z"^^xsd:dateTime ;
  fin:revision 1 .

# Corrected position (t1, revision 2)
fin:_pos_acct123_aapl_t1_r2 a fin:Position ;
  fin:account fin:_account_123 ;
  fin:instrument fin:_security_aapl ;
  fin:quantity [
    a fin:Quantity ;
    fin:amount "105"^^xsd:decimal ;
    fin:unit "shares"^^xsd:string
  ] ;
  fin:observedAt "2026-07-28T10:30:00Z"^^xsd:dateTime ;
  fin:receivedAt "2026-07-28T10:35:00Z"^^xsd:dateTime ;
  fin:revision 2 ;
  fin:derivedFrom fin:_pos_acct123_aapl_t1 .
```

### Bi-Temporal Query

```yaml
QueryTypeDefinition:
  iri: "fin:GetPositionAsOf"
  definition: "retrieve position as it was known at specific transaction time"
  querySemantics: pointInTime
  parameters:
    account: {type: "fin:Account"}
    instrument: {type: "fin:Instrument"}
    validTime: {type: datetime}
    asOfTime: {type: datetime}
  returnType: "fin:Position?"

# Query examples
GetPositionAsOf(
  account=acct123,
  instrument=AAPL,
  validTime=2026-07-28T10:30:00Z,
  asOfTime=2026-07-28T10:32:00Z
) → quantity=100 (revision 1, not yet corrected)

GetPositionAsOf(
  account=acct123,
  instrument=AAPL,
  validTime=2026-07-28T10:30:00Z,
  asOfTime=2026-07-28T10:40:00Z
) → quantity=105 (revision 2, correction applied)
```

---

## Example 4: Order Lifecycle

### Business Context

Submit order → receive acknowledgment → partial fills → complete or cancel.

### M3 Meta-Model Definitions

```yaml
CodeListTypeDefinition:
  iri: "fin:OrderStatus"
  definition: "lifecycle status of order"
  codes:
    - {code: "Draft", label: "Created but not submitted"}
    - {code: "Submitted", label: "Sent to exchange"}
    - {code: "Acknowledged", label: "Accepted by exchange"}
    - {code: "PartiallyFilled", label: "Partially executed"}
    - {code: "Filled", label: "Fully executed"}
    - {code: "Canceled", label: "Canceled before complete"}
    - {code: "Rejected", label: "Rejected by exchange"}

ObjectTypeDefinition:
  iri: "fin:Order"
  definition: "instruction to buy or sell security"
  localAttributes:
    - "fin:account"
    - "fin:instrument"
    - "fin:orderType"
    - "fin:quantity"
    - "fin:limitPrice"
    - "fin:status"
    - "fin:externalOrderId"
    - "fin:filledQuantity"
  logicalKey:
    - "fin:externalOrderId"

ActionTypeDefinition:
  iri: "fin:SubmitOrder"
  definition: "submit order to exchange"
  targetType: "fin:Order"
  parameters:
    order: {type: "fin:Order"}
  preconditions:
    - "target.status == 'Draft'"
    - "target.quantity > 0"
  effects:
    - "target.status = 'Submitted'"
    - "target.externalOrderId IS NOT NULL"
  isIdempotent: false
  timeoutSeconds: 30

ActionTypeDefinition:
  iri: "fin:CancelOrder"
  definition: "cancel open order"
  targetType: "fin:Order"
  parameters:
    order: {type: "fin:Order"}
  preconditions:
    - "target.status IN ['Submitted', 'Acknowledged', 'PartiallyFilled']"
  effects:
    - "target.status = 'Canceled'"
  isIdempotent: true
  retryPolicy:
    maxAttempts: 3
    backoffMs: 1000
```

### M1 Business Facts (Lifecycle)

```turtle
# Order created (Draft)
fin:_order_001 a fin:Order ;
  fin:account fin:_account_123 ;
  fin:instrument fin:_security_aapl ;
  fin:orderType "Limit"^^fin:OrderType ;
  fin:quantity [
    a fin:Quantity ;
    fin:amount "1000"^^xsd:decimal ;
    fin:unit "shares"^^xsd:string
  ] ;
  fin:limitPrice [
    a fin:MonetaryAmount ;
    fin:monetaryAmount "150.00"^^xsd:decimal ;
    fin:currencyCode "USD"^^fin:CurrencyCode
  ] ;
  fin:status "Draft"^^fin:OrderStatus ;
  fin:filledQuantity "0"^^xsd:decimal .

# After SubmitOrder action
fin:_order_001 a fin:Order ;
  fin:status "Submitted"^^fin:OrderStatus ;
  fin:externalOrderId "EXG-ORD-789456"^^xsd:string ;
  fin:submittedAt "2026-07-28T10:00:00Z"^^xsd:dateTime .

# After partial fill
fin:_order_001 a fin:Order ;
  fin:status "PartiallyFilled"^^fin:OrderStatus ;
  fin:filledQuantity "300"^^xsd:decimal .

# After complete fill
fin:_order_001 a fin:Order ;
  fin:status "Filled"^^fin:OrderStatus ;
  fin:filledQuantity "1000"^^xsd:decimal ;
  fin:completedAt "2026-07-28T10:15:00Z"^^xsd:dateTime .
```

### Execution Records

```turtle
fin:_exec_submit_001 a ax-behavior:ExecutionRecord ;
  ax-behavior:executionId "exec:uuid-12345" ;
  ax-behavior:actionType fin:SubmitOrder ;
  ax-behavior:targetEntity fin:_order_001 ;
  ax-behavior:status "Success"^^ax-behavior:ExecutionStatus ;
  ax-behavior:startedAt "2026-07-28T10:00:00.000Z"^^xsd:dateTime ;
  ax-behavior:completedAt "2026-07-28T10:00:00.523Z"^^xsd:dateTime ;
  ax-behavior:externalRequestId "req-uuid-abcdef"^^xsd:string ;
  ax-behavior:externalStatus "Acknowledged"^^xsd:string ;
  ax-behavior:outcome "Order submitted successfully: EXG-ORD-789456"^^xsd:string .
```

---

## Example 5: Research Assertion

### Business Context

Analyst makes a claim (e.g., "AAPL target price $175"), backed by evidence (financial reports, model runs).

### M3 Meta-Model Definitions

```yaml
ObjectTypeDefinition:
  iri: "research:Assertion"
  definition: "analyst claim with confidence and validity period"
  appliedPatterns:
    - "ax-pattern:ProvenancedFact"
  localAttributes:
    - "research:subject"
    - "research:predicate"
    - "research:object"
    - "research:confidenceLevel"
    - "research:validFrom"
    - "research:validUntil"
    - "research:evidence"
  logicalKey:
    - "research:subject"
    - "research:predicate"
    - "research:validFrom"

ObjectTypeDefinition:
  iri: "research:Evidence"
  definition: "supporting data for assertion"
  localAttributes:
    - "research:evidenceType"
    - "research:sourceDocument"
    - "research:extractedData"

ObjectTypeDefinition:
  iri: "research:ModelRun"
  definition: "execution of quantitative model"
  localAttributes:
    - "research:modelId"
    - "research:inputs"
    - "research:outputs"
    - "research:executedAt"
```

### M1 Business Facts

```turtle
# Assertion: "AAPL target price is $175"
research:_assertion_001 a research:Assertion ;
  research:subject fin:_security_aapl ;
  research:predicate "targetPrice"^^xsd:string ;
  research:object [
    a fin:MonetaryAmount ;
    fin:monetaryAmount "175.00"^^xsd:decimal ;
    fin:currencyCode "USD"^^fin:CurrencyCode
  ] ;
  research:confidenceLevel "High"^^research:ConfidenceLevel ;
  research:validFrom "2026-07-28T00:00:00Z"^^xsd:dateTime ;
  research:validUntil "2026-10-28T00:00:00Z"^^xsd:dateTime ;
  research:evidence research:_evidence_001, research:_evidence_002 ;
  
  # From ProvenancedFact
  fin:source "Senior Equity Analyst"^^xsd:string ;
  fin:publishedAt "2026-07-28T08:00:00Z"^^xsd:dateTime ;
  fin:revision 1 .

# Evidence 1: Financial report
research:_evidence_001 a research:Evidence ;
  research:evidenceType "FinancialReport"^^research:EvidenceType ;
  research:sourceDocument "AAPL Q3 2026 Earnings Report"^^xsd:string ;
  research:extractedData "Revenue: $85.5B, EPS: $1.52"^^xsd:string .

# Evidence 2: DCF model run
research:_evidence_002 a research:ModelRun ;
  research:modelId "DCF-v3.2"^^xsd:string ;
  research:inputs [
    research:wacc "0.08"^^xsd:decimal ;
    research:terminalGrowthRate "0.03"^^xsd:decimal ;
    research:projectedFCF "[ 25.2, 28.1, 31.5, 34.8, 38.2 ]"^^xsd:string
  ] ;
  research:outputs [
    research:fairValue "174.85"^^xsd:decimal
  ] ;
  research:executedAt "2026-07-27T15:30:00Z"^^xsd:dateTime .
```

---

## Acceptance Criteria

- [ ] All five examples are complete and internally consistent
- [ ] Each example shows M3 → M2 → M1 transformation
- [ ] Pattern application is demonstrated (TemporalFact, ProvenancedFact)
- [ ] Data mapping is shown for external sources
- [ ] Bi-temporal query works for Position example
- [ ] Action execution lifecycle is proven for Order example
- [ ] All examples validate against JSON Schema (ADR-005)
- [ ] All TypeRefs resolve correctly
- [ ] OWL projection generates valid Turtle
- [ ] Examples can be compiled into runnable test cases

## Implementation Plan

### Phase 1: Define Example Ontologies
- [ ] Create `ontology/finance/securities.yaml` (Example 1)
- [ ] Create `ontology/finance/market-data.yaml` (Example 2)
- [ ] Create `ontology/finance/positions.yaml` (Example 3)
- [ ] Create `ontology/finance/orders.yaml` (Example 4)
- [ ] Create `ontology/research/assertions.yaml` (Example 5)

### Phase 2: Generate OWL Projections
- [ ] Implement OWL generator (reads M3, writes Turtle)
- [ ] Validate generated OWL with Protégé
- [ ] Check consistency with HermiT reasoner

### Phase 3: Create M1 Test Data
- [ ] Generate sample facts for each example
- [ ] Validate facts against ontology
- [ ] Load into triple store (e.g., Apache Jena Fuseki)

### Phase 4: Implement Queries
- [ ] Implement point-in-time query for Position
- [ ] Implement current query for Price
- [ ] Test query results match expected values

### Phase 5: Implement Actions
- [ ] Implement SubmitOrder action with execution records
- [ ] Simulate timeout and recovery
- [ ] Verify idempotency enforcement

## Consequences

### Positive
- **End-to-end proof**: Meta-model works for real-world scenarios
- **Documentation**: Examples serve as living documentation
- **Test suite**: Examples become regression tests
- **Onboarding**: New developers can learn from concrete examples

### Negative
- **Maintenance**: Examples must be kept up-to-date with meta-model changes
- **Scope creep**: Examples could grow too complex

### Risks
- **Example drift**: Examples diverge from actual implementation
- **Incomplete coverage**: Five examples don't cover all meta-model features

## References

- ADR-004: Meta-Model Foundation
- ADR-005: Executable Meta-Language
- ADR-006: Pattern and Time Semantics
- ADR-007: Value Objects and Data Mapping
- ADR-008: Behavior Safety
- ISO 6166: ISIN specification
- ISO 17442: LEI specification
- FIX Protocol: Order message specifications
