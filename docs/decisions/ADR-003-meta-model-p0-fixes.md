# ADR-003: 元模型 P0 修正方案

## 状态
**草案 (Draft)** | 2026-07-28

## 背景

v0.2.0 四层元模型架构方向正确，但经过完整评审后发现以下问题：

1. **P0 阻断项**：未定义符号、作用域错误、模式无法解析、层级混淆、基数不一致、映射目标类型错误、值类型投影不成立、双时间模型不足、行为编排混入、交易动作失败语义不足
2. **根本问题**：M3（元语言）、M2（金融本体）、M1（业务事实）、M0（物理记录）四个建模层级混淆
3. **分层问题**：每层都存在语义漂移、职责越界、定义不完整

## 决策

### 决策 1: 明确四个建模层级（M3/M2/M1/M0）

**采纳建议**：

```yaml
# M3: 元语言（Meta-Language）
# 定义建模语言本身的构造
- ObjectTypeDefinition      # 旧名: ObjectType
- AssociationTypeDefinition # 旧名: AssociationType
- AttributeTypeDefinition   # 旧名: AttributeType
- RelationTypeDefinition    # 旧名: RelationType
- PatternDefinition         # 新增：正式化跨域模式
- ConstraintDefinition      # 需补齐
- OntologyModule           # 保留

# M2: 金融本体（Finance Ontology）
# 由 M3 语言描述的领域概念
- fin:Instrument
- fin:Order
- fin:PriceObservation
- fin:Position
# 这些是本体元素，具有 IRI、版本、对齐

# M1: 业务事实（Business Facts）
# 具体的业务实例
- 某证券 (例: isin:US0378331005)
- 某笔订单 (例: order:20260728-001)
- 某次价格观测 (例: price:AAPL-NASDAQ-20260728-160000)
# 这些是 RDF 资源，由 Layer 2 模式（时间、来源、证据）约束

# M0: 物理记录（Physical Records）
# 存储层的实际表示
- PostgreSQL 表行
- Kafka 消息
- Bloomberg API 响应
- Parquet 文件
# Layer 4 负责 M0 → M1 映射
```

**影响**：
- 所有元类型名称增加 `Definition` 后缀
- `PatternBinding.pattern` 的解析目标明确为 `PatternDefinition.iri`
- Identity、Versioning 拆分：本体工件版本 vs 业务事实修订
- Layer 4 映射目标明确为 M1 实例，而非 M2 概念

### 决策 2: 修复 10 个 P0 阻断项

#### P0-1: 补齐未定义的核心符号

**问题**：
- Core 引用了 `ConstraintDefinition`, `ConstraintBinding`, `ChangeRecord`, `CurrencyCode`, `CodeValue`
- Data 引用了 `FieldDefinition`, `IndexDefinition`

**修正**：
```yaml
# 在 core-meta-model.yaml 新增：
ConstraintDefinition:
  description: "约束定义：描述必须满足的语义规则"
  structures:
    - id: string
    - iri: IRI
    - name: LocalizedText
    - constraintType: enum [Cardinality, ValueRange, Pattern, Custom, Logical]
    - scope: enum [Attribute, Relation, Object, Association, Pattern]
    - expression: ConstraintExpression
    - severity: enum [Error, Warning, Info]
    - message: LocalizedText

ConstraintBinding:
  description: "约束绑定：将约束附加到具体类型或使用点"
  structures:
    - constraintRef: IRI  # → ConstraintDefinition
    - targetElement: IRI  # ObjectType/AttributeUse/RelationUse
    - parameters: map[string, any]
    - enforcementLevel: enum [Mandatory, Advisory]

ChangeRecord:
  description: "变更记录：本体工件的修订历史"
  structures:
    - changeId: string
    - timestamp: datetime
    - author: string
    - changeType: enum [Addition, Modification, Deprecation, Deletion]
    - affectedElement: IRI
    - description: LocalizedText
    - breakingChange: boolean

# 在 data-binding-meta-model.yaml 新增：
FieldDefinition:
  description: "字段定义：数据集中的一个列或属性"
  structures:
    - name: string
    - dataType: DataType
    - nullable: boolean
    - primaryKey: boolean
    - foreignKey: ForeignKeyReference
    - defaultValue: any
    - constraints: list[ConstraintRef]

IndexDefinition:
  description: "索引定义：数据集的物理索引结构"
  structures:
    - name: string
    - fields: list[string]
    - unique: boolean
    - indexType: enum [BTree, Hash, GiST, GIN]
```

