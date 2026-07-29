# ADR-008: Behavior Safety

**Status**: Proposed  
**Date**: 2026-07-28  
**Requires**: ADR-004 (meta-model foundation), ADR-005 (executable meta-language), ADR-006 (pattern and time semantics)

## Context

The evaluation feedback identified critical gaps in behavior safety for real-world trading operations:

1. **Transaction Safety**: The current `ActionTypeDefinition` has `isIdempotent`, `retryPolicy`, and `timeoutSeconds`, but no proof these prevent double-execution
2. **Network Failure Handling**: No simulation of timeout, partial response, or unknown receipt scenarios
3. **External State Reconciliation**: When order status is unknown, how do we safely recover?
4. **Partial Fill Scenarios**: Order executed in multiple tranches needs careful state tracking

For a financial system, these failure modes are not edge cases—they are the normal operating environment. We must prove the behavior model handles them safely.

## Decision

### 1. Action Execution Semantics

Every `ActionTypeDefinition` execution must produce exactly one of these outcomes:

1. **Success**: Action completed, effects applied, durable record created
2. **Failure**: Action rejected, no effects applied, error recorded
3. **Unknown**: Action may or may not have completed (network timeout, lost response)

**Unknown** is the dangerous state—we cannot retry (risk double-execution) nor safely proceed (might lose the order).

### 2. Idempotency and Retry Safety

#### 2.1 Idempotency Requirements

An action is **idempotent** if executing it N times has the same effect as executing it once.

**Examples**:
- ✅ `SetPositionTarget(instrument=AAPL, shares=100)`: Setting to same target repeatedly is safe
- ✅ `CancelOrder(orderId=123)`: Canceling an already-canceled order is a no-op
- ❌ `SubmitMarketOrder(instrument=AAPL, quantity=100)`: Each execution creates a new order
- ❌ `AdjustPosition(instrument=AAPL, delta=+10)`: Each execution adds 10 more shares

**Meta-Model Annotation**:
```yaml
ActionTypeDefinition:
  iri: "fin:SubmitOrder"
  definition: "submit new order to exchange"
  isIdempotent: false      # NOT safe to retry
  retryPolicy: null        # no automatic retry

ActionTypeDefinition:
  iri: "fin:CancelOrder"
  definition: "cancel existing order"
  isIdempotent: true       # safe to retry
  retryPolicy:
    maxAttempts: 3
    backoffMs: 1000
    backoffMultiplier: 2.0
```

#### 2.2 Retry Policy Enforcement

**Rule**: Only idempotent actions can have automatic retry policy.

**Validation**:
```javascript
function validateRetryPolicy(actionDef) {
  if (actionDef.retryPolicy && !actionDef.isIdempotent) {
    throw new Error(
      `Action ${actionDef.iri} has retry policy but is not idempotent. ` +
      `Non-idempotent actions cannot be automatically retried.`
    );
  }
}
```

**Rationale**: Prevents accidental double-execution due to misconfigured retry.

### 3. Execution State Machine

Every action execution has an **ExecutionRecord** that tracks its lifecycle:

```yaml
ExecutionRecordDefinition:
  iri: "ax-behavior:ExecutionRecord"
  definition: "durable record of action execution attempt"
  requiredFields:
    executionId: {type: iri}                  # Unique ID for this execution
    actionType: {type: iri}                   # Which action
    targetEntity: {type: iri}                 # Which object (e.g., order)
    parameters: {type: "map[string,string]"}  # Action parameters
    status: {type: "enum[Pending,Running,Success,Failure,Unknown]"}
    startedAt: {type: datetime}
    completedAt: {type: "datetime?"}
    outcome: {type: "string?"}                # Success/error message
    externalRequestId: {type: "string?"}      # ID from external system
    externalStatus: {type: "string?"}         # Status from external system
```

**State Transitions**:
```
Pending → Running → Success
                  → Failure
                  → Unknown
```

