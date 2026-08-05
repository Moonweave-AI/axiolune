#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const META_DIR = path.join(ROOT, 'ontology', 'meta');
const DOMAIN_DIR = path.join(ROOT, 'fibo-ontology');
const OUT_DIR = __dirname;
const FIBO_MODE = true;

const META_FILES = [
  { file: 'core-meta-model.yaml', key: 'core', sectionHint: 'MetaModel', group: 'm3-core', layer: 1 },
  { file: 'cross-domain-patterns.yaml', key: 'patterns', sectionHint: 'CrossDomainPatterns', group: 'm3-patterns', layer: 2 },
  { file: 'behavior-meta-model.yaml', key: 'behavior', sectionHint: 'PlatformBehavior', group: 'm3-behavior', layer: 3 },
  { file: 'data-binding-meta-model.yaml', key: 'binding', sectionHint: 'DataBinding', group: 'm3-binding', layer: 4 }
];

const M2_MODULE_COLORS = {
  ACTUS: '#6366f1',
  BE: '#0ea5e9',
  BP: '#14b8a6',
  CAE: '#22c55e',
  DER: '#eab308',
  EXMP: '#f97316',
  FBC: '#ef4444',
  FND: '#8b5cf6',
  IND: '#ec4899',
  LOAN: '#06b6d4',
  MD: '#84cc16',
  SEC: '#3b82f6',
  etc: '#64748b',
  root: '#475569'
};

const M3_GROUP_COLORS = {
  'm3-core': '#6366f1',
  'm3-patterns': '#8b5cf6',
  'm3-behavior': '#3b82f6',
  'm3-binding': '#06b6d4',
  'm3-constraint': '#f59e0b',
  'module': '#64748b',
  'primitive': '#94a3b8'
};

const PRIMITIVE_BASE = ['string', 'integer', 'decimal', 'boolean', 'date', 'instant', 'duration', 'uri', 'any', 'digest'];
const XSD_MAP = {
  'xsd:string': 'string', 'xsd:integer': 'integer', 'xsd:decimal': 'decimal',
  'xsd:boolean': 'boolean', 'xsd:date': 'date', 'xsd:dateTime': 'instant',
  'xsd:duration': 'duration', 'xsd:anyURI': 'uri', 'xsd:int': 'integer',
  'xsd:nonNegativeInteger': 'integer', 'xsd:positiveInteger': 'integer'
};
const SCALAR_ALIAS = {
  'asciidentifier': 'string', 'nfcstring': 'string', 'semver': 'string',
  'posixrelativepath': 'string', 'canonicalntriplesterm': 'string',
  'datetime': 'instant', 'iri': 'uri'
};

const SCALAR_SECTION_META = new Set(['version', 'description', 'layer', 'changes', 'note', 'notes', 'purpose', 'curiePrefixes', 'label', 'definition', 'validationRules', 'ValidationRules', 'Notes']);

