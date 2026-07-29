# ADR-004: 元模型基础门槛 - 命名规则与模块系统

## 状态
**提议中 (Proposed)** | 2026-07-28

## 决策所有者
待指定

## 背景

ADR-003 的 P0 修复尝试过于激进，在基础设施尚未就绪时就引入了大量新结构。当前评审指出：

1. **命名不一致**：ADR-003 决定使用 `*Definition` 后缀，但实际 YAML 文件仍使用旧名称（`ObjectType` vs `ObjectTypeDefinition`），导致同时存在两套术语
2. **模块系统缺失**：`OntologyModule` 仍使用 `iri + namespace + imports: list[uri]`，无法支持版本锁定、摘要校验、符号解析
3. **符号引用无法解析**：`{BASE_IRI}`、前缀、跨文件引用都没有确定性解析规则
4. **TypeRef 未定义**：所有类型引用仍是自由字符串，无法静态验证

这些是**元模型的元问题**：在定义金融本体之前，必须先有可执行的元语言。

## 决策

### 决策 1：立即执行全局重命名为 `*Definition`

**规则**：所有 M3 元类型必须使用 `Definition` 后缀，与 M2 领域概念明确区分。

```yaml
# M3 元类型（定义建模语言本身）
ObjectTypeDefinition      # 旧: ObjectType
AssociationTypeDefinition # 旧: AssociationType
AttributeTypeDefinition   # 旧: AttributeType
RelationTypeDefinition    # 旧: RelationType
PatternDefinition         # 已正确
ConstraintDefinition      # 已正确
QueryTypeDefinition       # 旧: QueryType
FunctionTypeDefinition    # 旧: FunctionType
ActionTypeDefinition      # 旧: ActionType
DatasetDefinition         # 旧: Dataset
SemanticMappingDefinition # 旧: SemanticMapping

# M2 领域概念（由元语言描述）
fin:Instrument           # 不加后缀
fin:Order
fin:PriceObservation
fin:Position
```

**影响**：
- 4 个元模型 YAML 文件需要全局替换
- 所有示例中的 `type:` 字段需要更新
- ADR-003 可以简化为仅记录 P0 问题识别过程

### 决策 2：正式化模块系统

**当前问题**：
```yaml
# 当前错误的定义
OntologyModule:
  iri: "https://axiolune.ai/ontology/finance"
  namespace: "fin"  # 这实际是 prefix，不是 namespace
  imports:
    - "https://axiolune.ai/ontology/core"  # 无版本、无摘要
```

**修正为**：
```yaml
OntologyModuleDefinition:
  moduleIri: IRI
    description: "模块本身的 IRI（唯一标识此模块）"
    example: "https://axiolune.ai/ontology/finance/instruments"
  
  baseIri: IRI
    description: "此模块定义的概念的基础 IRI"
    example: "https://axiolune.ai/ontology/finance/instruments/"
    note: "注意尾部斜杠，用于拼接局部名称"
  
  preferredPrefix: string
    description: "建议的短前缀"
    example: "fin-inst"
    pattern: "^[a-z][a-z0-9-]*$"
  
  version: SemanticVersion
    description: "模块的语义化版本"
    example: "1.2.3"
  
  imports: list[ModuleImportDefinition]
    description: "此模块依赖的其他模块"
  
  exports: list[IRI]
    description: "显式导出的符号（如为空，导出所有已定义符号）"

ModuleImportDefinition:
  moduleIri: IRI
    description: "被导入模块的 IRI"
  
  version: SemanticVersion
    description: "锁定的版本（必填，防止隐式更新）"
  
  artifactDigest: string
    description: "被导入文件的 SHA-256 摘要"
    format: "sha256:[0-9a-f]{64}"
  
  importMode: enum [All, Selective]
    description: "All = 导入所有导出符号；Selective = 仅导入指定符号"
  
  importedSymbols: list[SymbolImportSpec]
    description: "仅在 importMode=Selective 时必填"

SymbolImportSpec:
  symbolIri: IRI
    description: "被导入符号的完整 IRI"
  
  localAlias: string?
    description: "可选的本地别名"
    example: "fibo:FinancialInstrument as Instrument"
```

**符号解析规则**：