**State Semantics**:
- **Pending**: Execution created but not started (queued)
- **Running**: Execution in progress (request sent to external system)
- **Success**: Execution confirmed complete (durable outcome)
- **Failure**: Execution confirmed failed (durable outcome)
- **Unknown**: Execution outcome not determined (timeout, lost response)

### 4. Failure Mode Simulations

We will simulate three critical failure scenarios and prove safe recovery.

#### 4.1 Scenario 1: Network Timeout (No Response)

**Setup**:
```yaml
Action: SubmitOrder
Parameters: {instrument: AAPL, quantity: 100, orderType: Market}
Execution: Send HTTP request to exchange API
Failure: Socket timeout after 5 seconds, no response received
```

**Execution Record**:
```yaml
executionId: "exec:12345"
actionType: "fin:SubmitOrder"
status: Unknown
startedAt: "2026-07-28T10:30:00Z"
externalRequestId: "req-abc-123"
outcome: "Network timeout after 5000ms, response not received"
```

**Safe Recovery Protocol**:
1. **Do NOT retry**: Action is not idempotent, retry risks double-order
2. **Poll external system**: Use `externalRequestId` to query order status
3. **Reconcile state**:
   - If order found → update ExecutionRecord to Success, record order details
   - If order not found after grace period (30s) → update ExecutionRecord to Failure
   - If external system unavailable → remain in Unknown, continue polling

**Implementation**:
```python
async def recover_unknown_execution(exec_record):
    # Poll with exponential backoff
    for attempt in range(10):
        await asyncio.sleep(2 ** attempt)
        
        try:
            status = await external_api.check_order_status(
                request_id=exec_record.externalRequestId
            )
            
            if status.found:
                # Order exists, update to Success
                exec_record.status = 'Success'
                exec_record.outcome = f'Order {status.orderId} confirmed via reconciliation'
                exec_record.externalStatus = status.orderStatus
                return 'Success'
            elif attempt >= 9:  # Last attempt
                # Order not found after 30+ seconds, assume failed
                exec_record.status = 'Failure'
                exec_record.outcome = 'Order not found in external system after timeout'
                return 'Failure'
        except ExternalAPIUnavailable:
            # External system down, keep trying
            continue
    
    # Still unknown after all attempts
    exec_record.outcome = 'Unable to reconcile: external system unavailable'
    return 'Unknown'
```

#### 4.2 Scenario 2: Partial Response (Acknowledgment but No Order ID)

**Setup**:
```yaml
Action: SubmitOrder
Execution: Send request, receive HTTP 202 Accepted, but response body truncated
Failure: Connection dropped mid-response, orderId not received
```

**Execution Record**:
```yaml
executionId: "exec:12346"
actionType: "fin:SubmitOrder"
status: Unknown
externalRequestId: "req-abc-124"
outcome: "Received HTTP 202 but response body incomplete, orderId missing"
```

**Safe Recovery Protocol**:
1. **Do NOT retry**: Order may have been created
2. **Use request ID for reconciliation**: Query external system with `externalRequestId`
3. **Match by order parameters**: If multiple orders found, match by (instrument, quantity, timestamp)
4. **Require human confirmation**: If ambiguous, escalate to operator

**Key Design**: `externalRequestId` is **client-generated UUID** sent in request header, allowing unambiguous reconciliation even without order ID in response.

#### 4.3 Scenario 3: Partial Fill (Order Executed in Multiple Tranches)

**Setup**:
```yaml
Action: SubmitOrder
Parameters: {instrument: AAPL, quantity: 1000, orderType: Limit, price: 150.00}
Execution: Order submitted successfully, orderId received
Events:
  - t=0s: Order accepted, status=Open, filled=0
  - t=10s: Partial fill, filled=300, remaining=700
  - t=30s: Partial fill, filled=600, remaining=400
  - t=60s: Filled, filled=1000, remaining=0
```