const nodes = new Map();
const edges = new Map();
const iriMap = new Map();
const moduleNameMap = new Map();
const schemaNameMap = new Map();
const classIriMap = new Map();
const moduleMap = new Map();
const primitiveCreated = new Set();
const stats = { m3Schema: 0, m3Pattern: 0, m3PatternAttr: 0, m3Constraint: 0, m2Object: 0, m2Association: 0, m2Relation: 0, m2Attribute: 0, m2Identifier: 0, m2Codelist: 0, modules: 0, primitives: 0 };

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function isArr(v) { return Array.isArray(v); }
function shortIri(iri) { if (!iri) return ''; const i = String(iri); const slash = i.lastIndexOf('/'); const hash = i.lastIndexOf('#'); const cut = Math.max(slash, hash); return cut >= 0 ? i.slice(cut + 1) : i; }
function str(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'number' || typeof v === 'boolean') return String(v); if (Array.isArray(v)) return v.map(str).join(', '); if (typeof v === 'object') return JSON.stringify(v); return String(v); }
function clamp(s, n) { s = str(s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

const PRIMITIVE_CN = {
  string: '字符串原语类型，表示一段 Unicode 文本，映射到 xsd:string，是本体中最基本的字面值承载形式。',
  integer: '整数原语类型，表示无小数部分的数值，映射到 xsd:integer，用于计数、序号等离散量。',
  decimal: '十进制小数原语类型，表示可带小数的精确数值，映射到 xsd:decimal，是金融金额计算的底层数值形式。',
  boolean: '布尔原语类型，表示真或假两个值，映射到 xsd:boolean，用于逻辑判断与状态开关。',
  date: '日期原语类型，表示日历日期（不含时刻），映射到 xsd:date，用于只关心日期不关心时间的场景。',
  instant: '时刻原语类型，表示时间线上的一个精确瞬间，映射到 xsd:dateTime，是本体中时间戳的标准承载形式。',
  duration: '时长原语类型，表示一段时间长度，映射到 xsd:duration，用于表示间隔、有效期等时间跨度。',
  uri: 'URI 原语类型，表示统一资源标识符，映射到 xsd:anyURI，用于引用其他本体资源或外部标识。',
  any: '通配原语类型，表示任意类型的值，用于变换定义中不限定类型的输入或输出。',
  digest: '摘要原语类型，表示密码学哈希值字符串（如 sha256:…），用于工件完整性与防篡改校验。'
};
function ensurePrimitive(name) {
  const id = 'prim:' + name;
  if (!primitiveCreated.has(id)) {
    primitiveCreated.add(id);
    nodes.set(id, {
      id, label: name, group: 'primitive', shape: 'dot', kind: 'primitive',
      layer: 'Primitive', module: '', iri: '', size: 8,
      title: 'Primitive value type: ' + name,
      props: { kind: 'primitive value type', valueType: name, cnNote: PRIMITIVE_CN[name] || '' },
      cluster: 'prim'
    });
    stats.primitives++;
  }
  return id;
}

function mapPrimitive(vt) {
  if (vt == null) return null;
  const s = String(vt).trim();
  if (PRIMITIVE_BASE.includes(s)) return s;
  if (XSD_MAP[s]) return XSD_MAP[s];
  const low = s.toLowerCase();
  if (SCALAR_ALIAS[low]) return SCALAR_ALIAS[low];
  if (low === 'nonnegativesafeinteger') return 'integer';
  return null;
}

function addNode(id, data) {
  if (!nodes.has(id)) nodes.set(id, Object.assign({ id, props: {}, fields: [] }, data));
  return nodes.get(id);
}

function addEdge(from, to, type, label) {
  if (!from || !to) return;
  const key = from + '\u0001' + to + '\u0001' + type + '\u0001' + (label || '');
  if (edges.has(key)) return;
  edges.set(key, { id: 'e' + edges.size, from, to, type, label: label || '' });
}

function resolveIri(iri) { return iri ? iriMap.get(String(iri)) : null; }
function resolveSchemaName(name) { return schemaNameMap.get(String(name)); }

function isSchemaTypeDef(def) {
  if (!isObj(def)) return false;
  return isObj(def.requiredFields) || isObj(def.optionalFields) || isObj(def.fields) || isArr(def.builtinTypes) || isObj(def.structure) || isObj(def.variants) || (isObj(def.owlProjection) && (def.owlProjection.kind || def.owlProjection.classIri));
}

function fieldSpecRefs(typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return [];
  const matches = typeStr.match(/[A-Z][a-zA-Z0-9]+/g) || [];
  return matches;
}

function fieldTypeEdgesFrom(nodeId, fname, typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return;
  const tokens = String(typeStr).split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const seen = new Set();
  for (const tok of tokens) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    const p = mapPrimitive(tok);
    if (p) addEdge(nodeId, ensurePrimitive(p), 'valueType', fname);
    const s = resolveSchemaName(tok);
    if (s) addEdge(nodeId, s, 'fieldType', fname);
  }
}

function collectSchemaFields(node, def) {
  const fields = [];
  for (const bucket of ['requiredFields', 'optionalFields', 'fields']) {
    const b = def[bucket];
    if (isObj(b)) {
      for (const [fname, spec] of Object.entries(b)) {
        if (!isObj(spec)) continue;
        const req = bucket === 'requiredFields' ? true : (spec.required === true);
        fields.push({ name: fname, type: str(spec.type) || (isArr(spec.type) ? 'list' : ''), required: req, description: clamp(spec.description, 160) });
        fieldTypeEdgesFrom(node.id, fname, spec.type);
        if (isObj(spec.defaultCardinality)) {
          for (const sub of Object.values(spec.defaultCardinality)) {
            if (isObj(sub) && sub.type) { const p = mapPrimitive(sub.type); if (p) addEdge(node.id, ensurePrimitive(p), 'valueType', fname); }
          }
        }
      }
    }
  }
  if (isObj(def.structure)) {
    for (const [fname, spec] of Object.entries(def.structure)) {
      if (!isObj(spec)) continue;
      fields.push({ name: fname, type: str(spec.type), required: spec.required === true, description: clamp(spec.description, 160) });
      fieldTypeEdgesFrom(node.id, fname, spec.type);
    }
  }
  if (isObj(def.variants)) {
    for (const [vname, vdef] of Object.entries(def.variants)) {
      if (!isObj(vdef)) continue;
      const vb = vdef.requiredFields || vdef.optionalFields || vdef.fields;
      if (!isObj(vb)) continue;
      for (const [fname, spec] of Object.entries(vb)) {
        if (!isObj(spec)) continue;
        const req = vdef.requiredFields ? true : (spec.required === true);
        fields.push({ name: vname + '.' + fname, type: str(spec.type), required: req, description: clamp(spec.description, 160) });
        fieldTypeEdgesFrom(node.id, vname + '.' + fname, spec.type);
      }
    }
  }
  if (isObj(def.owlProjection)) {
    if (typeof def.owlProjection.classIri === 'string') classIriMap.set(def.owlProjection.classIri, node.id);
    if (isArr(def.owlProjection.properties)) {
      for (const prop of def.owlProjection.properties) {
        if (!isObj(prop)) continue;
        const p = mapPrimitive(prop.range);
        if (p) addEdge(node.id, ensurePrimitive(p), 'valueType', shortIri(prop.predicateIri) || 'property');
      }
    }
    let domTarget = null, rangeTarget = null;
    if (def.owlProjection.domain) {
      domTarget = resolveIri(def.owlProjection.domain) || classIriMap.get(def.owlProjection.domain);
      if (domTarget) addEdge(node.id, domTarget, 'domainOf', 'domain');
    }
    if (def.owlProjection.range) {
      rangeTarget = resolveIri(def.owlProjection.range) || classIriMap.get(def.owlProjection.range);
      if (rangeTarget) addEdge(node.id, rangeTarget, 'rangeOf', 'range');
    }
    // For objectProperty meta-types (e.g., versionOf, supersedes), also emit a
    // 'relation' edge domain→range so the connection survives folding (domainOf/
    // rangeOf are dropped in projectStructuralV2) and the node is not isolated.
    if (def.owlProjection.kind === 'objectProperty' && domTarget && rangeTarget) {
      addEdge(domTarget, rangeTarget, 'relation', node.label || 'relation');
    }
  }
  if (isArr(def.builtinTypes)) {
    for (const bt of def.builtinTypes) {
      if (!isObj(bt)) continue;
      const p = mapPrimitive(bt.id) || mapPrimitive(bt.owlMapping);
      if (p) addEdge(node.id, ensurePrimitive(p), 'valueType', bt.id);
    }
  }
  node.fields = fields;
  if (node.props) node.props.fieldCount = String(fields.length);
}

const LAYER_KIND = { 1: 'mt-core', 2: 'mt-pattern', 3: 'mt-behavior', 4: 'mt-binding' };
const LAYER_SHAPE = { 1: 'box', 2: 'diamond', 3: 'hex', 4: 'parallelogram' };
function buildSchemaNode(id, name, def, ctx) {
  const layerKind = LAYER_KIND[ctx.layer] || 'metatype';
  const node = addNode(id, {
    label: name,
    group: ctx.group,
    shape: LAYER_SHAPE[ctx.layer] || 'box',
    kind: layerKind,
    layer: 'M3 (Layer ' + ctx.layer + ')',
    module: ctx.moduleLabel,
    iri: str(def.iri) || '',
    title: clamp(str(def.definition), 220),
    cluster: ctx.cluster
  });
  node.props = {
    kind: 'M3 meta-type definition (Layer ' + ctx.layer + ')',
    section: ctx.sectionName,
    layer: 'Layer ' + ctx.layer,
    module: ctx.moduleLabel,
    definition: clamp(str(def.definition), 400),
    cnNote: clamp(str(def.cnNote), 400),
    purpose: clamp(str(def.purpose), 300),
    note: clamp(str(def.note), 300),
    owlProjection: str(def.owlProjection && def.owlProjection.kind),
    stereotype: str(def.owlProjection && def.owlProjection.stereotype),
    fieldCount: String(node.fields.length)
  };
  stats.m3Schema++;
  return node;
}

function buildPatternInstanceNode(def, ctx) {
  const iri = String(def.iri);
  const id = 'iri:' + iri;
  const node = addNode(id, {
    label: str(def.label) || shortIri(iri),
    group: ctx.group,
    shape: 'star',
    kind: 'pattern',
    layer: 'M3 (Layer ' + ctx.layer + ')',
    module: ctx.moduleLabel,
    iri: iri,
    size: 22,
    title: clamp(str(def.definition), 220),
    cluster: ctx.cluster
  });
  iriMap.set(iri, id);
  node.props = {
    kind: 'cross-domain pattern',
    iri: iri,
    label: str(def.label),
    definition: clamp(str(def.definition), 500),
    cnNote: clamp(str(def.cnNote), 400),
    version: str(def.version),
    appliesTo: isArr(def.appliesTo) ? def.appliesTo.map(str).join(', ') : str(def.appliesTo),
    parameters: isArr(def.parameters) ? def.parameters.map(p => str(p && p.name) + (p && p.defaultValue != null ? '=' + str(p.defaultValue) : '')).join(', ') : '',
    note: clamp(str(def.note), 300)
  };
  stats.m3Pattern++;
  return node;
}

function buildPatternAttrNode(name, def, ctx) {
  const iri = def.iri ? String(def.iri) : ('attr:' + ctx.key + ':' + name);
  const id = 'iri:' + iri;
  const node = addNode(id, {
    label: str(def.label) || name,
    group: ctx.group,
    shape: 'dot',
    kind: 'patternAttr',
    layer: 'M3 (Layer ' + ctx.layer + ')',
    module: ctx.moduleLabel,
    iri: iri,
    size: 14,
    title: clamp(str(def.definition), 200),
    cluster: ctx.cluster
  });
  iriMap.set(iri, id);
  const dc = def.defaultCardinality || {};
  node.props = {
    kind: 'pattern attribute',
    iri: iri,
    label: str(def.label),
    definition: clamp(str(def.definition), 400),
    valueType: str(def.valueType),
    owlProjection: str(def.owlProjectionOverride),
    cardinality: str((dc.minCount != null ? dc.minCount : '') + '..' + (dc.maxCount != null ? dc.maxCount : '*')),
    pattern: str(def.pattern),
    note: clamp(str(def.note), 260)
  };
  const p = mapPrimitive(def.valueType);
  if (p) addEdge(node.id, ensurePrimitive(p), 'valueType', 'valueType');
  stats.m3PatternAttr++;
  return node;
}

function buildConstraintNode(def, ctx) {
  const iri = def.iri ? String(def.iri) : ('constraint:' + ctx.key + ':' + (def.localName || def.label));
  const id = 'iri:' + iri;
  const node = addNode(id, {
    label: str(def.label) || shortIri(iri),
    group: 'm3-constraint',
    shape: 'dot',
    kind: 'constraint',
    layer: 'M3 (Layer ' + ctx.layer + ')',
    module: ctx.moduleLabel,
    iri: iri,
    size: 13,
    title: clamp(str(def.definition), 200),
    cluster: ctx.cluster
  });
  iriMap.set(iri, id);
  node.props = {
    kind: 'constraint definition',
    iri: iri,
    label: str(def.label),
    definition: clamp(str(def.definition), 400),
    constraintType: str(def.constraintType),
    scope: str(def.scope),
    severity: str(def.severity),
    message: clamp(str(def.message), 200)
  };
  stats.m3Constraint++;
  return node;
}

function patternInstanceEdges(def, nodeId) {
  if (isArr(def.appliesTo)) {
    for (const a of def.appliesTo) {
      const t = resolveSchemaName(a);
      if (t) addEdge(nodeId, t, 'appliesTo', 'appliesTo');
    }
  }
  if (isArr(def.dependencies)) for (const d of def.dependencies) { const t = resolveIri(d); if (t) addEdge(nodeId, t, 'dependsOn', 'dependsOn'); }
  if (isArr(def.conflicts)) for (const d of def.conflicts) { const t = resolveIri(d); if (t) addEdge(nodeId, t, 'conflicts', 'conflicts'); }
  if (isArr(def.injectedAttributes)) {
    for (const inj of def.injectedAttributes) {
      if (!isObj(inj)) continue;
      const t = resolveIri(inj.attribute);
      if (t) addEdge(nodeId, t, 'injects', str(inj.label) || 'injects');
    }
  }
  if (isArr(def.constraintsAdded)) {
    for (const c of def.constraintsAdded) {
      if (!isObj(c)) continue;
      const ref = resolveIri(c.constraintRef);
      if (ref) addEdge(nodeId, ref, 'constrains', 'constrains');
      const tgt = resolveIri(c.targetElement);
      if (tgt) addEdge(nodeId, tgt, 'targets', 'targets');
    }
  }
}

function constraintEdges(def, nodeId) {
  if (def.targetElement) { const t = resolveIri(def.targetElement); if (t) addEdge(nodeId, t, 'targets', 'targets'); }
  if (isArr(def.dependencies)) for (const d of def.dependencies) { const t = resolveIri(d); if (t) addEdge(nodeId, t, 'dependsOn', 'dependsOn'); }
}

function processMetaFile(meta) {
  const p = path.join(META_DIR, meta.file);
  const doc = yaml.load(fs.readFileSync(p, 'utf8'));
  if (!isObj(doc)) return;
  const modDef = doc.module || {};
  const moduleIri = str(modDef.moduleIri);
  const moduleLabel = str(modDef.preferredPrefix) || meta.key;
  moduleNameMap[meta.key] = moduleLabel;
  const moduleId = 'mod:' + (moduleIri || meta.key);
  const moduleNode = addNode(moduleId, {
    label: moduleLabel,
    group: 'module',
    shape: 'box',
    kind: 'module',
    layer: 'M3 (Layer ' + meta.layer + ')',
    module: moduleLabel,
    iri: moduleIri,
    size: 26,
    title: 'M3 module: ' + moduleLabel + ' (Layer ' + meta.layer + ')',
    cluster: moduleId
  });
  moduleMap.set(moduleIri, moduleId);
  moduleNode.props = {
    kind: 'ontology module',
    iri: moduleIri,
    baseIri: str(modDef.baseIri),
    preferredPrefix: moduleLabel,
    version: str(modDef.version),
    label: str(modDef.label),
    definition: clamp(str(modDef.definition), 400),
    cnNote: clamp(str(modDef.cnNote), 400),
    status: str(modDef.status),
    imports: isArr(modDef.imports) ? modDef.imports.map(i => str(i.moduleIri)).join(', ') : ''
  };
  stats.modules++;

  const sectionName = Object.keys(doc).find(k => k !== 'module' && isObj(doc[k]) && !SCALAR_SECTION_META.has(k));
  const section = sectionName ? doc[sectionName] : null;
  if (!isObj(section)) return;
  const ctx = { key: meta.key, group: meta.group, layer: meta.layer, sectionName: sectionName || meta.sectionHint, moduleLabel, cluster: moduleId };

  if (section.version != null || section.layer != null || section.description != null) {
    moduleNode.props.sectionName = sectionName;
    moduleNode.props.sectionVersion = str(section.version);
    moduleNode.props.sectionLayer = str(section.layer);
    moduleNode.props.sectionDescription = clamp(str(section.description), 400);
  }

  for (const [name, def] of Object.entries(section)) {
    if (SCALAR_SECTION_META.has(name)) continue;
    if (isArr(def)) {
      for (const item of def) {
        if (!isObj(item)) continue;
        if (typeof item.iri === 'string' && isArr(item.appliesTo)) {
          const node = buildPatternInstanceNode(item, ctx);
          patternInstanceEdges(item, node.id);
        } else if (typeof item.iri === 'string' && (item.constraintType || item.scope || item.expression)) {
          const node = buildConstraintNode(item, ctx);
          constraintEdges(item, node.id);
        } else if (typeof item.iri === 'string') {
          buildPatternInstanceNode(item, ctx);
        }
      }
      continue;
    }
    if (!isObj(def)) continue;
    if (isSchemaTypeDef(def)) {
      const id = 'm3:' + meta.key + ':' + name;
      if (!schemaNameMap.has(name)) schemaNameMap.set(name, id);
      const node = buildSchemaNode(id, name, def, ctx);
      collectSchemaFields(node, def);
    } else if (typeof def.iri === 'string' && (typeof def.valueType === 'string' || def.owlProjectionOverride || def.defaultCardinality)) {
      buildPatternAttrNode(name, def, ctx);
    } else if (typeof def.iri === 'string' && (def.constraintType || def.scope)) {
      const node = buildConstraintNode(def, ctx);
      constraintEdges(def, node.id);
    } else if (typeof def.iri === 'string') {
      buildPatternInstanceNode(def, ctx);
    }
  }

  if (isArr(modDef.imports)) {
    for (const imp of modDef.imports) {
      if (!isObj(imp)) continue;
      const t = moduleMap.get(str(imp.moduleIri));
      if (t) addEdge(moduleId, t, 'import', 'imports');
    }
  }
}

function fiboDomainKey(dirName, modDef) {
  if (modDef && modDef.fiboDomain) return String(modDef.fiboDomain);
  const top = String(dirName || '').split('/')[0];
  return top || 'root';
}

function findModuleYamlFiles(baseDir) {
  const out = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name === 'module.yaml' || name.endsWith('.module.yaml')) {
        out.push({
          dirName: path.relative(baseDir, path.dirname(full)).replace(/\\/g, '/'),
          yamlPath: full,
          moduleKey: name === 'module.yaml' ? path.basename(path.dirname(full)) : name.replace(/\.module\.yaml$/, '')
        });
      }
    }
  }
  if (fs.existsSync(baseDir)) walk(baseDir);
  return out.sort((a, b) => (a.dirName + '/' + a.moduleKey).localeCompare(b.dirName + '/' + b.moduleKey));
}