1. **完整 IRI**：`https://axiolune.ai/ontology/finance/Instrument` → 直接使用
2. **前缀引用**：`fin:Instrument` → 查找 `preferredPrefix="fin"` 的导入模块 → 拼接 `{baseIri}Instrument`
3. **模块内局部名称**：`Instrument` → 拼接 `{当前模块baseIri}Instrument`
4. **{BASE_IRI} 占位符**：编译时替换为当前模块的 `baseIri`

### 决策 3：TypeRef 语法正式化

**问题**：当前所有类型字段都是自由字符串

**TypeRef 语法定义**：

```yaml
TypeRefSyntax:
  description: "类型引用的正式语法"
  
  primitiveTypes:
    - string
    - integer
    - decimal
    - boolean
    - datetime
    - duration
    - uri
    - iri
  
  structuredTypes:
    - "list[T]"           # 列表类型
    - "map[K, V]"         # 映射类型
    - "enum [V1, V2, ...]" # 枚举类型（内联）
    - "union [T1, T2, ...]" # 联合类型
    - "T?"                # 可选类型
  
  namedTypes:
    - "{iri}"             # 完整 IRI
    - "{prefix}:{localName}" # 前缀引用
    - "{localName}"       # 当前模块内
  
  constrainedTypes:
    - "string[pattern=/regex/]"
    - "integer[min=0, max=100]"
    - "decimal[scale=4]"
    - "list[T, minCount=1, maxCount=10]"

# 示例
AttributeTypeDefinition:
  name: "quotedPrice"
  valueType: "fin:MoneyType"  # TypeRef: 命名类型，前缀引用
  minCount: 1
  maxCount: 1

CallableParameterDefinition:
  name: "symbols"
  type: "list[string[pattern=/^[A-Z]{1,5}$/]]"  # TypeRef: 约束的列表
  required: true
```

### 决策 4：未定义符号的处理策略

**评审发现的仍未定义符号**：
- `CodeValue`
- `LocalizedText`
- `OWLRestriction`
- `SHACLPropertyShape`

**处理策略**：

1. **LocalizedText**：补齐定义
```yaml
LocalizedTextDefinition:
  description: "多语言文本值对象"
  kind: StructuredValueType
  fields:
    - language: "string[pattern=/^[a-z]{2}(-[A-Z]{2})?$/]"
      description: "语言标签 (ISO 639-1, optional ISO 3166-1)"
      example: "en, zh-CN, ja"
    - text: string
      description: "该语言的文本内容"
  
  defaultLanguage: "en"
  
  owlProjection:
    kind: rdfLangString
    note: "投影为 rdf:langString，支持 @en、@zh 等语言标签"
```

2. **CodeValue**：改为 AttributeTypeDefinition 实例
```yaml
# 删除对 CodeValue 的引用，改为
CurrencyCodeAttribute:
  type: AttributeTypeDefinition
  iri: "{BASE_IRI}/attributes/currencyCode"
  valueType: "string[pattern=/^[A-Z]{3}$/]"
  constraints:
    - constraintRef: "{BASE_IRI}/constraints/ISO4217"
```

3. **OWLRestriction / SHACLPropertyShape**：延迟到投影层
```yaml
# 不在核心元模型中定义这些 OWL/SHACL 特定结构
# 而是在 owlProjection / shaclProjection 中使用字符串或外部引用

AttributeTypeDefinition:
  owlProjection:
    kind: datatypeProperty | objectProperty | annotationProperty
    # 不内嵌 OWL 限制，而是引用
    additionalAxioms: list[string]
      description: "额外的 OWL 公理（Turtle 片段）"
      example:
        - "?x a owl:Restriction ; owl:onProperty ?p ; owl:minCardinality 1"
```

### 决策 5：ADR-003 的状态修正

**修改 ADR-003**：
- 状态从 `Draft` 改为 `Superseded by ADR-004`
- 保留问题识别部分（10 个 P0 问题的描述）
- 删除"P0 阻断项解除"等完成声明
- 增加后记：说明修复策略需要分阶段，基础门槛移至 ADR-004

## 实施计划

### 阶段 1：全局重命名（机械操作）

```bash
# 在所有 YAML 文件中执行全局替换
ObjectType → ObjectTypeDefinition
AssociationType → AssociationTypeDefinition
AttributeType → AttributeTypeDefinition
RelationType → RelationTypeDefinition
QueryType → QueryTypeDefinition
FunctionType → FunctionTypeDefinition
ActionType → ActionTypeDefinition
Dataset → DatasetDefinition
SemanticMapping → SemanticMappingDefinition
```