**Position Tracking**:
```python
# Initial state
position = 0
pending_order = Order(orderId='ord-123', quantity=1000, filled=0)

# After each fill event
def handle_fill_event(event):
    old_filled = pending_order.filled
    new_filled = event.filled
    delta = new_filled - old_filled
    
    # Update position (transaction)
    with db.transaction():
        position += delta
        pending_order.filled = new_filled
        
        # Record fill
        record_fill(
            orderId=pending_order.orderId,
            quantity=delta,
            price=event.fillPrice,
            timestamp=event.timestamp
        )
```

**Idempotency for Fill Events**:
- Fill events include `fillId` (unique per fill)
- Before applying fill, check if `fillId` already processed
- If duplicate, ignore (prevents double-counting)

```python
def handle_fill_event(event):
    if fill_already_processed(event.fillId):
        log.info(f"Duplicate fill event {event.fillId}, skipping")
        return
    
    # ... apply fill as above
    mark_fill_processed(event.fillId)
```

### 5. External State Reconciliation

**Problem**: Our internal state (orders, positions) can diverge from external system (exchange, broker) due to:
- Missed callbacks
- System downtime during events
- Network partitions

**Solution**: Periodic reconciliation loop

**Reconciliation Algorithm**:
```python
async def reconcile_orders():
    # Fetch all open orders from external system
    external_orders = await external_api.list_open_orders()
    
    # Fetch all locally-tracked open orders
    local_orders = db.query_orders(status='Open')
    
    # Match by orderId
    external_by_id = {o.orderId: o for o in external_orders}
    local_by_id = {o.orderId: o for o in local_orders}
    
    # Find discrepancies
    for order_id, local_order in local_by_id.items():
        external_order = external_by_id.get(order_id)
        
        if not external_order:
            # Order open locally but not on exchange → canceled externally?
            log.warning(f"Order {order_id} open locally but not found on exchange")
            await investigate_missing_order(order_id)
        elif local_order.filled != external_order.filled:
            # Fill count mismatch → missed fill events
            log.warning(f"Order {order_id} fill mismatch: local={local_order.filled}, external={external_order.filled}")
            await sync_fills(order_id, external_order.filled)
    
    # Orders on exchange but not local → created externally or missed confirmation
    for order_id, external_order in external_by_id.items():
        if order_id not in local_by_id:
            log.warning(f"Order {order_id} on exchange but not in local DB")
            await import_external_order(external_order)
```

**Reconciliation Frequency**:
- **Continuous**: Subscribe to real-time order/fill events
- **Periodic**: Poll every 60 seconds as backup
- **On-demand**: Manual reconciliation via operator command

### 6. Preconditions and Invariants

Actions can declare preconditions that must hold before execution:

```yaml
ActionTypeDefinition:
  iri: "fin:SubmitOrder"
  preconditions:
    - "target.status == 'Draft'"                     # Order must be in draft state
    - "account.balance >= estimatedCost(target)"      # Sufficient funds
    - "NOT EXISTS openOrder WHERE instrument = target.instrument"  # No existing open order for same instrument
```

**Enforcement**:
1. Check preconditions before execution
2. If violated, fail immediately (no external call)
3. Log precondition violation for debugging

**Invariants** (checked after execution):
```yaml
ActionTypeDefinition:
  iri: "fin:SubmitOrder"
  effects:
    - "target.status = 'Submitted'"
    - "target.externalOrderId IS NOT NULL"
  invariants:
    - "target.submittedAt IS NOT NULL"
    - "EXISTS executionRecord WHERE actionType = 'fin:SubmitOrder' AND targetEntity = target.iri"
```

### 7. Transaction Boundaries

For actions that update multiple entities, use database transactions:

