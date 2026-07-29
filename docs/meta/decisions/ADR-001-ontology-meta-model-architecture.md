# ADR-001: 本体元模型架构

**状态**: 已接受  
**日期**: 2026-07-28  
**决策者**: 项目团队  
**替代**: 初始原型 core-meta-model.yaml v0.1

---

## 背景

初始元模型原型（v0.1）将语义本体、数据验证和平台能力混合在单一层次中。这阻止了向量化研究和交易领域的清晰扩展，在这些领域中，时间语义、来源、多方关系和动作执行是一等公民关注点。

## 决策

### 1. 四层架构

```
Layer 1: 语义核心（Semantic Core）
  - OntologyModule, ObjectType, ValueType, AttributeType
  - RelationType（二元语义关系）
  - AssociationType（可具体化的 n 元关系，带上下文）
  - ConstraintDefinition, Alignment

Layer 2: 跨领域事实模式（Cross-Domain Fact Patterns）
  - Identity（IRI + namespace + localName）
  - Classification（代码列表、分类法）
  - Temporal（validTime, knowledgeTime, observedAt）
  - Provenance（来源、证据、置信度、修订）
  - Evidence, Lifecycle

Layer 3: 平台行为（Platform Behavior）
  - QueryType（只读查询）
  - FunctionType（无副作用计算）
  - ActionType（交易动作，带授权、前后置条件、补偿）
  - PolicyType（授权、审批）

Layer 4: 数据绑定（Data Binding）
  - DataSource, Dataset, Field
  - Transformation, SemanticMapping
```

### 2. AssociationType 用于 N 元关系

**理由**: 许多金融事实无法建模为二元边：
- 价格观察需要工具、市场、时间戳、来源、置信度
- 持仓需要账户、组合、工具、数量、成本基准、有效期
- 订单执行需要策略、审批、账户、经纪商、订单、成交、审计跟踪

**设计**:
- AssociationType 在 OWL 中投影为 `owl:Class`（标准具体化模式）
- 具有带类型范围和基数的 `participantRoles`
- 绑定跨领域模式（Temporal, Provenance）而非重复字段
- 仅当关系本身需要标识、上下文或生命周期时才提升为 AssociationType

**示例**:
- PriceObservation: AssociationType
- Holding: AssociationType 或 Position ObjectType（取决于批处理/生命周期需求）
- Order: ObjectType（由 SubmitOrder ActionType 创建）
- Execution: AssociationType / Event
- ResearchAssertion: Assertion ObjectType，带 Association 风格的参与者

