# M2 Definition Style Guide (Practitioner-First)

**Status**: Proposed (Phase B — ADR-034)  
**Date**: 2026-08-07  
**Applies to**: `module.core.yaml` definitions and terminology cards during Phase B migration

## Purpose

Make M2 concepts readable to finance practitioners **using existing dialect fields only** (`label`, `definition`, `cnNote`). No new YAML keys.

## Rules

### R1 — Lead with the business concept

Write what the thing **is in market language**, not how the ontology stores it.

| ❌ Avoid | ✅ Prefer |
|---------|----------|
| Portfolio, is a stable managed collection whose logical identity is an authority-scoped identifier… | A portfolio groups accounts and holdings under one management mandate. Identity is the manager's portfolio ID, not a display name. |
| PriceObservation, is a versioned fact carrying… used for providing PIT-eligible prices… | A recorded price for an instrument at a point in time, with explicit as-of and knowledge timestamps. |

### R2 — Ban the mechanical template

**Do not** start definitions with `"<English Label>, is a"` or end every clause with `"used for"`.

The old template existed for bulk ISO-704 generation; Phase B deprecates it for human-facing text.

### R3 — Structure (within `definition` prose)

One short paragraph, optionally followed by inline markers:

1. **What it is** (genus in plain language)
2. **Why it matters** (one business decision it enables)
3. **Example**: concrete instance
4. **Not**: common confusion to exclude

Use `cnNote` for the Chinese equivalent with the same four beats — not a literal translation of opaque engineering terms.

### R4 — Separate engineering vocabulary

Keep in `module.binding.yaml` or profile definitions, **not** core:

- `sourceArtifactDigest`, `*ContractRef`, `toolLock`, `implementationDigest`
- "execution-and-reproducibility profile"
- "logical key", "ExactVersionReference" (unless defining an identity concept)

Core may say: "Links to the custodian feed that supplied this snapshot" instead of naming six contract digest fields.

### R5 — Module header

`module.definition` = business scope in ≤3 sentences.  
`module.cnNote` = same for Chinese readers.  
Profile/binding scope belongs in fragment file headers, not the core module blurb.

### R6 — Relations and roles

Relation `definition`: who participates and what business fact is being asserted.

❌ `Offered Security, is a relation that links a SecurityOffering version to the exact Security version it offers, used to specify…`  
✅ `Links a securities offering to the specific share class being offered.`

### R7 — Review checklist (SME)

Reviewer paraphrases without reading IRI paths. Pass if:

- [ ] Can name a real-world example
- [ ] Can state what is **not** this concept
- [ ] Does not need to ask what "authority-scoped logical identity" means

## Examples (fin-instruments pilot)

### FinancialInstrument

```yaml
definition: >-
  A tradable financial contract—such as a stock, bond, or fund share—identified independently of where it is listed.
  Example: Apple common stock identified by ISIN. Not: a price quote, an order, or a custody balance.
cnNote: >-
  可独立识别的可交易金融合约（如股票、债券、基金份额）；不等同于报价、订单或托管余额。
```

### InstrumentListing

```yaml
definition: >-
  The fact that an instrument trades on a specific venue under that venue's listing identifier (e.g. ticker + MIC).
  Example: A-share listed on SSE with local code. Not: the instrument itself or a historical price.
cnNote: >-
  某金融工具在特定交易场所挂牌、并使用该场所上市代码的事实；不是工具本身，也不是历史价格。
```

## Enforcement

- Phase B migrated modules: `validate-m2-core` advisory lint (future) flags `" is a "` template openings in `module.core.yaml`.
- RFC-001 Axis 6 SME paraphrase gate (manual).
- Terminology sync (`sync-terminology-sidecars.cjs`) preserves rich cards when IRI matches; core rewrite flows to cards on next sync.