```python
@transactional
async def execute_submit_order_action(action):
    # 1. Create execution record (Pending)
    exec_record = ExecutionRecord(
        executionId=generate_uuid(),
        actionType=action.actionType,
        status='Pending'
    )
    db.insert(exec_record)
    
    # 2. Check preconditions
    if not check_preconditions(action):
        exec_record.status = 'Failure'
        exec_record.outcome = 'Precondition violated'
        db.update(exec_record)
        raise PreconditionViolation()
    
    # 3. Update execution record (Running)
    exec_record.status = 'Running'
    exec_record.startedAt = now()
    db.update(exec_record)
    
    # 4. External call (outside transaction)
    try:
        response = await external_api.submit_order(action.parameters)
        
        # 5. Update order and execution record (Success)
        order.status = 'Submitted'
        order.externalOrderId = response.orderId
        exec_record.status = 'Success'
        exec_record.outcome = f'Order submitted: {response.orderId}'
        db.update(order)
        db.update(exec_record)
        
    except Timeout:
        # 6. Mark as Unknown (will be reconciled)
        exec_record.status = 'Unknown'
        exec_record.outcome = 'Network timeout'
        db.update(exec_record)
        schedule_reconciliation(exec_record.executionId)
```

## Acceptance Criteria

- [ ] `ActionTypeDefinition` validation rejects retry policy on non-idempotent actions
- [ ] `ExecutionRecord` schema defined with all required fields
- [ ] Three failure scenarios documented with recovery protocols:
  - [ ] Network timeout (no response)
  - [ ] Partial response (acknowledgment but no order ID)
  - [ ] Partial fills (multiple tranches)
- [ ] Reconciliation algorithm implemented with:
  - [ ] Order status sync
  - [ ] Fill event deduplication
  - [ ] Missing order detection
- [ ] Precondition and invariant checking integrated into action execution
- [ ] Transaction boundary examples provided for common actions
- [ ] Test suite covers:
  - [ ] Idempotent action retry succeeds
  - [ ] Non-idempotent action retry rejected
  - [ ] Timeout recovery via reconciliation
  - [ ] Duplicate fill event ignored
  - [ ] Precondition violation prevents execution

## Implementation Plan

### Phase 1: Execution Record Schema
- [ ] Add `ExecutionRecordDefinition` to behavior-meta-model.yaml
- [ ] Generate database schema (PostgreSQL, FoundationDB)
- [ ] Add execution record creation to action executor

### Phase 2: Retry Policy Validation
- [ ] Add validator in `validate-meta-model.js`
- [ ] Reject retry on non-idempotent actions
- [ ] Document idempotency patterns

### Phase 3: Reconciliation Service
- [ ] Implement order status polling
- [ ] Implement fill event deduplication
- [ ] Add periodic reconciliation job

### Phase 4: Precondition/Invariant Engine
- [ ] Parse precondition expressions
- [ ] Evaluate against runtime state
- [ ] Add invariant checks after execution

### Phase 5: Failure Mode Tests
- [ ] Simulate network timeout in test environment
- [ ] Test partial response handling
- [ ] Test partial fill scenarios

## Consequences

### Positive
- **Proven safety**: Failure modes explicitly handled
- **Audit trail**: Every execution recorded durably
- **Operational confidence**: System recovers from common failures automatically
- **Regulatory compliance**: Full execution history for audit

### Negative
- **Complexity**: Recovery logic adds substantial code
- **Latency**: Reconciliation adds overhead
- **Storage cost**: Execution records never deleted (append-only ledger)

### Risks
- **Reconciliation false positives**: Incorrectly marking Unknown as Failure
- **Race conditions**: Concurrent reconciliation and event processing
- **External API rate limits**: Frequent polling may hit limits

## Migration Path

1. Deploy `ExecutionRecord` schema (new table, no backfill needed)
2. Update action executor to create execution records
3. Run in shadow mode (record but don't enforce)
4. Add reconciliation service (alert-only mode)
5. Enable enforcement (block retry on non-idempotent actions)
6. Monitor for false positives, tune reconciliation timeouts

## References

- ADR-004: Meta-Model Foundation
- ADR-005: Executable Meta-Language
- ADR-006: Pattern and Time Semantics
- "Designing Data-Intensive Applications" (Martin Kleppmann) - Chapter 8: The Trouble with Distributed Systems
- "Release It!" (Michael T. Nygard) - Stability Patterns
- FIX Protocol: Order Management (for external state reconciliation patterns)
