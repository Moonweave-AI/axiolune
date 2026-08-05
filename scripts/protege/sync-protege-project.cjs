#!/usr/bin/env node
'use strict';

/**
 * Materialize a Protege-ready ontology project under protege/.
 * - Regenerates M3/M2 OWL + SHACL from canonical YAML sources
 * - Copies authoring YAML for traceability
 * - Writes OASIS catalog + root import ontologies for Protege
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROTEGE = path.join(ROOT, 'protege');
const META_DIR = path.join(ROOT, 'ontology', 'meta');
const FINANCE_DIR = path.join(ROOT, 'ontology', 'domain', 'finance');

const M3_META_FILES = [
  'core-meta-model.yaml',
  'cross-domain-patterns.yaml',
  'behavior-meta-model.yaml',
  'data-binding-meta-model.yaml',
];

const FINANCE_MODULES = [
  {
    dir: 'foundation',
    iri: 'https://axiolune.ai/ontology/finance/foundation',
    label: 'Financial Foundation',
    version: '1.0.0',
    imports: ['https://axiolune.ai/ontology/meta'],
  },
  {
    dir: 'market-structure',
    iri: 'https://axiolune.ai/ontology/finance/market-structure',
    label: 'Market Structure',
    version: '1.0.0',
    imports: ['https://axiolune.ai/ontology/meta', 'https://axiolune.ai/ontology/finance/foundation'],
  },
  {
    dir: 'instruments',
    iri: 'https://axiolune.ai/ontology/finance/instruments',
    label: 'Financial Instruments',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/market-structure',
    ],
  },
  {
    dir: 'market-data',
    iri: 'https://axiolune.ai/ontology/finance/market-data',
    label: 'Market Data',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/market-structure',
      'https://axiolune.ai/ontology/finance/instruments',
    ],
  },
  {
    dir: 'portfolio-positions',
    iri: 'https://axiolune.ai/ontology/finance/portfolio-positions',
    label: 'Portfolio & Positions',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/instruments',
      'https://axiolune.ai/ontology/finance/market-data',
    ],
  },
  {
    dir: 'orders-execution',
    iri: 'https://axiolune.ai/ontology/finance/orders-execution',
    label: 'Orders & Execution',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/market-structure',
      'https://axiolune.ai/ontology/finance/instruments',
    ],
  },
  {
    dir: 'post-trade-operations',
    iri: 'https://axiolune.ai/ontology/finance/post-trade-operations',
    label: 'Post-Trade Operations',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/market-structure',
      'https://axiolune.ai/ontology/finance/instruments',
    ],
  },
  {
    dir: 'market-rules',
    iri: 'https://axiolune.ai/ontology/finance/market-rules',
    label: 'Market Rules',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/market-structure',
      'https://axiolune.ai/ontology/finance/instruments',
    ],
  },
  {
    dir: 'risk',
    iri: 'https://axiolune.ai/ontology/finance/risk',
    label: 'Risk',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/market-data',
      'https://axiolune.ai/ontology/finance/portfolio-positions',
    ],
  },
  {
    dir: 'strategy-research',
    iri: 'https://axiolune.ai/ontology/finance/strategy-research',
    label: 'Strategy & Research',
    version: '1.0.0',
    imports: [
      'https://axiolune.ai/ontology/meta',
      'https://axiolune.ai/ontology/finance/foundation',
      'https://axiolune.ai/ontology/finance/instruments',
      'https://axiolune.ai/ontology/finance/market-data',
    ],
  },
];

function runNode(scriptRel, args) {
  const script = path.join(ROOT, scriptRel);
  const r = spawnSync(process.execPath, [script, ...(args || [])], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.stdout && r.stdout.trim()) process.stdout.write(r.stdout);
  if (r.stderr && r.stderr.trim()) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): node ${scriptRel} ${(args || []).join(' ')}`);
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function writeFile(dest, content) {
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, content, 'utf8');
}

function rel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function regenerateProjections() {
  console.log('Regenerating M3 OWL/SHACL...');
  runNode('scripts/meta/generate-owl.js');
  runNode('scripts/meta/generate-shacl.js');

  console.log('Regenerating M2 OWL/SHACL...');
  for (const mod of FINANCE_MODULES) {
    const yamlPath = path.join(FINANCE_DIR, mod.dir, 'module.yaml');
    const owlSrc = path.join(FINANCE_DIR, mod.dir, 'module.owl.ttl');
    const shaclSrc = path.join(FINANCE_DIR, mod.dir, 'module.shacl.ttl');
    runNode('scripts/domain/generate-m2-owl.cjs', [yamlPath, owlSrc]);
    runNode('scripts/domain/generate-m2-shacl.cjs', [yamlPath, shaclSrc]);
  }
}

function moduleOwlRel(mod) {
  return `02-m2-finance/${mod.dir}/owl/${mod.dir}.owl.ttl`;
}

function moduleOwlAbs(mod) {
  return path.join(PROTEGE, moduleOwlRel(mod));
}

/** IRI → path relative to protege/ root */
function catalogEntryList() {
  const entries = [
    {
      iri: 'https://axiolune.ai/ontology/meta',
      abs: path.join(PROTEGE, '01-m3-meta-model/owl/axiolune-meta.owl.ttl'),
    },
    {
      iri: 'https://axiolune.ai/ontology/all',
      abs: path.join(PROTEGE, '00-entry/axiolune-all.owl.ttl'),
    },
    {
      iri: 'https://axiolune.ai/ontology/finance',
      abs: path.join(PROTEGE, '00-entry/axiolune-finance.owl.ttl'),
    },
  ];
  for (const mod of FINANCE_MODULES) {
    entries.push({ iri: mod.iri, abs: moduleOwlAbs(mod) });
    entries.push({ iri: `${mod.iri}/${mod.version}`, abs: moduleOwlAbs(mod) });
  }
  return entries;
}

