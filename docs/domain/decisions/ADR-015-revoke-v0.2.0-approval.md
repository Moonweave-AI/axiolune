# ADR-015: Revoke M2 v0.2.0 Approval

**Status**: Accepted  
**Date**: 2026-08-03  
**Supersedes**: v0.2.0 release authorization in ADR-014 header and Round-9 narrative

## Context

Prior review rounds (through Round 9) recorded M2 v0.2.0 as `approved` based heavily on formal gate PASS counts, artifact digests, and module-registry byte locks. Subsequent v0.3.0 semantic expansion exposed:

- Lifecycle story gaps (especially post-trade, risk, cross-module boundaries)
- Competency questions left as stubs while ontology YAML grew large
- CQ probes that PASS on empty staging ("v03 staging pending")
- False completion signal from digest/gate green without narratable semantics

## Decision

1. **Revoke** all v0.2.0 `approved` claims for finance domain modules.
2. **Reset** acceptance bar to **semantic/system completeness** per RFC-001 and M2-SEMANTIC-QUALITY-RUBRIC.
3. **Remove** digest locks and byte-lock completion criteria from governance docs (ADR-013/014, module-registry).
4. **Replace** `references.lock.yaml` digest closure with `references.bibliography.yaml` (locator-only).
5. v0.3.0 modules remain **`draft`** until Round-11 semantic review authorizes `approved`.

## Consequences

- Do not cite `releases/v0.2.0/` or Round-9 APPROVED reports as current evidence.
- `test-all-domain` PASS is smoke only until semantic gap matrix clears.
- Round-10 records Stop-Ship; Round-11 may authorize approval after semantic work.
