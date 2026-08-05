#!/usr/bin/env node
'use strict';

/**
 * M3 元类型核查工作底稿生成器（中文人类审查友好）
 *
 * 信息源：直接读取 ontology/meta/*.yaml 的四个元模型 YAML（v0.6.0）。
 * 不凭记忆杜撰；每一条 IRI、定义、字段、OWL 投影均来自 YAML 源。
 * 输出：docs/meta/m3-metatype-audit.md（中文 markdown，适合半人工核查）。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const META_DIR = path.join(ROOT, 'ontology', 'meta');
const OUT_PATH = path.join(ROOT, 'docs', 'meta', 'm3-metatype-audit.md');

const META_FILES = [
  { file: 'core-meta-model.yaml', sectionHint: 'MetaModel', layer: 1, cnTitle: '核心元模型', prefix: 'ax-meta' },
  { file: 'cross-domain-patterns.yaml', sectionHint: 'CrossDomainPatterns', layer: 2, cnTitle: '跨域模式', prefix: 'ax-pattern' },
  { file: 'behavior-meta-model.yaml', sectionHint: 'PlatformBehavior', layer: 3, cnTitle: '行为元模型', prefix: 'ax-behavior' },
  { file: 'data-binding-meta-model.yaml', sectionHint: 'DataBinding', layer: 4, cnTitle: '数据绑定元模型', prefix: 'ax-binding' },
];

const SCALAR_SECTION_META = new Set([
  'version', 'description', 'layer', 'changes', 'note', 'notes', 'purpose',
  'curiePrefixes', 'label', 'definition', 'validationRules', 'ValidationRules',
  'Notes', 'validation', 'examples', 'structures',
]);

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function isArr(v) { return Array.isArray(v); }
function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(str).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function findSection(doc, hint) {
  // 跳过 module:，找第一个非标量的对象顶层键
  const keys = Object.keys(doc).filter(k => k !== 'module');
  for (const k of keys) {
    if (isObj(doc[k]) && !SCALAR_SECTION_META.has(k)) return { name: k, section: doc[k] };
  }
  // 退而求其次
  if (doc[hint] && isObj(doc[hint])) return { name: hint, section: doc[hint] };
  return { name: hint, section: {} };
}

function collectFields(def) {
  const fields = [];
  const buckets = [
    { name: 'requiredFields', label: '必填' },
    { name: 'optionalFields', label: '可选' },
    { name: 'fields', label: '字段' },
    { name: 'commonRequiredFields', label: '共用必填' },
    { name: 'commonOptionalFields', label: '共用可选' },
  ];
  for (const b of buckets) {
    const bval = def[b.name];
    if (isObj(bval)) {
      for (const [fname, spec] of Object.entries(bval)) {
        if (!isObj(spec)) continue;
        fields.push({
          name: fname,
          required: b.name === 'requiredFields' || b.name === 'commonRequiredFields' || spec.required === true,
          bucket: b.label,
          type: str(spec.type) || (isArr(spec.type) ? 'list' : ''),
          desc: str(spec.description || spec.definition || ''),
          pattern: str(spec.pattern || ''),
          enumVals: isArr(spec.values) ? spec.values.map(str) : (isArr(spec.enumValues) ? spec.enumValues.map(str) : []),
          defaultVal: spec.default != null ? str(spec.default) : '',
        });
      }
    }
  }
  return fields;
}

function getOwlProjection(def) {
  const parts = [];
  if (isObj(def.owlProjection)) {
    const op = def.owlProjection;
    if (op.kind) parts.push('kind: ' + str(op.kind));
    if (op.stereotype) parts.push('stereotype: ' + str(op.stereotype));
    if (op.classIri) parts.push('classIri: ' + str(op.classIri));
    if (op.note) parts.push('note: ' + str(op.note).slice(0, 120));
  }
  if (def.owlProjectionOverride) parts.push('override: ' + str(def.owlProjectionOverride));
  return parts.join('  ·  ');
}

// 中文导读：由生成器作者基于 YAML 源撰写的解释性中文，用于辅助中文审查。
// 明确标注为「导读」，非权威定义；权威定义仍以 YAML 英文原文为准（见上表）。
const CN_GUIDE = {
  // Layer 1 核心
  OntologyModuleDefinition: '命名本体模块：一组带版本和依赖管理的本体元素集合。M2 每个金融模块都是它的实例。',
  ModuleImportDefinition: '模块导入：版本锁定的对另一本体模块的引用，确保符号解析确定性、防止隐式破坏性变更。',
  SymbolImportSpec: '符号导入规格：选择性导入单个符号并可起本地别名（如 fibo:FinancialInstrument as Instrument）。',
  LocalizedTextDefinition: '本地化文本：带语言标签的多语言文本值对象，投影为 rdf:langString。',
  ValueType: '原始值类型分类器：string/decimal/integer/boolean/date/instant/duration/uri 等内建类型，映射到 xsd。',
  IdentifierTypeDefinition: '标识符类型：带校验规则和发证机构的标准标识符元分类器（如 ISIN），投影为 datatype。',
  MoneyTypeDefinition: '货币金额类型：带币种和精度的结构化值，投影为 MonetaryAmount 类——金融金额禁用裸 decimal。',
  QuantityTypeDefinition: '量值类型：带单位和精度的测量值，投影为 QuantityValue 类，含取整模式（floor/ceiling/half-even 等）。',
  CodeListTypeDefinition: '受控词表类型：带版本和维护方的枚举，投影为 owl:Class（stereotype: enumeration）。',
  CodeValueDefinition: '词表成员：受控词表的一个稳定成员，投影为 namedIndividual，带 notation 和 evidence 锁定。',
  ObjectTypeDefinition: '对象类型定义：带身份、属性和约束的领域实体元类型，投影为 owl:Class。M2 实体都是它的实例。',
  AttributeTypeDefinition: '属性类型定义：附挂字面值或结构化值对象的类型化属性。投影按 valueType 分流：原始/标识符→DatatypeProperty；词表/结构化→ObjectProperty。',
  AttributeUse: '属性使用：将全局 AttributeTypeDefinition 绑定到具体 ObjectTypeDefinition，可覆盖基数和显示标签。',
  RelationTypeDefinition: '关系类型定义：实体类型间的二元语义关系，投影为 owl:ObjectProperty。纯语义关系用此；带上下文用 AssociationTypeDefinition。',
  RelationUse: '关系使用：关系的上下文应用，带特定基数约束（基数是上下文的，非全局）。',
  AssociationTypeDefinition: '关联类型定义：可具体化的 n-ary 关系，带身份、上下文和生命周期，投影为 owl:Class。用于需时间戳/来源/置信度的关系（如 PriceObservation、Holding）。',
  ParticipantRole: '参与者角色：关联类型中的一个类型化参与槽，关联至少 2 个角色。',
  PatternBinding: '模式绑定：声明某类型遵循一个跨域模式，模式会注入属性需求和约束。',
  Alignment: '对齐：本地本体元素与外部标准（FIBO 等）的文档化映射，含来源锁定、定位器、理由、验证状态。',
  ConstraintDefinition: '约束定义：可施加于类型/属性/关系/关联的语义校验规则，投影为 owl:Class（stereotype: constraint）。',
  ConstraintExpression: '约束表达式：约束的形式化表达，含语言（SHACL/SPARQL/JSONSchema/Regex/Custom）和表达式。',
  ConstraintParameter: '约束参数：参数化约束的参数定义。',
  ConstraintBinding: '约束绑定：将约束应用到具体本体元素，带参数值和执行级别。',
  ChangeRecord: '变更记录：本体元素变更的审计记录。',
  GovernanceMetadata: '治理元数据：所有权、审批和变更跟踪元数据。',
  // Layer 1 预定义属性（pattern 命名空间）——导读统一说明
  sourceEvidenceRef: '注解属性：将本体资源链接到支持其权威含义的不可变证据资源。',
  validFrom: '业务有效期起点：事实在现实世界中开始为真的时刻（业务时间轴）。',
  validTo: '业务有效期终点：事实在现实世界中停止为真的时刻，null 表示仍有效。',
  knowledgeFrom: '知识期起点：平台开始断言该版本事实为真的系统时间（知识时间轴）。',
  knowledgeTo: '知识期终点：平台停止断言该版本为当前的系统时间，null 表示当前版本。',
  observedAt: '观测时刻：测量/观测/行情读取被源系统原始捕获的时刻。',
  availableFrom: '可用期起点：数据可被下游消费的起始时刻（含延迟/授权/禁运），PIT 防前视偏差关键。',
  availableTo: '可用期终点：数据可被消费的截止时刻，null 表示一旦到达起点即长期可用。',
  publishedAt: '发布时刻：数据提供方/源系统正式发布信息的时刻。',
  receivedAt: '接收时刻：平台摄取系统从外部源收到信息的时刻。',
  source: '来源 URI：标示信息来源的权威数据提供方/系统/组织的 URI。',
  sourceVersion: '来源版本：标示来源系统/数据集版本或快照的字符串，用于可复现。',
  confidence: '置信度：[0.0, 1.0] 闭区间的小数，量化断言为真的可靠性。',
  revision: '修订号：随事实每次更新单调递增的非负整数，用于变更跟踪。',
  derivedFrom: '派生来源：引用计算/变换/推断出该事实的源事实的 URI 列表（无界）。',
  recordedAt: '记录时刻：观测被捕获并记入系统的时刻（TemporalObservation 用）。',
  evidenceType: '证据类型：支持某断言的证据类别（document/measurement/testimony 等）。',
  evidenceRef: '证据引用：指向支持断言的证据工件的 URI。',
  evidenceDigest: '证据摘要：证据工件的加密哈希（sha256:... 等），保证完整性和防篡改。',
  evidenceTimestamp: '证据时间戳：证据被捕获或创建的时刻。',
  evidenceDescription: '证据描述：解释证据性质和相关性的人类可读叙述。',
  lifecycleState: '生命周期状态：实体/事实当前生命周期阶段（draft/active/deprecated 等）。',
  lifecycleVersion: '生命周期版本：跟踪生命周期状态转换次数的非负整数。',
  createdAt: '创建时刻：实体首次在系统中创建的时刻（不可变，区别于业务/知识时间）。',
  updatedAt: '更新时刻：实体最后修改的时刻（技术修改时间，非业务有效期）。',
  deprecatedAt: '废弃时刻：实体被标记为废弃的时刻，null 表示未废弃。',
  semanticVersion: '语义版本：符合 MAJOR.MINOR.PATCH 的兼容性级别字符串。',
  versionedIri: '版本化 IRI：含版本信息的全局唯一 IRI，精确标识版本化资源。',
  priorVersion: '前一版本：该实体紧邻前一版本的 IRI，形成版本链。',
  incompatibleWith: '不兼容版本：与本版本已知不兼容的版本 IRI，用于声明破坏性变更。',
  // Layer 2
  PatternDefinition: '模式定义：可绑定到对象/关联类型的可复用跨域语义模式元分类器。把 Temporal/Provenance/Evidence 等形式化为一等本体元素。',
  PatternParameter: '模式参数：自定义模式行为的配置参数。',
  PatternOWLProjection: '模式 OWL 投影：模式到 OWL 构造的映射规格（mixin/restriction/unionOf/propertyChain）。',
  OWLRestriction: 'OWL 限制：模式投影到绑定类型时发出的闭 OWL 限制。',
  PatternSHACLShape: '模式 SHACL 形状：校验使用该模式的实例的 SHACL 形状。',
  SHACLPropertyShape: 'SHACL 属性形状：跨域模式贡献的属性级 SHACL 投影。',
  PatternExample: '模式示例：该模式使用方式的示例。',
  // Layer 3
  CallableParameterDefinition: '可调用参数定义：查询/函数/动作共用的参数定义结构，避免重复。',
  QueryTypeDefinition: '查询类型定义：只读数据访问操作，带类型化参数和返回值，无副作用。',
  FunctionTypeDefinition: '函数类型定义：无副作用的纯计算操作（确定性、引用透明、幂等）。',
  ActionTypeDefinition: '动作类型定义：有状态的操作，修改系统状态或与外部系统交互（交易动作/工作流），需授权、前置条件、审计、补偿语义。',
  ExecutionRecordDefinition: '执行记录定义：动作执行尝试的持久记录，用于审计/恢复/对账（ADR-008）。',
  PolicyType: '策略类型：授权/合规/治理规则元分类器，定义访问控制、风险限额、审批工作流。',
  // Layer 4
  ArtifactRef: '工件引用：指向绝对工件 IRI 或某构建根下路径的闭引用。',
  SourceLocator: '来源定位器：锁定源工件内一段规范非空字节选择的闭媒体感知选择器。',
  SemanticValueDefinition: '语义值定义',
  IdentityComponentDefinition: '身份组件定义',
  IdentityTermContractDefinition: '身份术语契约定义',
  IdentityNormalizationRuleDefinition: '身份规范化规则定义',
  IdentityDerivationDefinition: '身份派生定义',
  ControlledIriSetDefinition: '受控 IRI 集合定义',
  TargetIdentityContractDefinition: '目标身份契约定义',
  ReferenceIdentityBinding: '引用身份绑定',
  FactIdentity: '事实身份',
  FactVersion: '事实版本',
  FactClosureAssertion: '事实闭包断言',
  DataSource: '数据源',
  DatasetDefinition: '数据集定义',
  FieldDefinition: '字段定义：物理数据源中字段的定义，含名称/原生类型/语义引用（ADR-011：不含语义注解）。',
  IndexDefinition: '索引定义',
  SourceBinding: '来源绑定',
  RowSetSpec: '行集规格',
  IdentitySpec: '身份规格',
  ValueBinding: '值绑定',
  SlotMapping: '槽映射：属性/角色/关系/模式字段到数据槽的映射（v0.5.0 从 fieldMappings 改名）。',
  TransformationDefinition: '变换定义',
  TargetSlot: '目标槽',
  TimeAxisBinding: '时间轴绑定',
  ProvenanceBinding: '溯源绑定',
  TemporalMappingSpec: '时序映射规格：ADR-012 三轴时间模型（有效/知识/可用）的显式源绑定。',
  SemanticMappingDefinition: '语义映射定义：ADR-011 单一真相源——唯一的语义映射结构，所有映射能力的权威。',
  MaterializationBatchDefinition: '物化批次定义',
  MaterializationRun: '物化运行：不可变运行时状态，为可复现查询提供 $referenceTime 等上下文（ADR-012）。',
  MaterializationPlanDefinition: '物化计划定义',
  DataLineage: '数据血缘',
  PITValidationRequest: 'PIT 校验请求',
  MaterializationBatchRun: '物化批次运行',
  ValidationReport: '校验报告',
  FailureReport: '失败报告',
  ReplayReport: '重放报告',
  EvidenceLedger: '证据账本',
  BuildEvidenceBinding: '构建证据绑定',
  ArtifactBinding: '工件绑定',
  MappingClosureEntry: '映射闭包条目',
  MaterializationResult: '物化结果',
  CompletedBatchMember: '已完成批次成员',
  AttemptedBatchMember: '已尝试批次成员',
  MaterializationContext: '物化上下文',
  KindEvidenceBinding: 'Kind 证据绑定',
  GateCounts: '门禁计数',
  GateCheck: '门禁检查',
  GateViolation: '门禁违规',
  GateResult: '门禁结果',
  // Layer 4 补充
  sourceArtifactRef: '源工件引用：指向锁定源工件的对象属性。',
  sourceArtifactDigest: '源工件摘要：源工件的加密摘要，保证完整性与可复现。',
  sourceLocator: '来源定位器属性：将绑定结构链接到 SourceLocator 的对象属性。',
  versionOf: '版本归属：将 FactVersion 链接到其 FactIdentity 的对象属性（函数式）。',
  supersedes: '取代：声明某版本取代前一版本的对象属性。',
  generatingContextRef: '生成上下文引用：生成该产物的物化运行 IRI（v0.6.0 由规范映射产出，非适配器注入）。',
  inputContextRef: '输入上下文引用：该物化所依据的上游运行 IRI。',
  inputContextRecordDigest: '输入上下文记录摘要：上游运行记录的摘要，锁定输入。',
  pitRequestRef: 'PIT 请求引用：触发该物化的 PIT 校验请求 IRI。',
  pitRequestRecordDigest: 'PIT 请求记录摘要：PIT 请求记录的摘要。',
  ReplayComparison: '重放比对：重放结果与原始结果的比对记录。',
  ReplayResult: '重放结果：一次重放执行的产出记录。',
  EvidenceSlotSelection: '证据槽选择：从证据账本中选择槽位的规格。',
  EvidenceLedgerEntry: '证据账本条目：证据账本中的单条不可变记录。',
  ExecutionError: '执行错误：物化执行中捕获的错误记录。',
  InputDatasetSnapshot: '输入数据集快照：物化输入数据集的快照，用于可复现。',
  IngestionPipelineDefinition: '摄取管线定义：v0.3.0 起已弃用，由 MaterializationPlanDefinition 取代——核查时若发现仍被引用应标记为漂移。',
  Examples: '示例：该元类型下声明的使用示例集合（结构辅助键，非独立元类型）。',
  constraints: '内建约束集合：该元类型下声明的预定义约束实例（如 ExactVersionReference、LogicalReference）。',
};

function getCnGuide(name) {
  return CN_GUIDE[name] || '';
}

function getIri(def, meta, localName) {
  if (def.iri) return str(def.iri);
  // 元类型本身通常无 iri 字段——这是 M3 的重要核查点
  return '';
}

function renderFieldTable(fields) {
  if (!fields.length) return '（无字段声明）\n';
  let out = '| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |\n';
  out += '|---|---|---|---|---|---|\n';
  for (const f of fields) {
    const constraint = [f.pattern, f.enumVals.join('/')].filter(Boolean).join('  ·  ');
    out += `| \`${f.name}\` | ${f.required ? '是' : '否'} | \`${f.type}\` | ${constraint || '—'} | ${f.defaultVal || '—'} | ${f.desc.slice(0, 80)} |\n`;
  }
  return out;
}

function countMetaTypes(section) {
  let count = 0;
  for (const [name, def] of Object.entries(section)) {
    if (SCALAR_SECTION_META.has(name)) continue;
    if (isObj(def)) count++;
  }
  return count;
}

function generate() {
  const layers = [];
  for (const meta of META_FILES) {
    const p = path.join(META_DIR, meta.file);
    const doc = yaml.load(fs.readFileSync(p, 'utf8'));
    if (!isObj(doc)) continue;
    const modDef = doc.module || {};
    const { name: sectionName, section } = findSection(doc, meta.sectionHint);
    const metaTypes = [];
    for (const [name, def] of Object.entries(section)) {
      if (SCALAR_SECTION_META.has(name)) continue;
      if (!isObj(def)) continue;
      metaTypes.push({
        name,
        definition: str(def.definition || def.purpose || ''),
        cnNote: str(def.cnNote || ''),
        owlProjection: getOwlProjection(def),
        iri: getIri(def, meta, name),
        fields: collectFields(def),
        note: str(def.note || '').slice(0, 200),
        hasIri: !!def.iri,
      });
    }
    layers.push({
      ...meta,
      moduleIri: str(modDef.moduleIri),
      moduleVersion: str(modDef.version),
      sectionName,
      sectionVersion: str(section.version),
      sectionLayer: str(section.layer),
      sectionDesc: str(section.description),
      metaTypes,
    });
  }

  // 组装 markdown
  let md = '';
  md += '# M3 元类型核查工作底稿\n\n';
  md += '> **用途**：M3 语义元模型（v0.6.0）的半人工核查底稿。\n';
  md += '> **信息源**：本底稿由 `scripts/meta/generate-m3-audit.cjs` 直接读取 `ontology/meta/*.yaml`（四个元模型 YAML，权威源）生成，不凭记忆杜撰。\n';
  md += '> **核查方式**：逐个元类型核对 IRI、定义、OWL 投影、字段清单。每项后附核查标记位 `[ ]`。\n';
  md += '> **生成时间**：' + new Date().toISOString() + '\n\n';
  md += '---\n\n';

  md += '## 总览\n\n';
  md += 'M3 是 Axiolune 的语义元模型，定义 M2 领域模块可实例化的元类型。M3 分四层，均为 v0.6.0：\n\n';
  md += '| 层 | 文件 | 中文 | 元类型数 | 模块 IRI |\n';
  md += '|---|---|---|---|---|\n';
  for (const l of layers) {
    md += `| Layer ${l.layer} | \`${l.file}\` | ${l.cnTitle} | ${l.metaTypes.length} | \`${l.moduleIri}\` |\n`;
  }
  md += '\n';

  md += '### 核查要点（通读前必看）\n\n';
  md += '1. **元类型 IRI 与 OWL 投影**：自 v0.6.0 起，每个 M3 元类型 schema 顶层都带有规范 `iri:` 字段（形如 `https://axiolune.ai/ontology/meta/{layer}/{Name}`），并在投影 OWL 中由 `generate-owl.js` 的 R0 规则声明为 `owl:Class` 或 `owl:ObjectProperty`/`owl:DatatypeProperty`。底稿中「IRI」列应已填充；若仍为空，说明该 schema 缺少 `iri:` 字段，属需修补的漂移。\n';
  md += '2. **定义规范**：每个元类型应有 ISO 704 属种差定义（genus + differentia）。核查定义是否完整、是否区分于相邻元类型。\n';
  md += '3. **中文导读（cnNote）**：每个元类型 schema 顶层带 `cnNote:` 字段，提供通俗中文理解，辅助审查；导读非权威定义，权威定义仍以 YAML 英文原文为准。\n';
  md += '4. **OWL 投影**：`owlProjection.kind` 决定该元类型如何投影为 OWL 构造（class / datatypeProperty / objectProperty / structuredValueClass 等）。核查投影是否与字段语义一致。\n';
  md += '5. **字段完整性**：必填字段是否合理、类型引用是否指向已定义的元类型、枚举值是否穷尽。\n';
  md += '6. **版本**：四个层均声明 v0.6.0；元类型 IRI 若存在应携带版本。\n\n';
  md += '---\n\n';

  for (const l of layers) {
    md += `## Layer ${l.layer} · ${l.cnTitle}（${l.sectionName}）\n\n`;
    md += `**文件**：\`ontology/meta/${l.file}\`\n`;
    md += `**模块 IRI**：\`${l.moduleIri}\`  ·  **版本**：${l.sectionVersion || l.moduleVersion}  ·  **前缀**：\`${l.prefix}\`\n`;
    if (l.sectionDesc) md += `**层说明**：${l.sectionDesc}\n`;
    md += `**元类型总数**：${l.metaTypes.length}\n\n`;
    md += '---\n\n';

    for (const mt of l.metaTypes) {
      md += `### ${mt.name}\n\n`;
      const cnGuide = mt.cnNote || getCnGuide(mt.name);
      if (cnGuide) {
        md += `> **中文导读**：${cnGuide}\n>\n`;
        md += `> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*\n\n`;
      }
      md += `| 属性 | 值 |\n|---|---|\n`;
      md += `| **IRI** | ${mt.iri ? '`' + mt.iri + '`' : '⚠️ 无（元类型本身未声明 IRI）'} |\n`;
      md += `| **OWL 投影** | ${mt.owlProjection || '⚠️ 未声明'} |\n`;
      md += `| **定义（YAML 原文）** | ${mt.definition || '⚠️ 无定义'} |\n`;
      md += `\n`;
      if (mt.note) {
        md += `> **注**：${mt.note}\n\n`;
      }
      md += `**字段清单**（共 ${mt.fields.length} 个）：\n\n`;
      md += renderFieldTable(mt.fields);
      md += '\n';
      md += `**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度\n\n`;
      md += '---\n\n';
    }
  }

  md += '## 附录：预定义属性与模式实例\n\n';
  md += '以下不属元类型定义，但作为核查参考列出（来自 YAML 源）：\n\n';
  md += '### Layer 1 预定义属性（`pattern:` 命名空间）\n\n';
  md += '这些属性在 `core-meta-model.yaml` 中以扁平键声明，投影为 `owl:DatatypeProperty`，供 Layer 2 模式注入。\n\n';
  md += '详见 `ontology/meta/core-meta-model.yaml` 第 546–980 行区段（validFrom / validTo / knowledgeFrom / knowledgeTo / observedAt / availableFrom / availableTo / publishedAt / receivedAt / source / sourceVersion / confidence / revision / derivedFrom / recordedAt / evidenceType / evidenceRef / evidenceDigest / evidenceTimestamp / evidenceDescription / lifecycleState / lifecycleVersion / createdAt / updatedAt / deprecatedAt / semanticVersion / versionedIri / priorVersion / incompatibleWith / sourceEvidenceRef）。\n\n';
  md += '### Layer 2 模式实例\n\n';
  md += '7 个具体模式（均投影为 `owl:Class`）：PublicationTiming、TemporalFact、TemporalObservation、ProvenancedFact、Evidence、Lifecycle、Versioning。详见 `cross-domain-patterns.yaml` 的 `patterns:` 列表。\n\n';
  md += '### Layer 2 预定义约束（9 个）\n\n';
  md += 'PublishBeforeReceive、ValidIntervalConsistency、KnowledgeIntervalConsistency、NoFutureKnowledge、ObservationBeforeRecording、ConfidenceRange、DigestFormat、SemanticVersionFormat、AvailabilityBeforeUse、AvailabilityIntervalConsistency。详见 `cross-domain-patterns.yaml` 的 `constraints:` 区段。\n\n';

  return md;
}

function main() {
  const md = generate();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, md, 'utf8');
  // 统计
  let total = 0;
  for (const meta of META_FILES) {
    const doc = yaml.load(fs.readFileSync(path.join(META_DIR, meta.file), 'utf8'));
    const { section } = findSection(doc, meta.sectionHint);
    let c = 0;
    for (const [name, def] of Object.entries(section)) {
      if (SCALAR_SECTION_META.has(name) || !isObj(def)) continue;
      c++;
    }
    total += c;
  }
  console.log('M3 元类型核查底稿已生成:');
  console.log('  输出:', OUT_PATH);
  console.log('  元类型总数:', total);
  console.log('  信息源: ontology/meta/*.yaml (v0.6.0)');
}

main();