**删除未应存在的引用**：
- 移除 `CurrencyCode`、`CodeValue` 的直接引用，改为 `StructuredValueType` 的实例

#### P0-2: ParameterDefinition 作用域提升

**问题**：仅定义在 `QueryType.structures`，但 `FunctionType` 和 `ActionType` 也使用

**修正**：
```yaml
# 在 behavior-meta-model.yaml 顶层新增：
CallableParameterDefinition:
  description: "可调用单元的参数定义（Query/Function/Action 共享）"
  structures:
    - name: string
    - type: TypeRef
    - required: boolean
    - defaultValue: any
    - description: LocalizedText
    - constraints: list[ConstraintBinding]
    - semanticRole: enum [Subject, Predicate, Object, Context, Temporal, Provenance]

# 在 QueryType/FunctionType/ActionType 中统一使用：
QueryType:
  structures:
    - parameters: list[CallableParameterDefinition]  # 旧: ParameterDefinition

FunctionType:
  structures:
    - parameters: list[CallableParameterDefinition]

ActionType:
  structures:
    - parameters: list[CallableParameterDefinition]
```

#### P0-3: Layer 2 模式引入正式 PatternDefinition

**问题**：`TemporalFact`、`ProvenancedFact` 等没有 IRI，无法被 `PatternBinding.pattern: uri` 解析

**修正**：
```yaml
# 在 cross-domain-patterns.yaml 顶层新增元类型：
PatternDefinition:
  description: "模式定义：可注入的跨域语义模式"
  structures:
    - iri: IRI  # 例: {BASE_IRI}/patterns/TemporalFact
    - name: string
    - version: SemanticVersion
    - description: LocalizedText
    - parameters: list[PatternParameter]  # 例: timeGranularity
    - dependencies: list[IRI]  # 依赖的其他模式
    - conflicts: list[IRI]  # 互斥的模式
    - injectedAttributes: list[AttributeUse]
    - injectedRelations: list[RelationUse]
    - constraintsAdded: list[ConstraintBinding]
    - owlProjection: PatternOWLProjection
    - shaclShape: PatternSHACLShape

PatternParameter:
  structures:
    - name: string
    - type: TypeRef
    - required: boolean
    - defaultValue: any

# 将现有模式改写为 PatternDefinition 实例：
patterns:
  - pattern: TemporalFact
    iri: "{BASE_IRI}/patterns/TemporalFact"
    version: "1.0.0"
    description: "双时间语义模式"
    parameters:
      - name: timeGranularity
        type: enum [Second, Minute, Hour, Day]
        required: false
        defaultValue: Second
    injectedAttributes:
      - attributeRef: "{BASE_IRI}/attributes/validFrom"
        minCount: 1
        maxCount: 1
      - attributeRef: "{BASE_IRI}/attributes/validTo"
        minCount: 0
        maxCount: 1
      - attributeRef: "{BASE_IRI}/attributes/knowledgeFrom"
        minCount: 1
        maxCount: 1
      - attributeRef: "{BASE_IRI}/attributes/knowledgeTo"
        minCount: 0
        maxCount: 1
    owlProjection:
      kind: mixin
      additionalClasses:
        - owl:Class
        - time:TemporalEntity
```

#### P0-4: 删除 Layer 1 残留的 Interface 模型

**问题**：`ObjectType.interfaces` 引用 `fin:Queryable`、`fin:Priceable`，但 Layer 3 无 `InterfaceType`

**修正**：
```yaml
# 在 core-meta-model.yaml 中删除：
ObjectTypeDefinition:
  structures:
    # - interfaces: list[IRI]  # 删除此字段

# 在 behavior-meta-model.yaml 中改为反向声明：
QueryType:
  structures:
    - applicableToTypes: list[IRI]  # 声明此查询可作用于哪些对象类型
    # 例: applicableToTypes: [fin:Instrument, fin:Position]

FunctionType:
  structures:
    - applicableToTypes: list[IRI]
```

**理由**：行为不应混入核心语义层；由行为层声明其作用对象更清晰

#### P0-5: 基数字段统一

**问题**：
- 结构定义使用 `minCount`/`maxCount`
- 示例写 `{min, max}`
- 规则又写 `max: null`