function valueTypeEdgeFrom(fromId, vt) {
  if (!vt || typeof vt !== 'string') return;
  const s = vt.trim();
  if (/^(https?:|urn:)/i.test(s)) {
    const t = resolveIri(s) || classIriMap.get(s);
    if (t) addEdge(fromId, t, 'valueType', 'valueType');
  } else {
    const p = mapPrimitive(s);
    if (p) addEdge(fromId, ensurePrimitive(p), 'valueType', 'valueType');
  }
}

function processDomainModule(dirName, yamlPathOverride) {
  const p = yamlPathOverride || path.join(DOMAIN_DIR, dirName, 'module.yaml');
  if (!fs.existsSync(p)) return;
  const doc = yaml.load(fs.readFileSync(p, 'utf8'));
  if (!isObj(doc)) return;
  const modDef = doc.module || {};
  const moduleIri = str(modDef.moduleIri);
  const moduleLabel = str(modDef.preferredPrefix) || shortIri(moduleIri) || dirName;
  const moduleId = 'mod:' + (moduleIri || dirName);
  const domainKey = fiboDomainKey(dirName, modDef);
  const color = M2_MODULE_COLORS[domainKey] || M2_MODULE_COLORS.root;
  const moduleNode = addNode(moduleId, {
    label: moduleLabel,
    group: 'fibo-' + domainKey,
    shape: 'box',
    kind: 'module',
    layer: 'FIBO',
    module: moduleLabel,
    iri: moduleIri,
    size: 26,
    title: 'FIBO module: ' + moduleLabel,
    cluster: moduleId,
    color: { background: color, border: color, highlight: { background: color, border: '#ffffff' } }
  });
  moduleMap.set(moduleIri, moduleId);
  moduleNode.props = {
    kind: 'ontology module',
    iri: moduleIri,
    baseIri: str(modDef.baseIri),
    preferredPrefix: moduleLabel,
    version: str(modDef.version),
    label: str(modDef.label),
    definition: clamp(str(modDef.definition), 400),
    cnNote: clamp(str(modDef.cnNote), 400),
    status: str(modDef.status),
    fiboDomain: domainKey,
    sourcePath: str(modDef.sourcePath),
    sourceArtifact: str(modDef.sourceArtifact),
    imports: isArr(modDef.imports) ? modDef.imports.map(i => str(i.moduleIri)).join(', ') : ''
  };
  stats.modules++;

  const domain = doc.domain || {};
  const cluster = moduleId;
  const ctx = { moduleLabel, cluster, dirName, color, domainKey };

  function mkNode(iri, kind, shape, label, def) {
    const id = 'iri:' + iri;
    const node = addNode(id, {
      label: label || shortIri(iri),
      group: 'fibo-' + domainKey,
      shape, kind,
      layer: 'FIBO',
      module: moduleLabel,
      iri, size: kind === 'codelist' ? 16 : 18,
      title: clamp(str(def.definition), 200),
      cluster,
      color: { background: color, border: color, highlight: { background: color, border: '#ffffff' } }
    });
    iriMap.set(iri, id);
    return node;
  }

  if (isObj(domain.objectTypes)) {
    for (const [name, def] of Object.entries(domain.objectTypes)) {
      const iri = String(def.iri);
      const node = mkNode(iri, 'object', 'box', str(def.label) || name, def);
      node.props = {
        kind: 'object type',
        iri, label: str(def.label), localName: str(def.localName), namespace: str(def.namespace),
        definition: clamp(str(def.definition), 500),
        cnNote: clamp(str(def.cnNote), 400),
        superTypes: isArr(def.superTypes) ? def.superTypes.map(shortIri).join(', ') : '',
        abstract: str(def.abstract),
        attributeUses: isArr(def.attributeUses) ? String(def.attributeUses.length) : '0',
        patternBindings: isArr(def.patternBindings) ? def.patternBindings.map(pb => shortIri(pb.pattern)).join(', ') : '',
        alignments: isArr(def.alignments) ? String(def.alignments.length) : '0'
      };
      if (isArr(def.superTypes)) for (const s of def.superTypes) { const t = resolveIri(s); if (t) addEdge(node.id, t, 'subClassOf', 'subClassOf'); }
      if (isArr(def.attributeUses)) for (const au of def.attributeUses) { if (!isObj(au)) continue; const t = resolveIri(au.attribute); if (t) addEdge(node.id, t, 'attribute', str(au.label) || 'uses'); }
      if (isArr(def.patternBindings)) for (const pb of def.patternBindings) { const t = resolveIri(pb.pattern); if (t) addEdge(node.id, t, 'pattern', 'pattern'); }
      stats.m2Object++;
    }
  }

  if (isObj(domain.associationTypes)) {
    for (const [name, def] of Object.entries(domain.associationTypes)) {
      const iri = String(def.iri);
      const node = mkNode(iri, 'association', 'hex', str(def.label) || name, def);
      node.props = {
        kind: 'association type (n-ary)',
        iri, label: str(def.label), localName: str(def.localName), namespace: str(def.namespace),
        definition: clamp(str(def.definition), 500),
        cnNote: clamp(str(def.cnNote), 400),
        participantRoles: isArr(def.participantRoles) ? def.participantRoles.map(r => str(r.id) + ':' + shortIri(r.range)).join(', ') : '',
        attributeUses: isArr(def.attributeUses) ? String(def.attributeUses.length) : '0',
        patternBindings: isArr(def.patternBindings) ? def.patternBindings.map(pb => shortIri(pb.pattern)).join(', ') : '',
        alignments: isArr(def.alignments) ? String(def.alignments.length) : '0'
      };
      if (isArr(def.participantRoles)) for (const r of def.participantRoles) { if (!isObj(r)) continue; const t = resolveIri(r.range); if (t) addEdge(node.id, t, 'participant', str(r.id)); }
      if (isArr(def.attributeUses)) for (const au of def.attributeUses) { if (!isObj(au)) continue; const t = resolveIri(au.attribute); if (t) addEdge(node.id, t, 'attribute', str(au.label) || 'uses'); }
      if (isArr(def.patternBindings)) for (const pb of def.patternBindings) { const t = resolveIri(pb.pattern); if (t) addEdge(node.id, t, 'pattern', 'pattern'); }
      stats.m2Association++;
    }
  }

  if (isObj(domain.relationTypes)) {
    for (const [name, def] of Object.entries(domain.relationTypes)) {
      const iri = String(def.iri);
      const node = mkNode(iri, 'relation', 'dot', str(def.label) || name, def);
      node.props = {
        kind: 'relation type (object property)',
        iri, label: str(def.label), localName: str(def.localName), namespace: str(def.namespace),
        definition: clamp(str(def.definition), 500),
        cnNote: clamp(str(def.cnNote), 400),
        domain: shortIri(def.domain), range: shortIri(def.range),
        inverseOf: shortIri(def.inverseOf),
        characteristics: isArr(def.characteristics) ? def.characteristics.map(str).join(', ') : '',
        alignments: isArr(def.alignments) ? String(def.alignments.length) : '0'
      };
      const d = resolveIri(def.domain); const r = resolveIri(def.range);
      if (d && r) addEdge(d, r, 'relation', str(def.label) || name);
      if (d) addEdge(node.id, d, 'domainOf', 'domain');
      if (r) addEdge(node.id, r, 'rangeOf', 'range');
      if (def.inverseOf) { const t = resolveIri(def.inverseOf); if (t) addEdge(node.id, t, 'inverseOf', 'inverseOf'); }
      stats.m2Relation++;
    }
  }

  if (isObj(domain.attributeTypes)) {
    for (const [name, def] of Object.entries(domain.attributeTypes)) {
      const iri = String(def.iri);
      const node = mkNode(iri, 'attribute', 'dot', str(def.label) || name, def);
      const dc = def.defaultCardinality || {};
      node.props = {
        kind: 'attribute type',
        iri, label: str(def.label), localName: str(def.localName), namespace: str(def.namespace),
        definition: clamp(str(def.definition), 500),
        cnNote: clamp(str(def.cnNote), 400),
        valueType: str(def.valueType),
        cardinality: str((dc.minCount != null ? dc.minCount : '') + '..' + (dc.maxCount != null ? dc.maxCount : '*')),
        pattern: str(def.pattern), unit: str(def.unit),
        enumValues: isArr(def.enumValues) ? def.enumValues.map(str).join(', ') : '',
        alignments: isArr(def.alignments) ? String(def.alignments.length) : '0'
      };
      valueTypeEdgeFrom(node.id, def.valueType);
      stats.m2Attribute++;
    }
  }

  if (isObj(domain.identifierTypes)) {
    for (const [name, def] of Object.entries(domain.identifierTypes)) {
      const iri = String(def.iri);
      const node = mkNode(iri, 'identifier', 'tri', str(def.label) || name, def);
      node.props = {
        kind: 'identifier type',
        iri, label: str(def.label), localName: str(def.localName), namespace: str(def.namespace),
        definition: clamp(str(def.definition), 500),
        cnNote: clamp(str(def.cnNote), 400),
        baseType: str(def.baseType), standard: str(def.standard),
        validatorRef: str(def.validatorRef), issuingAuthority: str(def.issuingAuthority),
        alignments: isArr(def.alignments) ? String(def.alignments.length) : '0'
      };
      const p = mapPrimitive(def.baseType); if (p) addEdge(node.id, ensurePrimitive(p), 'valueType', 'baseType');
      stats.m2Identifier++;
    }
  }

  if (isObj(domain.codeLists)) {
    for (const [name, def] of Object.entries(domain.codeLists)) {
      const iri = String(def.iri);
      const node = mkNode(iri, 'codelist', 'dot', str(def.label) || name, def);
      node.props = {
        kind: 'code list (enumeration)',
        iri, label: str(def.label), localName: str(def.localName), namespace: str(def.namespace),
        definition: clamp(str(def.definition), 500),
        cnNote: clamp(str(def.cnNote), 400),
        vocabulary: str(def.vocabulary), version: str(def.version), maintainer: str(def.maintainer),
        sourceEvidenceRef: str(def.sourceEvidenceRef),
        values: isArr(def.values) ? def.values.map(v => str(v.notation) + ' (' + str(v.label) + ')').join(', ') : ''
      };
      stats.m2Codelist++;
    }
  }

  if (isArr(modDef.imports)) {
    for (const imp of modDef.imports) {
      if (!isObj(imp)) continue;
      const t = moduleMap.get(str(imp.moduleIri));
      if (t) addEdge(moduleId, t, 'import', 'imports');
    }
  }
}

