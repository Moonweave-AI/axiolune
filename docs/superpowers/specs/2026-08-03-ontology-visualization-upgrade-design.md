# Ontology Visualization Upgrade Design

**Date:** 2026-08-03  
**Status:** Approved for planning  
**Scope:** `visualization/` (generator + embedded UI)  
**Engine:** Keep vis-network (CDN); no ontology source / validator changes

## Problem

The current ontology graph (`visualization/generate.cjs` → `index.html` / `data.json`) renders ~1171 nodes and ~4660 edges. Roughly half of nodes are **AttributeType** (663) plus **patternAttr** (38) and **RelationType** (97). Attributes and cross-cutting pattern fields (e.g. Valid From, Derived From) appear as peer nodes; relation types also occupy node slots even though domain→range edges already exist. Weak edges (`moduleOf`, `valueType`, faint dashed links) make many nodes look isolated. The UI (dark navy + uniform light-blue capsules) reads as a default force-graph demo rather than a structured ontology explorer.

## Goals

1. **Correct placement by meaning** — every ontology fact remains visible, but only in the slot that matches its kind (node / edge / sidebar / catalog).
2. **No information loss** — completeness is mandatory; decluttering must relocate, never drop.
3. **Semantic + UI upgrade together (S1)** — reproject the graph and refresh layout, chrome, and panels in one pass.
4. **Stay on vis-network** — upgrade `generate.cjs` HTML template and data projection; do not switch engines this round.

## Non-goals

- Changing `ontology/**`, M2/M3 validators, or SHACL/OWL generators
- Replacing vis-network with Cytoscape/Sigma/etc.
- Multi-page app, auth, write-back editing, or server API
- Fabricating validation results beyond regenerating viz artifacts

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Attributes / patternAttr | Fold into host true-node sidebar (`attrs[]`) |
| RelationType default | Edge label on domain→range (`relation` edges) — A1 |
| Scope | Semantic projection + UI refresh — S1 |
| Approach | Projection layer in generator — Approach 1 |
| Completeness | All information presented; position must match meaning |

## Architecture

### Approach 1 — Visualization projection layer

```
YAML (M3/M2) → collect full internal model → project for canvas → data.json + index.html
```

1. **Collect** (as today): register IRIs, modules, objects, associations, relations, attributes, patterns, fields, edges.
2. **Project** (new): emit canvas nodes/edges for structure only; attach relocated content onto host payloads; keep relation definitions available for sidebar and optional Full mode.
3. **Render**: refreshed vis-network UI reads projected graph + host-attached catalogs.

`data.meta.projection` must be `"structural-v2"` with honesty counts:

- `canvasNodes`, `canvasEdges`
- `foldedAttributes`, `foldedPatternAttrs`
- `relationEdges`, `relationDefs`
- `orphanAttributes` (must be 0 or explicitly listed)

## Graph semantics (placement contract)

### Canvas nodes (true nodes)

| Kind | Role |
|------|------|
| `module` | Ontology module hubs |
| `metatype` | M3 type definitions |
| `pattern` | Cross-domain patterns |
| `object` | M2 object types |
| `association` | M2 n-ary association types |
| `identifier` | Identifier types |
| `codelist` | Enumerations |
| `primitive` | Scalar value types (weak visual weight) |

### Not canvas nodes (relocated)

| Kind | Placement |
|------|-----------|
| `attribute` / AttributeType | Host `attrs[]` on Object/Association (and any other users via `attributeUses`); full def in sidebar |
| `patternAttr` | Host `attrs[]` via pattern inject/applies; tag `source: pattern` + pattern IRI |
| `relation` / RelationType | Default: `relation` edge domain→range with label = relation name; full def in `relationDefs` and on endpoint sidebars |
| `constraint` | Sidebar / legend notes (not peer graph nodes) |

### Canvas edges