**修正**：
```yaml
# 全局统一规则：
# 1. 使用 minCount/maxCount（对齐 SHACL sh:minCount/sh:maxCount）
# 2. maxCount: null 表示无上限
# 3. 所有示例必须遵循此约定

# 示例更正前：
cardinality: {min: 1, max: 1}

# 示例更正后：
minCount: 1
maxCount: 1

# 无上限示例：
minCount: 0
maxCount: null  # 无上限
```

#### P0-6: Association 参与者映射目标类型扩展

**问题**：`SemanticMapping.targetAttribute` 无法映射 Association 的对象角色

**修正**：
```yaml
# 在 data-binding-meta-model.yaml 中新增联合类型：
TargetSlot:
  description: "映射目标槽位（属性/角色/关系/模式字段）"
  oneOf:
    - AttributeSlot:
        targetAttribute: IRI  # → AttributeType
    - ParticipantRoleSlot:
        targetAssociation: IRI  # → AssociationType
        targetRole: string  # ParticipantRole.id
    - RelationSlot:
        targetRelation: IRI  # → RelationType
    - PatternFieldSlot:
        targetPattern: IRI  # → PatternDefinition
        targetField: string

# 在 FieldMapping 中使用：
FieldMapping:
  structures:
    - sourceField: string
    - target: TargetSlot  # 旧: targetAttribute: IRI
    - transformation: TransformationExpression
```

#### P0-7: MoneyType/QuantityType OWL 投影修正

**问题**：声明 `owlProjection.kind: datatype`，但有多个字段，不能直接投影为 OWL datatype property

**修正方案 A**：改为值对象类
```yaml
MoneyType:
  owlProjection:
    kind: structuredValueClass  # 旧: datatype
    classIri: "{BASE_IRI}/values/MonetaryAmount"
    properties:
      - predicateIri: "{BASE_IRI}/properties/hasAmount"
        range: xsd:decimal
      - predicateIri: "{BASE_IRI}/properties/hasCurrency"
        range: "{BASE_IRI}/datatypes/CurrencyCode"
      - predicateIri: "{BASE_IRI}/properties/hasScale"
        range: xsd:integer
```

**修正方案 B**：定义可规范化字面量编码
```yaml
MoneyType:
  owlProjection:
    kind: customDatatype
    datatypeIri: "{BASE_IRI}/datatypes/Money"
    literalEncoding: "ISO4217_AMOUNT"  # 例: "USD 123.45"
    canonicalizationRule: "{currency} {amount with scale digits}"
    baseType: xsd:string
```

**采纳**：方案 A（值对象类），因为金融系统需要独立验证币种、精度

#### P0-8: 双时间模型增强

**问题**：仅有 `recordedAt`，不足以做严格 Point-in-Time 回测

**修正**：
```yaml
# 在 cross-domain-patterns.yaml 的 TemporalFact 中改为：
TemporalFact:
  injectedAttributes:
    # 业务有效时间（Valid Time）
    - attributeRef: "{BASE_IRI}/attributes/validFrom"
      valueType: datetime
      minCount: 1
      maxCount: 1
      description: "业务事实在真实世界中开始成立的时间"
    
    - attributeRef: "{BASE_IRI}/attributes/validTo"
      valueType: datetime
      minCount: 0
      maxCount: 1
      description: "业务事实在真实世界中结束成立的时间（null = 仍然有效）"
    
    # 知识时间（Knowledge Time / Transaction Time）
    - attributeRef: "{BASE_IRI}/attributes/knowledgeFrom"
      valueType: datetime
      minCount: 1
      maxCount: 1
      description: "平台开始认为此版本成立的时间（写入时间）"
    
    - attributeRef: "{BASE_IRI}/attributes/knowledgeTo"
      valueType: datetime
      minCount: 0
      maxCount: 1
      description: "平台认为此版本失效的时间（null = 当前版本，未被更新或撤回）"
    
    # 辅助时间字段
    - attributeRef: "{BASE_IRI}/attributes/observedAt"
      valueType: datetime
      minCount: 0
      maxCount: 1
      description: "观测/测量发生的时间（用于市场数据）"
    
    - attributeRef: "{BASE_IRI}/attributes/publishedAt"
      valueType: datetime
      minCount: 0
      maxCount: 1
      description: "数据供应方发布的时间"
    
    - attributeRef: "{BASE_IRI}/attributes/availableAt"
      valueType: datetime
      minCount: 0
      maxCount: 1
      description: "数据在平台可被策略使用的时间（考虑延迟和授权）"

  # asOf 查询语义（正式化）
  asOfQuerySemantics:
    description: "Point-in-Time 查询的语义规范"
    parameters:
      - name: asOfKnowledge
        type: datetime
        description: "在知识时间轴的哪个点查询（默认：now）"
      - name: asOfValid
        type: datetime
        description: "在业务时间轴的哪个点查询（默认：asOfKnowledge）"
    
    logicalQuery: |
      SELECT *
      FROM facts
      WHERE knowledgeFrom <= :asOfKnowledge
        AND (knowledgeTo IS NULL OR knowledgeTo > :asOfKnowledge)
        AND validFrom <= :asOfValid
        AND (validTo IS NULL OR validTo > :asOfValid)
      ORDER BY knowledgeFrom DESC
      LIMIT 1 PER logical_key
    
    constraints:
      - name: NoFutureKnowledge
        rule: "knowledgeFrom <= current_timestamp"
      - name: ValidIntervalConsistency
        rule: "validFrom < validTo OR validTo IS NULL"
      - name: KnowledgeIntervalConsistency
        rule: "knowledgeFrom < knowledgeTo OR knowledgeTo IS NULL"
```