function layoutClusters() {
  const clusters = new Map();
  for (const node of nodes.values()) {
    const c = node.cluster || 'misc';
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c).push(node);
  }
  const m3Modules = [];
  const m2Modules = [];
  const others = [];
  for (const [cid, list] of clusters) {
    if (list.some(n => n.kind === 'module')) {
      const mod = list.find(n => n.kind === 'module');
      if (mod && mod.layer && mod.layer.startsWith('M3')) m3Modules.push({ cid, mod, list });
      else if (mod && (mod.layer && (mod.layer.startsWith('M2') || mod.layer === 'FIBO'))) m2Modules.push({ cid, mod, list });
      else others.push({ cid, mod, list });
    } else if (cid === 'prim') {
      others.push({ cid, mod: null, list });
    } else {
      others.push({ cid, mod: null, list });
    }
  }
  m3Modules.sort((a, b) => (a.mod ? String(a.mod.layer).localeCompare(String(b.mod.layer)) : 0));
  m2Modules.sort((a, b) => (a.mod ? (a.mod.label || '').localeCompare(b.mod.label || '') : 0));

  const RING_STEP = 175;
  const RING_R0 = 130;
  function ring(list, cx, cy, startAngle) {
    list.forEach((n, i) => {
      const ringIdx = Math.floor(Math.sqrt(i));
      const itemsInRing = ringIdx === 0 ? 1 : Math.min(2 * ringIdx, list.length - (ringIdx * ringIdx - ringIdx));
      const posInRing = i - (ringIdx * ringIdx);
      const a = startAngle + (posInRing / Math.max(1, itemsInRing)) * 2 * Math.PI + ringIdx * 0.5;
      const r = RING_R0 + ringIdx * RING_STEP;
      n.x = Math.round(cx + r * Math.cos(a));
      n.y = Math.round(cy + r * Math.sin(a));
    });
  }

  const m3Cols = 2, m3CellW = 1900, m3CellH = 1900;
  const m2Cols = 4, m2CellW = 1650, m2CellH = 1750;
  const m3Rows = Math.ceil(m3Modules.length / m3Cols);
  const m2Rows = Math.ceil(m2Modules.length / m2Cols);
  const m3OriginY = 0;
  const m2OriginY = m3Rows * m3CellH + 700;

  m3Modules.forEach((entry, i) => {
    const col = i % m3Cols;
    const row = Math.floor(i / m3Cols);
    const cx = (col - (m3Cols - 1) / 2) * m3CellW;
    const cy = m3OriginY + row * m3CellH;
    const members = entry.list.filter(n => n.kind !== 'module');
    ring(members, cx, cy, 0);
    if (entry.mod) { entry.mod.x = cx; entry.mod.y = cy; }
  });

  m2Modules.forEach((entry, i) => {
    const col = i % m2Cols;
    const row = Math.floor(i / m2Cols);
    const cx = (col - (m2Cols - 1) / 2) * m2CellW;
    const cy = m2OriginY + row * m2CellH;
    const members = entry.list.filter(n => n.kind !== 'module');
    ring(members, cx, cy, Math.PI / 4);
    if (entry.mod) { entry.mod.x = cx; entry.mod.y = cy; }
  });

  const prim = others.find(e => e.cid === 'prim');
  if (prim) {
    const cx = (m2Cols / 2) * m2CellW;
    const cy = m2OriginY + m2Rows * m2CellH + 400;
    prim.list.forEach((n, i) => {
      const a = i * (2 * Math.PI / Math.max(1, prim.list.length));
      n.x = Math.round(cx + 220 * Math.cos(a));
      n.y = Math.round(cy + 220 * Math.sin(a));
    });
  }
}