**参考**: [W3C N-ary Relations](https://www.w3.org/TR/swbp-n-aryRelations/)

### 3. 身份标识: IRI + Namespace + LocalName

**问题**: 裸的 `id: "Equity"` 没有命名空间，无法保证全局唯一性。

**决策**:
```yaml
ObjectType:
  iri: {BASE_IRI}/finance/Equity  # 全局唯一（IRI 策略待 ADR-002 决定）
  namespace: fin
  localName: Equity
```

- IRI 是稳定的标识
- localName 只需在命名空间内唯一
- 遵循 FIBO 和 W3C 最佳实践

**注意**: 最终 IRI 命名空间设计推迟到 ADR-002。

### 4. OWL 投影与对齐的分离

**问题**: `fiboMapping: owl:Class` 混合了 OWL 类型投影与 FIBO 对齐，且产生矛盾（owl:Class 不是 FIBO URI）。

**决策**:
```yaml
ObjectType:
  owlProjection:
    kind: class  # 或 individual, property
  alignments:
    - vocabulary: FIBO
      version: "2026Q1"
      targetIri: https://spec.edmcouncil.org/fibo/ontology/SEC/Equity/EquityInstruments/Equity
      relation: exactMatch  # 或 closeMatch, subClassOf 等
      rationale: "直接语义等价"
      verification: reviewed
      verifiedBy: ontology-team
      verifiedAt: 2026-07-28
```

- `owlProjection` 定义如何生成 OWL/RDF
- `alignments` 是可选的、可审计的，支持多个词汇表
- 适当使用 SKOS 匹配关系：
  - `skos:closeMatch` — 语义相关，可发现
  - `skos:exactMatch` — 高置信度等价（但非 OWL 逻辑等价）
  - `rdfs:subClassOf` / `rdfs:subPropertyOf` — 本地概念更窄
  - `owl:equivalentClass` / `owl:equivalentProperty` — 证明的形式等价

**参考**: [SKOS Reference](https://www.w3.org/TR/skos-reference/)

### 5. 值类型系统

**问题**: 将 `string`、`number`、`isin`、`amount`、`currency` 混合在一个枚举中会丢失语义精度。金融金额、百分比、基点和数量必须是不同的类型。

**决策**:
```yaml
ValueType:        # 基础类型
  - string, decimal, integer, boolean, date, instant, duration, uri

IdentifierType:   # 带验证器的标准标识符
  - ISIN, CUSIP, LEI, SEDOL
  - 包含: standard, validator, issuingAuthority

QuantityType:     # 值 + 单位 + 精度
  - value: decimal
  - unit: string
  - precision, rounding

MoneyType:        # 金额（不是通用 number）
  - amount: decimal
  - currency: CurrencyCode
  - scale: integer

CodeListType:     # 受控词汇表
  - vocabulary, version, maintainer
```

**禁止对金融金额使用通用 `number`。**

### 6. 基数: RelationUse 的出站/入站

**问题**: `sourceCardinality` / `targetCardinality` 含义模糊。

**决策**:
```yaml
RelationUse:
  relation: fin:isIssuedBy
  subjectType: fin:Equity
  objectType: fin:Organization
  outboundCardinality: {min: 1, max: 1}   # 一个 Equity → 多少个 Organizations
  inboundCardinality: {min: 0, max: null} # 一个 Organization ← 多少个 Equities
```

- 使用 `max: null`（不是 `-1`）表示无界
- `min: 0` 是默认值，可省略
- 基数是上下文相关的（RelationUse），不是全局的（RelationType），因为子类可能有不同的约束

**OWL vs SHACL**:
- OWL 基数限制是开放世界公理（用于推理）
- SHACL 验证闭世界完整性（数据必须显式满足约束）

**参考**: [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/), [SHACL](https://www.w3.org/TR/shacl/)

### 7. ConstraintDefinition: 定义与绑定分离

**问题**: 混合规则定义、目标、严重性和阶段会阻止重用和审计。

**决策**:
```yaml
ConstraintDefinition:
  iri: fin:constraint:IsinLexicalFormat
  version: 1.0.0
  status: approved
  scope: data  # metamodel | data | action
  implementation:
    engine: shacl-core
    artifactRef: constraints/isin.ttl
    artifactDigest: sha256:...
    entrypoint: fin:IsinShape
  parametersSchema: {}
  testSuite:
    - fixtureRef: tests/isin-valid.ttl
      expectedConforms: true
  governance:
    ownerRef: fin:OntologyTeam
    approvedBy: fin:DataGovernanceRole
    approvedAt: 2026-07-28
    rationale: "ISO 6166 词法规则"

ConstraintBinding:
  definition: fin:constraint:IsinLexicalFormat
  targetSelector:
    class: fin:Instrument
    path: fin:hasISIN
  severity: violation
  enforcementMode: blocking  # blocking | reporting | monitoring
  trigger: ingest            # compile | ingest | preCommit | runtime
```

**关键点**:
- `ConstraintDefinition` 可重用、有版本、可测试
- `ConstraintBinding` 将其应用到特定目标，带执行策略
- Python 验证器必须锁定版本、摘要、沙箱化（不是本体语义）
- 区分词法格式检查与校验和验证

### 8. 时间语义: 四个时间戳

**决策**:
```yaml
时间模式:
  validTime: [validFrom, validTo]  # 事实在现实/市场中成立的时间
  knowledgeTime: [recordedAt]      # 平台记录此版本的时间
  observedAt: Instant              # 来源观察/测量的时间
  publishedAt: Instant             # 来源发布的时间（Provenance）
  receivedAt: Instant              # 平台接收的时间（Provenance）
```

- `validTime` — 业务时间（双时态数据库）
- `knowledgeTime` / `systemTime` — 系统时间（用于时点查询）
- `observedAt` — 来源观察时间戳
- `publishedAt` / `receivedAt` — 来源时间戳

**与 Qlib 时点正确性要求对齐。**

### 9. 跨领域模式作为绑定，而非混入

**问题**: 将 Temporal、Provenance 视为 `aspects` 会在"它是什么"（语义）和"它必须有什么"（验证）之间产生混淆。

**决策**:
- Temporal、Provenance、Evidence、Identity、Lifecycle 是 **Layer 2 模式**
- 它们通过 `patternBindings` 绑定到 ObjectType 或 AssociationType：
  ```yaml
  AssociationType:
    id: PriceObservation
    patternBindings:
      - pattern: fin:TemporalFact
      - pattern: fin:ProvenancedFact
  ```
- 生成 SHACL 形状用于验证，而非 OWL 类继承（除非语义上有理由）

### 10. 平台行为层分离

**决策**:
- 从语义核心中移除 `InterfaceType`
- 引入 Layer 3：
  - `QueryType` — 只读查询
  - `FunctionType` — 纯函数
  - `ActionType` — 交易动作，具有：
    - 授权/审批
    - 前置条件/后置条件
    - 幂等性
    - 审计事件
    - 回滚/补偿语义

**Order vs SubmitOrder**:
- `Order` 是领域 ObjectType（业务事实）
- `SubmitOrder` 是 ActionType（平台行为）

### 11. 无冗余链接维护

**问题**: `ObjectType.links` 重复了 `LinkType.sourceType` / `targetType` 中已有的信息。

**决策**:
- 从 ObjectType 中移除 `links` 字段
- 编译器从 LinkType 定义生成反向索引
- 单一事实来源

---

## 后果

### 正面影响
- 关注点清晰分离（语义/验证/行为/数据）
- AssociationType 支持带上下文的金融事实
- 身份系统支持联邦本体
- 对齐系统可审计且版本锁定
- 约束系统可测试且可重用
- 时间语义支持时点查询（Qlib 要求）

### 负面影响
- 比扁平单文件原型更复杂
- 需要编译器/验证器工具
- 贡献者学习曲线

### 中性影响
- 必须物理分割为 4 个元模型文件
- 重大设计决策需要 ADR

---

## 验证

验收的五个测试用例：
1. **证券标识**: ISIN、CUSIP、LEI 带验证器
2. **市场报价**: PriceObservation 带工具、市场、时间、来源
3. **持仓**: Position 带账户、工具、数量、成本基准、有效性
4. **订单执行**: Order ObjectType + SubmitOrder ActionType + Execution 事件
5. **研究断言**: Statement 带假设、证据、数据版本、模型运行、置信度

---

## 参考资料

- [W3C N-ary Relations](https://www.w3.org/TR/swbp-n-aryRelations/)
- [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/)
- [SHACL Recommendation](https://www.w3.org/TR/shacl/)
- [SKOS Reference](https://www.w3.org/TR/skos-reference/)
- [FIBO Official Overview](https://spec.edmcouncil.org/fibo/)
- [FIBO isIssuedBy](https://spec.edmcouncil.org/fibo/ontology/FND/Relations/Relations/isIssuedBy?version=master%2F2026Q1)
- [ISO 704:2022 Terminology Principles](https://www.iso.org/standard/38109.html)