/** Protege loads catalog-v001.xml from the folder of the opened .ttl file (no Preferences menu). */
function buildCatalogXml(catalogDir) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<catalog prefer="public" xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">',
    '  <!-- Generated by scripts/protege/sync-protege-project.cjs -->',
    `  <!-- Place this file beside the ontology you open in Protege (${path.basename(catalogDir)}/) -->`,
  ];
  for (const e of catalogEntryList()) {
    const uriPath = rel(catalogDir, e.abs);
    lines.push(`  <uri name="${e.iri}" uri="${uriPath}"/>`);
  }
  lines.push('</catalog>', '');
  return lines.join('\n');
}

function writeCatalogs() {
  const catalogDirs = [
    PROTEGE,
    path.join(PROTEGE, '00-entry'),
    path.join(PROTEGE, '01-m3-meta-model/owl'),
  ];
  for (const mod of FINANCE_MODULES) {
    catalogDirs.push(path.join(PROTEGE, '02-m2-finance', mod.dir, 'owl'));
  }
  for (const dir of catalogDirs) {
    writeFile(path.join(dir, 'catalog-v001.xml'), buildCatalogXml(dir));
  }
}

function buildRootOntology({ iri, version, label, comment, imports }) {
  const importLines = imports.map((imp) => `    owl:imports <${imp}> ;`).join('\n');
  return `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${iri}> a owl:Ontology ;
    rdfs:label "${label}" ;
    rdfs:comment "${comment}" ;
${importLines}
    owl:versionIRI <${iri}/${version}> .
`;
}