function collectRegistrations() {
  if (!FIBO_MODE) {
    for (const meta of META_FILES) {
      const doc = yaml.load(fs.readFileSync(path.join(META_DIR, meta.file), 'utf8'));
      if (!isObj(doc)) continue;
      const modDef = doc.module || {};
      const moduleIri = str(modDef.moduleIri);
      moduleMap.set(moduleIri, 'mod:' + (moduleIri || meta.key));
      const sectionName = Object.keys(doc).find(k => k !== 'module' && isObj(doc[k]) && !SCALAR_SECTION_META.has(k));
      const section = sectionName ? doc[sectionName] : null;
      if (!isObj(section)) continue;
      for (const [name, def] of Object.entries(section)) {
        if (SCALAR_SECTION_META.has(name)) continue;
        if (isArr(def)) {
          for (const item of def) { if (isObj(item) && typeof item.iri === 'string') iriMap.set(String(item.iri), 'iri:' + String(item.iri)); }
          continue;
        }
        if (!isObj(def)) continue;
        if (isSchemaTypeDef(def)) {
          const id = 'm3:' + meta.key + ':' + name;
          if (!schemaNameMap.has(name)) schemaNameMap.set(name, id);
          if (isObj(def.owlProjection) && typeof def.owlProjection.classIri === 'string') classIriMap.set(def.owlProjection.classIri, id);
          if (typeof def.iri === 'string') iriMap.set(String(def.iri), id);
        } else if (typeof def.iri === 'string') {
          iriMap.set(String(def.iri), 'iri:' + String(def.iri));
        }
      }
    }
    const dirs = fs.readdirSync(DOMAIN_DIR).filter(d => {
      const dp = path.join(DOMAIN_DIR, d);
      return fs.statSync(dp).isDirectory() && d !== 'archive' && d !== 'registry' && fs.existsSync(path.join(dp, 'module.yaml'));
    });
    for (const d of dirs) {
      const doc = yaml.load(fs.readFileSync(path.join(DOMAIN_DIR, d, 'module.yaml'), 'utf8'));
      if (!isObj(doc)) continue;
      const modDef = doc.module || {};
      moduleMap.set(str(modDef.moduleIri), 'mod:' + (str(modDef.moduleIri) || d));
      const domain = doc.domain || {};
      for (const coll of ['objectTypes', 'associationTypes', 'relationTypes', 'attributeTypes', 'identifierTypes', 'codeLists']) {
        if (isObj(domain[coll])) {
          for (const [, def] of Object.entries(domain[coll])) {
            if (isObj(def) && typeof def.iri === 'string') iriMap.set(String(def.iri), 'iri:' + String(def.iri));
          }
        }
      }
    }
    return;
  }

  for (const entry of findModuleYamlFiles(DOMAIN_DIR)) {
    const doc = yaml.load(fs.readFileSync(entry.yamlPath, 'utf8'));
    if (!isObj(doc)) continue;
    const modDef = doc.module || {};
    moduleMap.set(str(modDef.moduleIri), 'mod:' + (str(modDef.moduleIri) || entry.dirName));
    const domain = doc.domain || {};
    for (const coll of ['objectTypes', 'associationTypes', 'relationTypes', 'attributeTypes', 'identifierTypes', 'codeLists']) {
      if (isObj(domain[coll])) {
        for (const [, def] of Object.entries(domain[coll])) {
          if (isObj(def) && typeof def.iri === 'string') iriMap.set(String(def.iri), 'iri:' + String(def.iri));
        }
      }
    }
  }
}