#### P0-9: Layer 4 行为编排移除

**问题**：`IngestionPipeline` 包含 `schedule`、`retry`、`monitoring`，破坏四层边界

**修正**：
```yaml
# 在 data-binding-meta-model.yaml 中简化：
MaterializationPlan:
  description: "物化计划：声明式地描述如何将物理数据转换为知识图谱"
  structures:
    - iri: IRI
    - name: string
    - sourceDatasets: list[IRI]  # → Dataset
    - targetOntologyModule: IRI  # → OntologyModule
    - semanticMappings: list[IRI]  # → SemanticMapping
    - materializationMode: enum [Incremental, Full, CDC]
    - consistencyRequirement: enum [Eventual, Snapshot, Transactional]
    - validationRules: list[ConstraintBinding]

# 删除以下字段（移至运维层）：
# - schedule
# - retryPolicy
# - monitoringConfig
# - notificationRules

# 如需运行编排，应在独立的 orchestration/ 或 runtime/ 模块中定义
```

#### P0-10: 交易动作失败语义增强

**问题**：
- `SubmitOrder` 将 `CancelOrder` 当作补偿
- 支持外部重试，可能重复成交
- 超时后重试无幂等保护

**修正**：
```yaml
# 在 behavior-meta-model.yaml 的 ActionType 中增强：
ActionType:
  structures:
    # 原有字段...
    
    # 新增：命令回执
    - commandReceipt: CommandReceiptSchema
      description: "执行后必须返回的回执结构"
      structures:
        - commandId: string  # 平台生成的命令 ID
        - correlationId: string  # 关联 ID（跨系统追踪）
        - executionStatus: enum [Accepted, Rejected, Pending, Completed, Failed, Unknown]
        - externalReferenceId: string  # 外部系统返回的 ID
        - timestamp: datetime
    
    # 新增：幂等性强制规则
    - idempotencyKeyField: string  # 必填字段名称
      required: true
      description: "必须提供的幂等键字段（例: clientOrderId）"
    
    - idempotencyWindow: duration
      description: "幂等窗口：同一幂等键在此时间内重复提交视为同一命令"
    
    # 新增：不可逆性声明
    - irreversible: boolean
      description: "true = 此动作不可回滚（例: 订单已部分成交）"
    
    # 新增：未知结果对账策略
    - unknownResultReconciliation: ReconciliationStrategy
      enum: [ManualReview, QueryExternal, AssumeSuccess, AssumeFailed, HoldAndAlert]
    
    # 修正：补偿语义
    - compensatingActions: list[CompensatingActionRef]
      description: "补偿动作：当原动作已生效但需回退业务意图时"
      structures:
        CompensatingActionRef:
          - actionRef: IRI  # → ActionType
          - applicableWhen: enum [PartiallyExecuted, FullyExecuted, Unknown]
          - successGuarantee: enum [BestEffort, Guaranteed, RequiresManualIntervention]

# 具体示例：SubmitOrder
SubmitOrder:
  type: ActionType
  idempotencyKeyField: "clientOrderId"  # 必填
  idempotencyWindow: "PT24H"
  irreversible: true  # 一旦部分成交，不可回滚
  unknownResultReconciliation: QueryExternal
  
  compensatingActions:
    - actionRef: "{BASE_IRI}/actions/CancelOrder"
      applicableWhen: PartiallyExecuted
      successGuarantee: BestEffort  # 取消不保证成功（可能已全部成交）
    
    - actionRef: "{BASE_IRI}/actions/RequestManualReview"
      applicableWhen: Unknown
      successGuarantee: RequiresManualIntervention
  
  # 删除误导性的 rollback 字段
```

