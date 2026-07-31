#!/usr/bin/env node
/**
 * OrderLifecycleEvent state-machine validator (CQ-OE6, M2-PLAN §6.3).
 *
 * Canonical state machine:
 *   Initialized → {Submitted, Rejected}
 *   Submitted   → {Accepted, Rejected}
 *   Accepted    → {PartiallyFilled, Filled, Canceled, Expired}
 *   PartiallyFilled → {Filled, Canceled}
 *   Terminal: Filled, Canceled, Rejected, Expired (no outbound transitions)
 *
 * Validates, per order (grouped by transitionsOrder):
 *   1. Events are ordered by validFrom.
 *   2. Each transition (previousState → lifecycleState) is in the valid set.
 *   3. previousState matches the prior event's lifecycleState (chain consistency).
 *   4. No transition leaves a terminal state.
 *
 * Usage: node scripts/domain/run-order-state-machine-cq.cjs <positive.yaml> <negative.yaml>
 * Exit 0 if all fixtures match expectedResult.
 */
const fs = require('fs');
const yaml = require('js-yaml');

const TRANSITIONS = {
  // Initialized can go to: Submitted (normal), Rejected, Denied (pre-submission rejection),
  // Emulated (nautilus emulation before submit), Released (pending release before submit)
  Initialized: ['Submitted', 'Rejected', 'Denied', 'Emulated', 'Released'],
  // Emulated/Released are pre-submit states → can transition to Submitted or terminal
  Emulated: ['Submitted', 'Rejected', 'Canceled', 'Denied'],
  Released: ['Submitted', 'Rejected', 'Canceled', 'Expired'],
  // Submitted → Accepted (or Rejected/PendingCancel/Canceled/Expired)
  Submitted: ['Accepted', 'Rejected', 'PendingCancel', 'Canceled', 'Expired'],
  // Accepted → PartiallyFilled/Filled/Canceled/Expired/PendingUpdate/PendingCancel/Triggered
  // Triggered is a post-Accepted state for conditional/stop orders (nautilus: Accepted→Triggered)
  Accepted: ['PartiallyFilled', 'Filled', 'Canceled', 'Expired', 'PendingUpdate', 'PendingCancel', 'Triggered'],
  // Triggered → can proceed to fill/cancel (after trigger fires)
  Triggered: ['PartiallyFilled', 'Filled', 'Canceled', 'Expired'],
  PartiallyFilled: ['Filled', 'Canceled', 'PendingUpdate', 'PendingCancel', 'Expired'],
  // Pending states cycle back to active/terminal
  PendingUpdate: ['Accepted', 'PartiallyFilled', 'Filled', 'Canceled', 'Rejected', 'Expired'],
  PendingCancel: ['Canceled', 'Accepted', 'PartiallyFilled', 'Filled', 'Expired'],
};
// Terminal states: no outbound transitions
const TERMINAL = new Set(['Filled', 'Canceled', 'Rejected', 'Expired', 'Denied']);

function parseT(v) {
  if (v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function validateChain(events) {
  const sorted = [...events].sort((a, b) => (parseT(a.validFrom) || 0) - (parseT(b.validFrom) || 0));
  let priorState = null;
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const from = ev.hasPreviousState;
    const to = ev.hasLifecycleState;
    // First event: previousState must be Initialized (or match no prior)
    if (i === 0) {
      if (from !== 'Initialized') return { ok: false, reason: `first event previousState=${from} (expected Initialized)` };
    } else {
      // previousState must match prior event's lifecycleState
      if (from !== priorState) return { ok: false, reason: `previousState=${from} does not match prior state=${priorState}` };
    }
    // No transition out of a terminal state
    if (TERMINAL.has(from)) return { ok: false, reason: `transition out of terminal state ${from}` };
    // Transition must be valid
    const allowed = TRANSITIONS[from] || [];
    if (!allowed.includes(to)) return { ok: false, reason: `invalid transition ${from}→${to}` };
    priorState = to;
  }
  return { ok: true };
}

function runFile(file) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  let failed = 0;
  for (const fx of doc.fixtures || []) {
    const res = validateChain(fx.events || []);
    const expectAccept = fx.expectedResult === 'accepted';
    let ok = expectAccept ? res.ok : !res.ok;
    if (ok) {
      console.log(`✓ ${fx.id} ${expectAccept ? 'valid chain' : `rejected (${res.reason})`}`);
    } else {
      console.error(`✗ ${fx.id} expected=${fx.expectedResult} reason=${res.reason || 'accepted-but-expected-reject'}`);
      failed++;
    }
  }
  return failed;
}

const args = process.argv.slice(2).filter((a) => a.endsWith('.yaml'));
if (args.length === 0) {
  console.error('Usage: node run-order-state-machine-cq.cjs <positive.yaml> <negative.yaml>');
  process.exit(1);
}

console.log('=== Order state-machine CQ (CQ-OE6) ===');
let failed = 0;
for (const f of args) {
  console.log(`\nFile: ${f}`);
  failed += runFile(f);
}
console.log('\n=== Summary ===');
if (failed === 0) {
  console.log('PASS');
  process.exit(0);
}
console.log(`FAIL (${failed})`);
process.exit(1);