const FOLD_KINDS = new Set(['attribute', 'patternAttr', 'relation', 'constraint']);
const DROP_EDGE_TYPES = new Set(['attribute', 'injects', 'constrains']);

function ensureHostBags(n) {
  if (!n.attrs) n.attrs = [];
  if (!n.relations) n.relations = [];
  if (!n.participants) n.participants = [];
  if (!n.constraints) n.constraints = [];
}

function attrRecord(attrNode, extra) {
  const p = attrNode.props || {};
  return Object.assign({
    id: attrNode.id,
    name: attrNode.label,
    iri: attrNode.iri || '',
    valueType: str(p.valueType),
    cardinality: str(p.cardinality),
    definition: str(p.definition),
    required: false,
    source: 'declared',
    patternIri: '',
    patternLabel: '',
    useLabel: ''
  }, extra || {});
}

function projectStructuralV2() {
  const preStats = {
    attributes: [...nodes.values()].filter(n => n.kind === 'attribute').length,
    patternAttrs: [...nodes.values()].filter(n => n.kind === 'patternAttr').length,
    relations: [...nodes.values()].filter(n => n.kind === 'relation').length,
    constraints: [...nodes.values()].filter(n => n.kind === 'constraint').length
  };

  for (const n of nodes.values()) ensureHostBags(n);

  const usedAttrs = new Set();
  const edgeList = [...edges.values()];

  for (const e of edgeList) {
    if (e.type === 'attribute') {
      const host = nodes.get(e.from);
      const attr = nodes.get(e.to);
      if (host && attr && (attr.kind === 'attribute' || attr.kind === 'patternAttr')) {
        host.attrs.push(attrRecord(attr, { source: 'attributeUse', useLabel: e.label || '' }));
        usedAttrs.add(attr.id);
      }
    }
    if (e.type === 'injects') {
      const pattern = nodes.get(e.from);
      const attr = nodes.get(e.to);
      if (pattern && attr && (attr.kind === 'attribute' || attr.kind === 'patternAttr')) {
        pattern.attrs.push(attrRecord(attr, { source: 'injects', useLabel: e.label || '', patternIri: pattern.iri || '', patternLabel: pattern.label }));
        usedAttrs.add(attr.id);
      }
    }
  }

  for (const e of edgeList) {
    if (e.type !== 'pattern') continue;
    const host = nodes.get(e.from);
    const pattern = nodes.get(e.to);
    if (!host || !pattern) continue;
    for (const a of pattern.attrs || []) {
      if (a.source !== 'injects') continue;
      host.attrs.push(Object.assign({}, a, {
        source: 'pattern',
        patternIri: pattern.iri || pattern.id,
        patternLabel: pattern.label
      }));
    }
  }

  const orphanAttributes = [];
  for (const n of nodes.values()) {
    if (n.kind !== 'attribute' && n.kind !== 'patternAttr') continue;
    if (usedAttrs.has(n.id)) continue;
    const mod = n.cluster && nodes.get(n.cluster);
    if (mod && mod.kind === 'module') {
      mod.attrs.push(attrRecord(n, { source: 'moduleDeclared' }));
      usedAttrs.add(n.id);
    } else {
      orphanAttributes.push({ id: n.id, label: n.label, iri: n.iri || '' });
    }
  }

  const relationDefs = [];
  const relById = new Map();
  for (const n of nodes.values()) {
    if (n.kind !== 'relation') continue;
    const p = n.props || {};
    let domainId = null;
    let rangeId = null;
    for (const e of edgeList) {
      if (e.from !== n.id) continue;
      if (e.type === 'domainOf') domainId = e.to;
      if (e.type === 'rangeOf') rangeId = e.to;
    }
    const domainNode = domainId ? nodes.get(domainId) : null;
    const rangeNode = rangeId ? nodes.get(rangeId) : null;
    const def = {
      id: n.id,
      label: n.label,
      iri: n.iri || '',
      domainId: domainId || '',
      domainLabel: domainNode ? domainNode.label : str(p.domain),
      rangeId: rangeId || '',
      rangeLabel: rangeNode ? rangeNode.label : str(p.range),
      definition: str(p.definition),
      inverseOf: str(p.inverseOf),
      characteristics: str(p.characteristics),
      module: n.module || '',
      group: n.group,
      props: p
    };
    relationDefs.push(def);
    relById.set(n.id, def);
  }

  for (const e of edgeList) {
    if (e.type !== 'relation') continue;
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) continue;
    from.relations.push({ direction: 'out', name: e.label || 'relation', counterpartId: to.id, counterpartLabel: to.label, edgeId: e.id });
    to.relations.push({ direction: 'in', name: e.label || 'relation', counterpartId: from.id, counterpartLabel: from.label, edgeId: e.id });
  }

  for (const e of edgeList) {
    if (e.type !== 'participant') continue;
    const host = nodes.get(e.from);
    const range = nodes.get(e.to);
    if (host && range) host.participants.push({ role: e.label || 'role', rangeId: range.id, rangeLabel: range.label });
  }

  for (const e of edgeList) {
    if (e.type !== 'targets') continue;
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) continue;
    if (from.kind === 'constraint') {
      to.constraints.push({
        id: from.id,
        label: from.label,
        iri: from.iri || '',
        definition: str((from.props || {}).definition),
        constraintType: str((from.props || {}).constraintType),
        severity: str((from.props || {}).severity),
        message: str((from.props || {}).message)
      });
    }
  }
  for (const n of nodes.values()) {
    if (n.kind !== 'constraint') continue;
    const hasTarget = edgeList.some(e => e.type === 'targets' && e.from === n.id);
    if (hasTarget) continue;
    const mod = n.cluster && nodes.get(n.cluster);
    if (mod && mod.kind === 'module') {
      mod.constraints.push({
        id: n.id,
        label: n.label,
        iri: n.iri || '',
        definition: str((n.props || {}).definition),
        constraintType: str((n.props || {}).constraintType),
        severity: str((n.props || {}).severity),
        message: str((n.props || {}).message)
      });
    }
  }

  for (const n of [...nodes.values()]) {
    if (n.kind === 'module' || n.kind === 'primitive') continue;
    if (FOLD_KINDS.has(n.kind)) continue;
    const modId = n.cluster;
    if (modId && nodes.has(modId) && modId !== n.id) {
      addEdge(n.id, modId, 'moduleOf', 'module');
    }
  }

  for (const id of [...nodes.keys()]) {
    const n = nodes.get(id);
    if (n && FOLD_KINDS.has(n.kind)) nodes.delete(id);
  }

  const keepNode = (id) => nodes.has(id);
  for (const [key, e] of [...edges.entries()]) {
    if (DROP_EDGE_TYPES.has(e.type) || !keepNode(e.from) || !keepNode(e.to)) {
      edges.delete(key);
    }
  }

  for (const n of nodes.values()) {
    if (!n.attrs || !n.attrs.length) continue;
    for (const a of n.attrs) {
      const vt = a.valueType;
      if (!vt || typeof vt !== 'string' || vt === '') continue;
      if (!/^(https?:|urn:)/i.test(vt)) continue;
      const target = nodes.get('iri:' + vt);
      if (!target || target.id === n.id) continue;
      if (target.kind !== 'codelist' && target.kind !== 'identifier' && target.kind !== 'metatype') continue;
      addEdge(n.id, target.id, 'valueType', a.useLabel || a.name || 'valueType');
    }
  }
  for (const n of nodes.values()) {
    if (n.kind !== 'metatype' || !n.fields) continue;
    for (const f of n.fields) {
      const refs = fieldSpecRefs(f.type);
      for (const r of refs) {
        const t = resolveSchemaName(r);
        if (t && nodes.has(t) && nodes.get(t).kind === 'metatype') addEdge(n.id, t, 'fieldType', f.name);
      }
    }
  }

  let foldedAttrPlacements = 0;
  let foldedPatternAttrPlacements = 0;
  for (const n of nodes.values()) {
    for (const a of n.attrs || []) {
      if (String(a.id).includes('/patterns/attributes/') || a.source === 'injects' || a.source === 'pattern') foldedPatternAttrPlacements++;
      else foldedAttrPlacements++;
    }
  }

  return {
    relationDefs,
    orphanAttributes,
    preStats,
    foldedAttrPlacements,
    foldedPatternAttrPlacements,
    relationEdgeCount: [...edges.values()].filter(e => e.type === 'relation').length
  };
}