### 决策 3: 符号解析与模块系统正式化

**问题**：`namespace` 实际是短前缀，不是 namespace

**修正**：
```yaml
OntologyModule:
  structures:
    - moduleIri: IRI  # 模块的正式 IRI，例: {BASE_IRI}/finance/instruments
    - baseIri: IRI  # 此模块定义的元素的基础 IRI
    - preferredPrefix: string  # 短前缀，例: fin
    - version: SemanticVersion
    - imports: list[ModuleImport]
    - exports: list[IRI]  # 显式导出的符号

ModuleImport:
  structures:
    - moduleIri: IRI
    - version: SemanticVersion  # 锁定版本
    - artifactDigest: string  # SHA256(模块文件内容)
    - importType: enum [All, Selective]
    - importedSymbols: list[IRI]  # 仅 Selective 时
```

### 决策 4: 收敛顺序

按以下顺序逐步修正：

**阶段 1: P0 修复**（本 ADR）
1. 补齐未定义符号
2. ParameterDefinition 提升为 CallableParameterDefinition
3. Layer 2 引入正式 PatternDefinition
4. 删除 ObjectType.interfaces
5. 基数字段统一为 minCount/maxCount
6. TargetSlot 联合类型
7. MoneyType/QuantityType 改为值对象类
8. 双时间模型增强
9. MaterializationPlan 移除编排字段
10. ActionType 增强交易语义

**阶段 2: 元模型重构**（ADR-004）
1. 所有元类型重命名为 `*Definition`
2. 定义 JSON Schema for Meta-Model
3. TypeRef 语法与符号解析规则
4. 模块解析器与循环依赖检测

**阶段 3: 分层收束**（ADR-005 ~ ADR-008）
- ADR-005: Layer 1 语义核心收束
- ADR-006: Layer 2 跨域模式正式化
- ADR-007: Layer 3 行为模型收束
- ADR-008: Layer 4 数据绑定收束

**阶段 4: 验收样例**（ADR-009）
1. 证券标识分配（ISIN/CUSIP/LEI）
2. 市场价格观测（PriceObservation）
3. 持仓（Position with bi-temporal）
4. 订单—成交—撤单（Order + SubmitOrder Action）
5. 研究断言—证据—模型运行

## 后果

### 正面影响
- P0 阻断项解除，元模型可编译
- M3/M2/M1/M0 层级清晰，不再混淆
- 符号解析、模式注入、映射目标、交易语义均已正式化

### 负面影响
- 大量字段重命名，需要更新所有引用
- 增加复杂度（PatternDefinition、TargetSlot、CommandReceipt 等）
- 现有示例需要全部重写

### 风险
- 修改范围大，可能引入新的不一致性
- 需要配套的模式验证器和编译器原型

## 参考

- 评审意见（2026-07-28）
- ADR-001: 本体元模型架构
- ADR-002: IRI 命名空间策略
- W3C N-ary Relations: https://www.w3.org/TR/swbp-n-aryRelations/
- OWL 2 Structural Specification: https://www.w3.org/TR/owl2-syntax/
- SKOS Reference: https://www.w3.org/TR/skos-reference/
- PROV-O: https://www.w3.org/TR/prov-o/
- R2RML: https://www.w3.org/TR/r2rml/
- FIBO: https://spec.edmcouncil.org/fibo/

## 附录：修改影响范围

### 需要修改的文件
1. `ontology/meta/core-meta-model.yaml` - 所有元类型重命名 + 补齐定义
2. `ontology/meta/cross-domain-patterns.yaml` - PatternDefinition + 双时间增强
3. `ontology/meta/behavior-meta-model.yaml` - CallableParameterDefinition + ActionType 增强
4. `ontology/meta/data-binding-meta-model.yaml` - TargetSlot + MaterializationPlan 简化

### 向后兼容性
**不兼容变更**：
- 所有元类型名称变更
- 基数字段 `{min, max}` → `minCount/maxCount`
- `targetAttribute` → `target: TargetSlot`
- `ParameterDefinition` → `CallableParameterDefinition`

**迁移路径**：
- 提供自动化重命名脚本
- 保留旧字段 3 个月，标记 `deprecated: true`