预期影响：
- `core-meta-model.yaml`：约 50 处
- `cross-domain-patterns.yaml`：约 20 处
- `behavior-meta-model.yaml`：约 30 处
- `data-binding-meta-model.yaml`：约 40 处

### 阶段 2：模块定义更新

在每个 YAML 文件的 `metadata` 部分，从：
```yaml
metadata:
  iri: "https://axiolune.ai/ontology/meta/core"
  namespace: "ax-meta"
```

改为：
```yaml
module:
  moduleIri: "https://axiolune.ai/ontology/meta/core"
  baseIri: "https://axiolune.ai/ontology/meta/core/"
  preferredPrefix: "ax-meta"
  version: "0.3.0"
  imports:
    - moduleIri: "https://axiolune.ai/ontology/meta/primitives"
      version: "1.0.0"
      artifactDigest: "sha256:..." # 待计算
      importMode: All
```

### 阶段 3：补齐 LocalizedText 和 TypeRef 规范

在 `core-meta-model.yaml` 中新增：
- `LocalizedTextDefinition`
- `TypeRefSyntax`（作为文档部分，非结构定义）

### 阶段 4：验证

使用 JSON Schema 验证器（待开发）验证：
1. 所有 TypeRef 引用的符号都已定义或导入
2. 所有模块导入都有版本和摘要
3. 没有循环依赖
4. 所有前缀都已声明

## 后果

### 正面影响

- **符号解析确定性**：所有引用都可追溯到定义
- **版本安全**：模块导入锁定版本，防止隐式破坏性变更
- **M3/M2 清晰区分**：`*Definition` 后缀消除歧义
- **静态验证可行**：TypeRef 语法使类型检查成为可能

### 负面影响

- **短期破坏性变更**：所有现有引用需要更新
- **复杂度增加**：模块系统引入更多概念
- **需要工具支持**：手工验证 TypeRef 和摘要不可行

### 风险

- **重命名遗漏**：可能有示例或文档未更新
- **摘要计算规则**：YAML 文件的规范化和摘要算法需要明确定义
- **前向兼容性**：旧版本模块如何与新模块互操作

## 替代方案及拒绝理由

### 方案 A：保持当前命名，不加 Definition 后缀

**理由**：减少破坏性变更

**拒绝原因**：
- M3/M2 歧义是根本性缺陷，延迟修复会积累更多技术债
- `ObjectType` 既指元类型又指实例（如 `fin:Instrument`）会导致工具实现混乱

### 方案 B：使用命名空间而非版本锁定

**理由**：OWL 标准中模块通过命名空间引用，无版本概念

**拒绝原因**：
- 金融系统需要确定性：`fin:Instrument` 在不同时间点不能有不同定义
- 版本锁定是现代依赖管理的最佳实践（npm、cargo、maven 等）

### 方案 C：延迟 TypeRef 正式化，继续使用字符串

**理由**：先完成功能开发，类型系统可以后补

**拒绝原因**：
- 无类型系统的元模型无法进行静态验证
- 评审明确指出这是"基础门槛"，必须前置

## 验收标准

1. ✅ 所有 YAML 文件中的元类型名称使用 `*Definition` 后缀
2. ✅ 所有模块定义包含 `moduleIri`、`baseIri`、`preferredPrefix`、`version`
3. ✅ 所有模块导入包含 `version` 和 `artifactDigest`
4. ✅ `LocalizedTextDefinition` 已定义
5. ✅ TypeRef 语法文档已编写
6. ✅ 提供至少一个完整示例模块，展示符号解析过程
7. ⚠️ JSON Schema 验证器原型（可延后到 ADR-005）

## 参考

- 评审意见（2026-07-28）："可以作为架构草案，尚不能称为 P0 已解除、元模型可编译"
- ADR-003: 元模型 P0 修正方案（本 ADR 取代其实施部分）
- [Semantic Versioning 2.0.0](https://semver.org/)
- [JSON Schema](https://json-schema.org/)
- [OWL 2 Web Ontology Language: Structural Specification](https://www.w3.org/TR/owl2-syntax/)