function build() {
  collectRegistrations();
  if (!FIBO_MODE) {
    for (const meta of META_FILES) processMetaFile(meta);
    const domainDirs = fs.readdirSync(DOMAIN_DIR).filter(d => {
      const dp = path.join(DOMAIN_DIR, d);
      return fs.statSync(dp).isDirectory() && d !== 'archive' && d !== 'registry' && fs.existsSync(path.join(dp, 'module.yaml'));
    });
    domainDirs.sort();
    for (const d of domainDirs) processDomainModule(d);
  } else {
    const modules = findModuleYamlFiles(DOMAIN_DIR);
    for (const entry of modules) {
      const modulePathKey = entry.dirName ? entry.dirName + '/' + entry.moduleKey : entry.moduleKey;
      processDomainModule(modulePathKey, entry.yamlPath);
    }
  }

  const projection = projectStructuralV2();
  layoutClusters();

  const nodeArr = [];
  for (const n of nodes.values()) {
    const out = { id: n.id, label: n.label, group: n.group, shape: n.shape, kind: n.kind, layer: n.layer, module: n.module, iri: n.iri };
    if (n.size != null) out.size = n.size;
    if (n.x != null) { out.x = n.x; out.y = n.y; }
    if (n.color) out.color = n.color;
    out.props = n.props || {};
    if (n.fields && n.fields.length) out.fields = n.fields;
    if (n.attrs && n.attrs.length) out.attrs = n.attrs;
    if (n.relations && n.relations.length) out.relations = n.relations;
    if (n.participants && n.participants.length) out.participants = n.participants;
    if (n.constraints && n.constraints.length) out.constraints = n.constraints;
    out.cluster = n.cluster || '';
    nodeArr.push(out);
  }
  const edgeArr = [...edges.values()].map(e => ({ id: e.id, from: e.from, to: e.to, type: e.type, label: e.label }));

  const groups = {};
  for (const [g, c] of Object.entries(M3_GROUP_COLORS)) {
    groups[g] = { background: c, border: c, highlight: { background: c, border: '#ffffff' }, font: { color: '#ffffff', size: 13, face: 'IBM Plex Sans, Segoe UI, sans-serif' } };
  }
  for (const [dir, c] of Object.entries(M2_MODULE_COLORS)) {
    groups['fibo-' + dir] = { background: c, border: c, highlight: { background: c, border: '#ffffff' }, font: { color: '#ffffff', size: 13, face: 'IBM Plex Sans, Segoe UI, sans-serif' } };
    groups['m2-' + dir] = { background: c, border: c, highlight: { background: c, border: '#ffffff' }, font: { color: '#ffffff', size: 13, face: 'IBM Plex Sans, Segoe UI, sans-serif' } };
  }
  groups['module'] = { background: '#1e293b', border: '#94a3b8', highlight: { background: '#334155', border: '#f8fafc' }, font: { color: '#f1f5f9', size: 15, face: 'IBM Plex Sans, Segoe UI, sans-serif' } };
  groups['primitive'] = { background: '#334155', border: '#64748b', highlight: { background: '#475569', border: '#e2e8f0' }, font: { color: '#e2e8f0', size: 11, face: 'IBM Plex Sans, Segoe UI, sans-serif' } };

  const edgeTypeDefaults = {
    subClassOf: true, relation: true, participant: true, pattern: true, import: true,
    fieldType: true, appliesTo: true, dependsOn: true, conflicts: true, inverseOf: false,
    targets: false, moduleOf: true, valueType: true,
    attribute: true, domainOf: true, rangeOf: true, injects: true, constrains: false
  };

  const data = {
    meta: {
      generatedAt: new Date().toISOString(),
      generator: 'fibo-visualization/generate.cjs',
      projection: 'structural-v2',
      counts: {
        nodes: nodeArr.length,
        edges: edgeArr.length,
        canvasNodes: nodeArr.length,
        canvasEdges: edgeArr.length,
        foldedAttributes: projection.preStats.attributes,
        foldedPatternAttrs: projection.preStats.patternAttrs,
        relationDefs: projection.relationDefs.length,
        relationEdges: projection.relationEdgeCount,
        orphanAttributes: projection.orphanAttributes.length,
        stats
      },
      orphanAttributes: projection.orphanAttributes,
      edgeTypeDefaults,
      layers: FIBO_MODE ? ['FIBO', 'Primitive'] : ['M3', 'M2', 'Primitive'],
      groups: Object.keys(groups)
    },
    groups,
    relationDefs: projection.relationDefs,
    nodes: nodeArr,
    edges: edgeArr
  };
  return data;
}