| Type | Meaning | Default visibility |
|------|---------|-------------------|
| `subClassOf` | Inheritance | On |
| `relation` | M2 RelationType as domain→range | On (primary home for relations) |
| `participant` | Association ↔ participant range | On |
| `pattern` | Pattern applied to type | On |
| `import` | Module dependency | On |
| `fieldType` | M3 field → other metatype | On (structural) |
| `appliesTo` / `injects` / `dependsOn` / `conflicts` / `inverseOf` | Pattern/meta structure | On when present |
| `moduleOf` | Membership | Off by default (noise) |
| `valueType` | Attribute → primitive | Off on canvas; shown in attr rows |
| `attribute` | Type → AttributeType node | Removed from canvas (replaced by `attrs[]`) |
| `domainOf` / `rangeOf` | Relation hub spokes | Removed when relation is an edge |

### Sidebar (click true node) — complete for that host

- Definition, IRI, kind, module, props
- **Attributes**: name, valueType, required/cardinality, pattern source, IRI
- **Relations**: outgoing/incoming relation edges (name → counterpart); link to `relationDefs` detail
- **Participants** (associations)
- **Fields** (M3 metatypes)
- Patterns applied / injected

### Search & catalog (completeness without wrong slots)

- Search matches labels, IRIs, attribute names, relation names, field names.
- Hit on attribute/relation → focus **host true node** and highlight the matching sidebar row (do not spawn attribute nodes).
- Optional module catalog list: all types browsable without placing folded kinds on the canvas.

### Density presets

| Preset | Canvas |
|--------|--------|
| **Standard (default)** | True nodes + structural edges; Identifier/CodeList on; Primitive weak; relations as edges; attrs in sidebar |
| **Structural** | Subset: modules, metatypes, patterns, objects, associations, primitives; fewer secondary kinds |
| **Full** | Same completeness as Standard **plus** optional RelationType-as-node for debug/compare — not the only way to see relation data |

## UI / layout

- Keep module cluster layout; tighten springs for structural edges; exclude or heavily damp hidden/weak edges from physics so nodes do not starfield.
- Auto-freeze after stabilization; retain Freeze / Stabilize / Fit.
- Visual vocabulary (distinct, not uniform capsules):
  - Module: large dark box
  - Object: rounded rect in module color
  - Association: hexagon / cut corner with stronger border
  - Pattern: star / badge
  - Metatype: indigo box family
  - Identifier / CodeList: smaller secondary
  - Primitive: small dots; labels on zoom
  - `relation` edges: solid + label; `subClassOf` thicker; `participant` accent; `pattern` dashed
- Refresh topbar, legend, side panel chrome (typography, hierarchy, contrast). Avoid generic purple-glow / cream-serif clichés; stay on a coherent dark ontology-tool palette with clear kind colors already used for M2 modules.

## Implementation boundary

**Touch**

- `visualization/generate.cjs` (collection may stay; add project step; rewrite `HTML_TEMPLATE`)
- Regenerated `visualization/data.json`, `visualization/index.html`

**Do not touch**

- `ontology/**`, `scripts/meta/**`, `scripts/domain/**` (except optionally documenting how to regenerate viz)

## Acceptance

1. `node visualization/generate.cjs` exits 0 and writes both artifacts.
2. Default Standard canvas node count ≪ current 1171; zero `attribute` / `patternAttr` canvas nodes; zero `relation` canvas nodes unless Full enabled.
3. Every collected AttributeType appears in at least one host `attrs[]` **or** is counted in `orphanAttributes` with list (target: 0 orphans).
4. Every RelationType with resolvable domain+range yields ≥1 `relation` edge; defs retained for sidebar.
5. Clicking an Object/Association shows all its attributes and related relations in the side panel.
6. Search for a known attribute name (e.g. pattern field label) focuses a host node and surfaces the attr in UI.
7. Visual check: Standard view is clustered by module, not a field of disconnected ovals; relation names appear on edges, not as peer capsules.

## Testing

- Generator smoke: run generate; assert `meta.projection === "structural-v2"` and orphan count.
- Optional small Node assert script later (out of band): compare folded attr count + relation edge count to pre-projection stats.
- Manual browser pass on Standard / Structural / Full.

## Open points for implementation plan (not blocking design)

- Exact shape of `attrs[]` / `relationDefs` JSON fields
- Whether unused AttributeTypes (never referenced by `attributeUses`) attach to declaring module sidebar vs orphan list
- Local vis-network vendor copy vs CDN-only (keep CDN unless offline becomes a requirement)