function syncProtegeTree() {
  if (fs.existsSync(PROTEGE)) {
    fs.rmSync(PROTEGE, { recursive: true, force: true });
  }
  ensureDir(PROTEGE);

  const m3OwlSrc = path.join(META_DIR, 'projection', 'axiolune-meta.owl.ttl');
  const m3ShaclSrc = path.join(META_DIR, 'projection', 'axiolune-meta.shacl.ttl');
  const m3ShaclSparqlSrc = path.join(META_DIR, 'projection', 'axiolune-meta.shacl-sparql.ttl');

  copyFile(m3OwlSrc, path.join(PROTEGE, '01-m3-meta-model/owl/axiolune-meta.owl.ttl'));
  copyFile(m3ShaclSrc, path.join(PROTEGE, '01-m3-meta-model/shacl/axiolune-meta.shacl.ttl'));
  if (fs.existsSync(m3ShaclSparqlSrc)) {
    copyFile(m3ShaclSparqlSrc, path.join(PROTEGE, '01-m3-meta-model/shacl/axiolune-meta.shacl-sparql.ttl'));
  }
  for (const f of M3_META_FILES) {
    copyFile(path.join(META_DIR, f), path.join(PROTEGE, '01-m3-meta-model/authoring', f));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/protege/sync-protege-project.cjs',
    layers: {
      m3: {
        ontologyIri: 'https://axiolune.ai/ontology/meta',
        owl: '01-m3-meta-model/owl/axiolune-meta.owl.ttl',
        shacl: '01-m3-meta-model/shacl/axiolune-meta.shacl.ttl',
        authoring: M3_META_FILES.map((f) => `01-m3-meta-model/authoring/${f}`),
      },
      m2Finance: [],
    },
    entryPoints: {
      all: '00-entry/axiolune-all.owl.ttl',
      finance: '00-entry/axiolune-finance.owl.ttl',
    },
    catalog: 'catalog-v001.xml',
  };

  for (const mod of FINANCE_MODULES) {
    const srcDir = path.join(FINANCE_DIR, mod.dir);
    const owlSrc = path.join(srcDir, 'module.owl.ttl');
    const shaclSrc = path.join(srcDir, 'module.shacl.ttl');
    const yamlSrc = path.join(srcDir, 'module.yaml');
    const owlDest = path.join(PROTEGE, '02-m2-finance', mod.dir, 'owl', `${mod.dir}.owl.ttl`);
    const shaclDest = path.join(PROTEGE, '02-m2-finance', mod.dir, 'shacl', `${mod.dir}.shacl.ttl`);
    const yamlDest = path.join(PROTEGE, '02-m2-finance', mod.dir, 'authoring/module.yaml');

    copyFile(owlSrc, owlDest);
    copyFile(shaclSrc, shaclDest);
    copyFile(yamlSrc, yamlDest);

    manifest.layers.m2Finance.push({
      module: mod.dir,
      label: mod.label,
      ontologyIri: mod.iri,
      version: mod.version,
      imports: mod.imports,
      owl: `02-m2-finance/${mod.dir}/owl/${mod.dir}.owl.ttl`,
      shacl: `02-m2-finance/${mod.dir}/shacl/${mod.dir}.shacl.ttl`,
      authoring: `02-m2-finance/${mod.dir}/authoring/module.yaml`,
    });
  }

  copyFile(
    path.join(FINANCE_DIR, 'registry/prefixes.yaml'),
    path.join(PROTEGE, 'prefixes.yaml'),
  );

  const financeImports = FINANCE_MODULES.map((m) => m.iri);
  writeFile(
    path.join(PROTEGE, '00-entry/axiolune-finance.owl.ttl'),
    buildRootOntology({
      iri: 'https://axiolune.ai/ontology/finance',
      version: '1.0.0',
      label: 'Axiolune Finance Domain (M2)',
      comment: 'Root import ontology for all approved M2 finance modules (v1.0.0). Open this file in Protege with catalog-v001.xml active.',
      imports: financeImports,
    }),
  );

  writeFile(
    path.join(PROTEGE, '00-entry/axiolune-all.owl.ttl'),
    buildRootOntology({
      iri: 'https://axiolune.ai/ontology/all',
      version: '1.0.0',
      label: 'Axiolune Full Ontology',
      comment: 'Root import ontology for M3 meta-model plus all M2 finance modules.',
      imports: ['https://axiolune.ai/ontology/meta', 'https://axiolune.ai/ontology/finance'],
    }),
  );

  writeCatalogs();
  writeFile(path.join(PROTEGE, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const protegePath = PROTEGE.replace(/\\/g, '/');
  const metaFileUrl = 'file:///' + protegePath + '/01-m3-meta-model/owl/axiolune-meta.owl.ttl';
  writeFile(
    path.join(PROTEGE, 'README.md'),
    `# Axiolune Protege Project

Generated by \`node scripts/protege/sync-protege-project.cjs\`.

## Layout

| Path | Content |
|------|---------|
| \`00-entry/\` | Root import ontologies + \`catalog-v001.xml\` (open from here) |
| \`01-m3-meta-model/\` | M3 meta-model OWL + SHACL + authoring YAML |
| \`02-m2-finance/<module>/owl/\` | M2 module OWL + local \`catalog-v001.xml\` |
| \`prefixes.yaml\` | Curie prefix registry |
| \`MANIFEST.json\` | Machine-readable inventory |

## Open in Protege (5.5 / 5.6)

Protégé **没有** Preferences → Catalogs 菜单。本体库通过以下方式生效：

### 方式 A（推荐）：直接打开带 catalog 的入口文件

每个可打开目录里都已生成 \`catalog-v001.xml\`（与 .ttl 同目录）。Protégé 会自动读取。

1. **文件 → 打开…**
2. 选择（任选其一）：
   - 完整栈：\`${protegePath}/00-entry/axiolune-all.owl.ttl\`
   - 仅金融域：\`${protegePath}/00-entry/axiolune-finance.owl.ttl\`
   - 单模块：\`${protegePath}/02-m2-finance/foundation/owl/foundation.owl.ttl\`
   - 仅 M3：\`${protegePath}/01-m3-meta-model/owl/axiolune-meta.owl.ttl\`
3. 若提示解析 import，选 **是**；应通过同目录的 catalog 加载本地文件，而非从网络下载。

### 方式 B：用 Protégé 图形界面维护映射

**文件 → 编辑本体库…**（Edit ontology libraries…）

在此添加 IRI → 本地文件映射。保存后 Protégé 会更新当前工作目录下的 \`catalog-v001.xml\`。

### 若 import 仍走网络

1. 确认打开的是 \`00-entry/\` 下的 .ttl（该目录内必须有 \`catalog-v001.xml\`）。
2. 在 **编辑本体库** 中检查 \`https://axiolune.ai/ontology/meta\` 等 IRI 是否指向本地 .ttl。
3. Windows 路径可填：\`${metaFileUrl}\`

## SHACL

SHACL 位于各模块 \`shacl/\` 子目录，需 SHACL 插件或 TopBraid 单独加载。

## Regenerate

\`\`\`
node scripts/protege/sync-protege-project.cjs
\`\`\`
`,
  );
}

function main() {
  regenerateProjections();
  syncProtegeTree();
  console.log('\nProtege project materialized:');
  console.log(' ', PROTEGE);
  console.log('  entry: 00-entry/axiolune-all.owl.ttl');
  console.log('  catalog: catalog-v001.xml');
  console.log('  modules:', FINANCE_MODULES.length);
}

main();