function writeOutputs(data) {
  fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(data, null, 0));
  const json = JSON.stringify(data).replace(/</g, '\u003c');
  const templatePath = path.join(OUT_DIR, 'template.html');
  if (!fs.existsSync(templatePath)) throw new Error('Missing visualization/template.html');
  const html = fs.readFileSync(templatePath, 'utf8')
    .replace('__DATA__', json)
    .replace(/__GENERATED__/g, data.meta.generatedAt);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
}

function main() {
  const data = build();
  writeOutputs(data);
  const c = data.meta.counts;
  console.log(FIBO_MODE ? 'FIBO ontology graph generated (structural-v2):' : 'Axiolune ontology graph generated (structural-v2):');
  console.log('  canvas nodes:', c.canvasNodes, ' edges:', c.canvasEdges);
  console.log('  folded attrs:', c.foldedAttributes, ' patternAttrs:', c.foldedPatternAttrs);
  console.log('  relationDefs:', c.relationDefs, ' relationEdges:', c.relationEdges);
  console.log('  orphans:', c.orphanAttributes);
  console.log('  stats:', JSON.stringify(c.stats));
  console.log('  output:', path.join(OUT_DIR, 'index.html'));
  console.log('  data:  ', path.join(OUT_DIR, 'data.json'));
}

main();
