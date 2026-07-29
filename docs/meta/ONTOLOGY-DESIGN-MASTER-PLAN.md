# Axiolune 本体设计总体规划

**状态：** 设计草案  
**所有者：** TBD  
**创建日期：** 2026-07-28  
**目标成熟度：** M3 (Validated System)  
**风险等级：** S3 (High)  
**质量等级：** QA-L4 (Enterprise Financial Platform)

---

## 执行摘要

Axiolune 是一个**本体驱动的金融投研与运营平台**。本文档整合了项目计划、本体平台策略、设计优先策略和2周冲刺计划，形成完整的本体设计路线图。

### 核心战略

1. **本体优先** — 先建立稳定、可扩展的本体框架，再连接数据和前后端
2. **参考成熟实践** — 深度对齐 Palantir Foundry、FIBO、Apache Ossie 等成熟本体工程方法
3. **垂直切片交付** — 每个阶段产出可演示的完整垂直切片，避免"什么都有但什么都不能用"
4. **严格扩展机制** — 建立明确的元模型和扩展规范，确保"添加新类型不会牵一发而动全身"

### 关键挑战

1. **动态本体复杂性** — 本体不是静态 Schema，而是运行时类型系统 + 动作引擎 + 工具链
2. **多层抽象** — 从 ValueType → Interface → ObjectType → Link → Function → Action → Policy 共7层
3. **Interface 能力继承** — 如何让 Interface 提供真正的能力（查询、函数、约束），而不只是属性集合
4. **Action 动态执行** — 如何让 Action 可以操作任意对象类型，同时保持严格的验证和审计

### 解决方案框架

**"单继承骨架 + Aspect 组合 + 动态绑定"模式**

- **分类层**：严格单继承树（Instrument → Equity → CommonStock）
- **能力层**：多 Aspect/Interface 组合（Temporal + Tradable + Sourced）
- **动态绑定**：基于 OWL equivalentClass 和 SHACL 规则的运行时解析

---

## 第一部分：本体方法与元模型

### 1.1 本体定位：运行时决策契约

参考 Palantir 官方定义，本体是组织的 **operational layer**，不仅包含语义元素（objects/properties/links），还包含动力学元素（actions/functions/dynamic security）。

**本体 = Language + Engine + Toolchain**

#### Language（语言层）
定义组织能"说什么、算什么、做什么"：
- **类型系统**：ValueType、ObjectType、InterfaceType、LinkType、EventType
- **计算系统**：MetricType、FunctionType、ModelType
- **动作系统**：ActionType、Policy、WorkflowType
- **视图系统**：ViewType、Dashboard、Report

#### Engine（引擎层）
使定义成为可运行能力：
- 类型注册与发布
- 标识解析与对象解析
- 链接查询与图遍历
- 派生属性/指标计算
- 动作执行、审批、策略决策
- 双时间、血缘、质量管理
- 权限裁剪与访问控制
- 搜索、向量、分析投影

#### Toolchain（工具链层）
支持建设与消费：
- Ontology Studio（本体设计工具）
- 分支、Diff、评审、迁移
- SDK 生成（TypeScript/Java/Python）
- Schema 导出（OpenAPI/GraphQL/Protobuf）
- 契约测试与文档生成
- 数据目录、血缘可视化

### 1.2 三部分结构的实现映射

| 部分 | 实现组件 | 交付物 |
|---|---|---|
| **Language** | `ontology/` YAML 定义 | 类型定义、Schema、规则 |
| **Engine** | `packages/core/` Python 核心 | TypeRegistry、ObjectResolver、ActionExecutor |
| **Toolchain** | `tools/`、`cli/` | 验证器、生成器、CLI |

### 1.3 元模型：定义"如何定义本体"

**核心原则**：元模型必须是完整、可验证、可扩展的。

#### 层次 0：ValueType（值类型）
基础值类型，带单位和约束：

```yaml
ValueType:
  id: Money
  base: struct
  fields:
    amount: {type: decimal, required: true}
    currency: {type: CurrencyCode, required: true}
  validation:
    - amount_positive

ValueType:
  id: Percentage
  base: decimal
  validation:
    min: 0.0
    max: 1.0
  display:
    format: "{value:.2%}"
```

#### 层次 1：InterfaceType/Aspect（能力接口）
跨对象的多态能力，**关键创新：Interface 附带可执行的 capabilities**：

```yaml
InterfaceType:
  id: Temporal
  description: 具有有效时间段的对象
  properties:
    validFrom: {type: Instant, required: true}
    validTo: {type: Instant, nullable: true}
  
  capabilities:
    queries:
      - name: asOf
        description: 查询特定时间点的对象状态
        parameters:
          timestamp: Instant
        returns: Object
        implementation:
          type: sql
          template: |
            SELECT * FROM {table}
            WHERE id = :object_id
            AND valid_from <= :timestamp
            AND (valid_to IS NULL OR valid_to > :timestamp)
    
    functions:
      - name: isValidAt
        parameters: {timestamp: Instant}
        returns: boolean
        implementation: |
          self.validFrom <= timestamp and 
          (self.validTo is None or self.validTo > timestamp)
    
    constraints:
      - name: valid_time_range
        type: shacl
        rule: |
          sh:property [
            sh:path :validTo ;
            sh:minExclusive [ sh:path :validFrom ]
          ]
```

**关键设计**：任何实现 `Temporal` Interface 的对象类型自动获得 `asOf` 查询、`isValidAt` 函数和时间范围约束验证。

#### 层次 2：ObjectType（对象类型）
业务实体定义，采用 **单继承 + 多 Aspect** 模式：

```yaml
ObjectType:
  id: Equity
  domain: instruments-markets
  baseClass: Instrument           # 单继承基类
  aspects: [Temporal, Tradable, Sourced, Evidenced]  # 多 Aspect 组合
  
  properties:
    isin: {type: ISIN, required: true}
    cusip: {type: string}
    shareClass: {type: string}
    dividendYield: {type: Percentage}
  
  primaryKey: id
  uniqueConstraints:
    - [isin, validFrom]
  
  indexes:
    - fields: [symbol, exchange]
    - fields: [validFrom, validTo]
```

**继承解析规则**：
1. 从 `baseClass` 继承所有属性（递归到根）
2. 从每个 `aspects` 获取声明的属性
3. 合并自身 `properties`
4. 检查命名冲突（同名属性必须类型兼容）

#### 层次 3：LinkType（关系类型）

```yaml
LinkType:
  id: listedOn
  source: Instrument              # 可以是 ObjectType 或 Interface
  target: Venue
  cardinality: many-to-many
  bidirectional: true
  inverseName: lists
  
  properties:
    listDate: {type: BusinessDate}
    delistDate: {type: BusinessDate, nullable: true}
    primaryListing: {type: boolean}
  
  temporal: true                  # Link 自身也有 validFrom/validTo
  evidenced: true                 # Link 需要来源证据
```

#### 层次 4：FunctionType（函数类型）

```yaml
FunctionType:
  id: calculatePortfolioNAV
  domain: portfolios-positions
  
  inputs:
    portfolio: {type: Portfolio, required: true}
    asOfDate: {type: BusinessDate, required: true}
    pricingSource: {type: string, default: "official"}
  
  outputs:
    nav: {type: Money}
    positions: {type: list<PositionValuation>}
  
  semantics:
    pure: false                   # 依赖外部价格数据
    deterministic: true           # 相同输入相同输出
    cacheable: true
    cacheKeyFields: [portfolio.id, asOfDate, pricingSource]
  
  execution:
    timeout: 30s
    retryable: true
  
  lineage:
    trackInputs: true
    trackDataSources: true
```

#### 层次 5：ActionType（动作类型）

```yaml
ActionType:
  id: RebalancePortfolio
  domain: portfolios-positions
  targetClass: Portfolio          # 作用于哪种对象
  
  parameters:
    targetWeights:
      type: map<InstrumentId, Percentage>
      required: true
      validation:
        - sum_equals: 1.0
        - all_positive
    executionAlgo:
      type: enum[TWAP, VWAP, POV, Arrival]
      default: TWAP
    reason:
      type: string
      maxLength: 500
  
  preconditions:
    - type: property_equals
      property: status
      value: "active"
      errorMessage: "只能调仓活跃组合"
    
    - type: has_capability
      aspect: Rebalanceable
      errorMessage: "该组合类型不支持调仓"
    
    - type: function_check
      function: hasAvailableCash
      parameters: {portfolio: $target}
      minValue: 0
  
  effects:
    - type: invoke_function
      function: calculateRebalanceOrders
      parameters:
        portfolio: $target
        targetWeights: $params.targetWeights
        algo: $params.executionAlgo
      storeResultAs: orders
    
    - type: create_objects
      objectType: ParentOrder
      fromList: $results.orders
      linkTo: $target
      linkType: generatedBy
    
    - type: update_property
      target: $target
      property: lastRebalanceAt
      value: $now
    
    - type: emit_event
      eventType: PortfolioRebalanced
      payload:
        portfolioId: $target.id
        orderCount: $results.orders.length
  
  authorization:
    requiredPermissions:
      - portfolio:rebalance
      - order:create
    approvalPolicy: two-person-rule
    approvers:
      - role: portfolio_manager
      - role: risk_manager
    quorum: 2
  
  execution:
    idempotencyKey: "{target.id}:{params.hash}:{date}"
    transactional: true
    timeout: 60s
    async: true
  
  audit:
    recordBefore: true
    recordAfter: true
    captureParameters: true
    sensitiveFields: []
```

**Action 执行流程**：
```
1. 验证参数类型与约束
2. 检查前置条件
3. 评估权限策略
4. 获取审批（如需要）
5. 执行 effects（事务内）
6. 记录审计日志
7. 发出事件
8. 返回 ActionResult
```

#### 层次 6：PolicyType（策略类型）

```yaml
PolicyType:
  id: portfolio_rebalance_policy
  domain: access-control
  
  rule:
    subject:
      type: Person
      condition: has_role("portfolio_manager")
    
    action: RebalancePortfolio
    
    resource:
      type: Portfolio
      condition: |
        resource.owner == subject.team OR
        subject in resource.authorizedUsers
    
    environment:
      - condition: environment == "production"
        requireApproval: true
      - condition: environment == "simulation"
        requireApproval: false
    
    constraints:
      - maxDailyRebalances: 5
      - maxTurnover: 0.5
      - tradingHours: "09:30-15:00"
  
  effect: allow
  priority: 100
```

#### 层次 7：WorkflowType（工作流类型）

```yaml
WorkflowType:
  id: factor_publication_workflow
  domain: research-factors
  
  trigger:
    actionType: PublishFactor
  
  stages:
    - id: point_in_time_check
      type: automated
      function: verifyPointInTimeCorrectness
      onFailure: reject
    
    - id: reproducibility_check
      type: automated
      function: reproduceBacktestRun
      timeout: 300s
      onFailure: flag_for_review
    
    - id: peer_review
      type: human
      assignTo: research_team
      requiredApprovals: 1
      sla: 2d
    
    - id: risk_review
      type: human
      assignTo: risk_team
      requiredApprovals: 1
      sla: 1d
    
    - id: publish
      type: automated
      action: PromoteFactorToProduction
```

### 1.4 元模型实现：TypeRegistry 核心

```python
class TypeRegistry:
    """本体类型注册表 - 框架核心"""
    
    def __init__(self):
        self._value_types: Dict[str, ValueTypeDefinition] = {}
        self._interfaces: Dict[str, InterfaceDefinition] = {}
        self._object_types: Dict[str, ObjectTypeDefinition] = {}
        self._link_types: Dict[str, LinkTypeDefinition] = {}
        self._function_types: Dict[str, FunctionTypeDefinition] = {}
        self._action_types: Dict[str, ActionTypeDefinition] = {}
        self._policy_types: Dict[str, PolicyTypeDefinition] = {}
        self._workflow_types: Dict[str, WorkflowTypeDefinition] = {}
    
    def load_from_yaml(self, ontology_path: str):
        """从 YAML 目录加载本体定义"""
        # 加载顺序很重要：ValueType → Interface → ObjectType → ...
        pass
    
    def register_object_type(self, definition: ObjectTypeDefinition):
        """注册对象类型，自动解析：
        - 从 baseClass 继承的属性
        - 从 aspects 继承的属性和能力
        - 计算完整的属性 Schema
        - 验证约束一致性
        """
        resolved = self._resolve_object_type(definition)
        self._object_types[definition.id] = resolved
    
    def get_effective_properties(self, object_type_id: str) -> Dict[str, PropertyDefinition]:
        """获取对象类型的完整属性（继承+Aspect+自身）"""
        obj_type = self._object_types[object_type_id]
        properties = {}
        
        # 1. 从基类继承
        if obj_type.baseClass:
            base_props = self.get_effective_properties(obj_type.baseClass)
            properties.update(base_props)
        
        # 2. 从 Aspects 继承
        for aspect_id in obj_type.aspects:
            aspect = self._interfaces[aspect_id]
            properties.update(aspect.properties)
        
        # 3. 自身属性
        properties.update(obj_type.properties)
        
        return properties
    
    def get_available_capabilities(self, object_type_id: str) -> List[Capability]:
        """获取对象类型可用的所有能力（从 Aspects 继承）"""
        obj_type = self._object_types[object_type_id]
        capabilities = []
        
        for aspect_id in obj_type.aspects:
            aspect = self._interfaces[aspect_id]
            capabilities.extend(aspect.capabilities.queries)
            capabilities.extend(aspect.capabilities.functions)
            capabilities.extend(aspect.capabilities.constraints)
        
        return capabilities
```

---

## 第二部分：领域模型与对象目录

### 2.1 领域划分与依赖规则

参考 `reference/axiolune-design-draft/docs/04-ontology/01-domain-model.md`，系统划分为以下领域：

| 域 | 回答的问题 | 主要对象 | 依赖关系 |
|---|---|---|---|
| **Organization & Access** | 谁、代表谁、在哪个环境做什么？ | Person, Team, Role, Entitlement | 无依赖（基础域） |
| **Parties** | 发行人、券商、托管是谁？ | LegalEntity, Issuer, Broker, Custodian | → Organization |
| **Instruments & Markets** | 交易什么、在哪交易？ | Instrument, Equity, Bond, Venue, Market | → Parties |
| **Products & Accounts** | 哪个产品、账户、通道？ | FundProduct, TradingAccount, AssetUnit | → Organization, Parties |
| **Portfolios & Positions** | 持有什么、目标是什么？ | Portfolio, Position, TargetPosition | → Products, Instruments |
| **Research & Factors** | 因子/模型如何产生？ | FactorDefinition, ModelVersion, BacktestRun | → Instruments, Portfolios |
| **Orders & Execution** | 意图如何变成成交？ | ParentOrder, ChildOrder, Execution | → Portfolios, Instruments |
| **Risk & Compliance** | 哪些限制、告警、例外？ | RiskRule, RiskAlert, Watchlist | → Orders, Positions |
| **Companies & Events** | 公司、财务、公告发生了什么？ | CompanyProfile, FinancialReport, CorporateEvent | → Instruments |
| **Information & Evidence** | 结论依据是什么？ | Document, Claim, EvidenceFragment | 被所有域引用 |
| **Product & Business** | 产品规模、渠道如何？ | DistributionChannel, ProductMetric | → Products |
| **Platform Governance** | 数据、模型、应用是否健康？ | DataAsset, ModelRelease, AgentRun | 管理所有域 |

**稳定依赖原则**：
- Organization & Access 可被所有域引用，但不包含业务对象
- Parties 与 Instruments 是基础参考域
- 高层域（Risk、Business）依赖低层域，反之不可
- 跨域引用通过 canonical ID，不直接依赖实现

### 2.2 核心对象类型定义

#### 2.2.1 Instrument（证券/工具）

**分类树（单继承）**：
```
Instrument (abstract)
├── Equity
│   ├── CommonStock
│   └── PreferredStock
├── FixedIncome
│   ├── Bond
│   │   ├── CorporateBond
│   │   ├── GovernmentBond
│   │   └── MunicipalBond
│   └── Note
├── Derivative
│   ├── FutureContract
│   ├── OptionContract
│   └── SwapContract
├── Fund
│   ├── MutualFund
│   ├── ETF
│   └── HedgeFund
└── Cash
    └── CurrencyPair
```

**Instrument 基类定义**：
```yaml
ObjectType:
  id: Instrument
  domain: instruments-markets
  abstract: true
  aspects: [Identified, Temporal, Classified, Governed]
  
  properties:
    symbol: {type: string, required: true}
    name: {type: string, required: true}
    currency: {type: CurrencyCode, required: true}
    instrumentType: {type: InstrumentTypeEnum, required: true}
    status: {type: InstrumentStatusEnum}
    issueDate: {type: BusinessDate}
    maturityDate: {type: BusinessDate, nullable: true}
  
  links:
    - issuedBy: Issuer
    - tradedOn: Venue (many-to-many)
    - classifiedAs: ClassificationMembership (many)
  
  metrics:
    - currentPrice: {function: getCurrentPrice}
    - dailyVolume: {function: getDailyVolume}
```

**Equity 具体类型**：
```yaml
ObjectType:
  id: Equity
  domain: instruments-markets
  baseClass: Instrument
  aspects: [Temporal, Tradable, Sourced, Evidenced]
  
  properties:
    isin: {type: ISIN, required: true}
    cusip: {type: string}
    sedol: {type: string}
    figi: {type: FIGI}
    shareClass: {type: string}
    dividendYield: {type: Percentage}
    sharesOutstanding: {type: integer}
  
  uniqueConstraints:
    - [isin, validFrom]
  
  indexes:
    - [symbol, exchange, validFrom]
    - [isin]
```

#### 2.2.2 Portfolio（组合）

```yaml
ObjectType:
  id: Portfolio
  domain: portfolios-positions
  aspects: [Identified, Temporal, Governed, Stateful]
  
  properties:
    name: {type: string, required: true}
    portfolioType: {type: enum[managed, model, benchmark]}
    baseCurrency: {type: CurrencyCode}
    strategy: {type: string}
    inceptionDate: {type: BusinessDate}
    status: {type: enum[active, suspended, closed]}
  
  links:
    - belongsToProduct: FundProduct
    - usesBenchmark: Instrument
    - hasPositions: Position (one-to-many)
    - hasTargets: TargetPosition (one-to-many)
    - authorizedFor: TradingAccount (many-to-many)
  
  derivedProperties:
    - nav: {function: calculateNAV, inputs: [asOfDate]}
    - totalExposure: {function: calculateExposure}
    - risk: {function: calculateVaR}
  
  availableActions:
    - RebalancePortfolio
    - AddTargetPosition
    - GenerateOrders
```

#### 2.2.3 ParentOrder（母单）

```yaml
ObjectType:
  id: ParentOrder
  domain: orders-execution
  aspects: [Identified, Temporal, Stateful, Evidenced, Auditable]
  
  properties:
    orderId: {type: string, required: true, unique: true}
    instruction: {type: OrderInstruction}
    side: {type: enum[buy, sell]}
    quantity: {type: Quantity, required: true}
    orderType: {type: OrderTypeEnum}
    limitPrice: {type: Price}
    algoProvider: {type: string}
    algoDefinition: {type: string}
    algoConfig: {type: json}
    environment: {type: EnvironmentEnum, required: true}
    
    # 状态
    state: {type: OrderStateEnum}
    filledQuantity: {type: Quantity}
    remainingQuantity: {type: Quantity}
    avgPrice: {type: Price}
    
    # 时间
    createdAt: {type: Instant}
    submittedAt: {type: Instant}
    completedAt: {type: Instant}
  
  links:
    - forInstrument: Instrument (required)
    - usesAccount: TradingAccount (required)
    - implementsInstruction: Instruction
    - hasChildren: ChildOrder (one-to-many)
    - evaluatedBy: RiskAssessment
  
  stateTransitions:
    - from: draft
      to: [validating, cancelled]
    - from: validating
      to: [awaiting_approval, denied, draft]
    - from: awaiting_approval
      to: [approved, denied]
    - from: approved
      to: [executing, cancelled]
    - from: executing
      to: [succeeded, partially_succeeded, failed, cancelled]
  
  availableActions:
    - SubmitOrder
    - CancelOrder
    - PauseOrder
    - ResumeOrder
```

#### 2.2.4 FactorDefinition（因子定义）

```yaml
ObjectType:
  id: FactorDefinition
  domain: research-factors
  aspects: [Identified, Versioned, Governed, Evidenced]
  
  properties:
    name: {type: string, required: true}
    hypothesis: {type: string}
    category: {type: FactorCategoryEnum}
    status: {type: enum[draft, reproducible, reviewed, published, deprecated]}
  
  links:
    - hasVersions: FactorVersion (one-to-many)
    - testedIn: BacktestRun (many)
    - usedBy: ModelVersion (many)

ObjectType:
  id: FactorVersion
  domain: research-factors
  aspects: [Identified, Versioned, Temporal, Evidenced]
  
  properties:
    version: {type: string, required: true}
    expression: {type: string, required: true}
    frequency: {type: FrequencyEnum}
    lag: {type: integer}
    universe: {type: UniverseDefinition}
    
    # 实现
    codeRepository: {type: URI}
    codeCommit: {type: string}
    dependencies: {type: list<string>}
    
    # 评估
    icMean: {type: decimal}
    icStd: {type: decimal}
    turnover: {type: decimal}
  
  links:
    - definitionOf: FactorDefinition
    - derivedFrom: DataAsset (many)
    - testedIn: BacktestRun (many)
  
  availableActions:
    - PublishFactor
    - RetireFactor
```

#### 2.2.5 RiskRule（风险规则）

```yaml
ObjectType:
  id: RiskRule
  domain: risk-compliance
  aspects: [Identified, Versioned, Temporal, Governed]
  
  properties:
    ruleName: {type: string, required: true}
    ruleType: {type: enum[hard_limit, soft_limit, warning, approval_required]}
    scope: {type: RuleScopeDefinition}
    
    # 条件
    condition: {type: ConditionExpression}
    threshold: {type: decimal}
    unit: {type: string}
    window: {type: Duration}
    
    # 行为
    action: {type: enum[block, warn, require_approval, notify]}
    severity: {type: enum[critical, high, medium, low]}
    
    # 生效
    effectiveFrom: {type: Instant}
    effectiveTo: {type: Instant}
    priority: {type: integer}
  
  links:
    - appliesTo: [Portfolio, Account, Instrument] (polymorphic)
    - hasExceptions: RiskException (one-to-many)
  
  availableActions:
    - ActivateRule
    - DeactivateRule
    - CreateException
```

### 2.3 核心 LinkType 定义

参考 `reference/axiolune-design-draft/docs/04-ontology/02-object-link-catalog.md`：

| LinkType | Source → Target | 基数 | 属性 | 时间语义 |
|---|---|---|---|---|
| `issuedBy` | Instrument → Issuer | N:1 | - | Temporal |
| `tradedOn` | Instrument → Venue | N:M | listDate, primaryListing | Temporal |
| `classifiedAs` | Instrument → ClassificationMembership | N:M | weight, source | Bitemporal |
| `constituentOf` | Instrument → Index | N:M | weight, rank | Bitemporal |
| `productHasPortfolio` | FundProduct → Portfolio | 1:N | role | Temporal |
| `portfolioUsesBenchmark` | Portfolio → Instrument | N:1 | - | Temporal |
| `portfolioHasPosition` | Portfolio → Position | 1:N | - | As-of snapshot |
| `positionInInstrument` | Position → Instrument | N:1 | - | Immutable |
| `portfolioHasTarget` | Portfolio → TargetPosition | 1:N | scenario | Temporal |
| `orderForInstrument` | Order → Instrument | N:1 | - | Immutable |
| `orderUsesAccount` | Order → TradingAccount | N:1 | - | Immutable |
| `parentHasChild` | ParentOrder → ChildOrder | 1:N | - | Immutable |
| `childHasExecution` | ChildOrder → Execution | 1:N | - | Immutable |
| `assessmentEvaluatesAction` | RiskAssessment → ActionRun | N:1 | - | Immutable |
| `alertAffectsObject` | RiskAlert → Identified | N:M | evidence | Temporal |
| `factorDerivedFromAsset` | FactorVersion → DataAsset | N:M | lineage | Versioned |
| `backtestEvaluatesFactor` | BacktestRun → FactorVersion | N:M | - | Immutable |
| `claimSupportedBy` | Claim → EvidenceFragment | N:M | support/contradict | Evidenced |

**关键设计原则**：
1. 金融事实的 Link 必须有 `validFrom`/`validTo`（如成分股、分类）
2. 交易事件的 Link 是不可变的（如 Order → Execution）
3. 复杂关系建成对象（如 ClassificationMembership、UniverseMembership）
4. Link 权限：查看 Link 需要同时有权查看起点和终点对象

---

## 第三部分：Interface 能力继承机制

### 3.1 核心 Interface 定义

#### Identified（可识别）
```yaml
InterfaceType:
  id: Identified
  description: 具有稳定标识符的对象
  
  properties:
    id: {type: string, required: true}
    canonicalId: {type: string, required: true}
    externalIdentifiers: {type: map<string, string>}
  
  capabilities:
    queries:
      - name: resolveIdentifier
        parameters:
          identifierType: string
          identifierValue: string
        returns: Object
        description: 通过外部标识符解析对象
```

#### Temporal（时间有效性）
```yaml
InterfaceType:
  id: Temporal
  description: 具有业务有效时间的对象
  
  properties:
    validFrom: {type: Instant, required: true}
    validTo: {type: Instant, nullable: true}
  
  capabilities:
    queries:
      - name: asOf
        parameters: {timestamp: Instant}
        returns: Object
        implementation:
          type: sql
          template: |
            SELECT * FROM {table}
            WHERE id = :object_id
            AND valid_from <= :timestamp
            AND (valid_to IS NULL OR valid_to > :timestamp)
      
      - name: history
        parameters:
          startTime: Instant
          endTime: Instant
        returns: List[Object]
        implementation:
          type: sql
          template: |
            SELECT * FROM {table}
            WHERE id = :object_id
            AND valid_from < :endTime
            AND (valid_to IS NULL OR valid_to > :startTime)
            ORDER BY valid_from
    
    functions:
      - name: isValidAt
        parameters: {timestamp: Instant}
        returns: boolean
        implementation: |
          self.validFrom <= timestamp and 
          (self.validTo is None or self.validTo > timestamp)
    
    constraints:
      - name: valid_time_range
        type: shacl
        rule: |
          :TemporalShape a sh:NodeShape ;
            sh:targetClass :Temporal ;
            sh:property [
              sh:path :validTo ;
              sh:minExclusive [ sh:path :validFrom ] ;
            ] .
```

#### Sourced（有来源）
```yaml
InterfaceType:
  id: Sourced
  description: 记录数据来源的对象
  
  properties:
    sourceId: {type: string, required: true}
    sourceRecord: {type: string}
    observedAt: {type: Instant}
    ingestedAt: {type: Instant}
    sourceQuality: {type: QualityScoreEnum}
  
  capabilities:
    queries:
      - name: lineage
        returns: LineageGraph
        description: 追踪数据血缘
    
    functions:
      - name: isFromSource
        parameters: {sourceId: string}
        returns: boolean
```

#### Tradable（可交易）
```yaml
InterfaceType:
  id: Tradable
  description: 可以交易的工具
  
  properties:
    tradingStatus: {type: TradingStatusEnum}
    tickSize: {type: decimal}
    lotSize: {type: integer}
    priceMultiplier: {type: decimal}
  
  capabilities:
    functions:
      - name: canTradeAt
        parameters: {timestamp: Instant}
        returns: boolean
        description: 检查在特定时间是否可交易
      
      - name: roundToTick
        parameters: {price: decimal}
        returns: decimal
        description: 按最小价位取整
```

#### Evidenced（有证据）
```yaml
InterfaceType:
  id: Evidenced
  description: 需要证据支持的对象
  
  properties:
    evidenceQuality: {type: enum[verified, plausible, unverified]}
    confidenceScore: {type: decimal}
  
  links:
    - supportedBy: EvidenceFragment (many)
  
  capabilities:
    queries:
      - name: getEvidence
        returns: List[EvidenceFragment]
    
    functions:
      - name: hasStrongEvidence
        returns: boolean
        implementation: |
          self.evidenceQuality == 'verified' and 
          self.confidenceScore >= 0.8
```

#### Stateful（有状态机）
```yaml
InterfaceType:
  id: Stateful
  description: 具有状态机的对象
  
  properties:
    state: {type: string, required: true}
    stateEnteredAt: {type: Instant}
    previousState: {type: string}
  
  links:
    - stateHistory: StateTransitionEvent (many)
  
  capabilities:
    functions:
      - name: canTransitionTo
        parameters: {targetState: string}
        returns: boolean
        description: 检查是否可以转换到目标状态
      
      - name: transitionTo
        parameters: {targetState: string, reason: string}
        returns: StateTransitionEvent
        description: 执行状态转换
    
    constraints:
      - name: valid_state_transitions
        type: custom
        validator: validateStateTransition
```

### 3.2 Interface 能力引擎实现

```python
class InterfaceCapabilityEngine:
    """执行 Interface 附带的能力"""
    
    def __init__(self, registry: TypeRegistry):
        self.registry = registry
    
    def execute_interface_query(
        self,
        object_type_id: str,
        query_name: str,
        params: dict
    ):
        """执行 Interface 定义的查询"""
        
        # 1. 获取对象类型实现的所有 Interface
        obj_type = self.registry.get_object_type(object_type_id)
        
        # 2. 查找声明了该查询的 Interface
        query_def = None
        for aspect_id in obj_type.aspects:
            aspect = self.registry.get_interface(aspect_id)
            for query in aspect.capabilities.queries:
                if query.name == query_name:
                    query_def = query
                    break
        
        if not query_def:
            raise UndefinedCapabilityError(
                f"Query '{query_name}' not defined for {object_type_id}"
            )
        
        # 3. 执行查询实现
        if query_def.implementation.type == "sql":
            return self._execute_sql_query(
                object_type_id,
                query_def.implementation.template,
                params
            )
        elif query_def.implementation.type == "function":
            return self._execute_function_query(
                query_def.implementation.function,
                params
            )
        else:
            raise NotImplementedError()
    
    def execute_interface_function(
        self,
        object_instance: Any,
        function_name: str,
        params: dict
    ):
        """在对象实例上执行 Interface 函数"""
        
        # 获取对象类型
        obj_type = self.registry.get_object_type(object_instance.__class__.__name__)
        
        # 查找函数定义
        function_def = None
        for aspect_id in obj_type.aspects:
            aspect = self.registry.get_interface(aspect_id)
            for func in aspect.capabilities.functions:
                if func.name == function_name:
                    function_def = func
                    break
        
        if not function_def:
            raise UndefinedCapabilityError(
                f"Function '{function_name}' not defined for {obj_type.id}"
            )
        
        # 执行函数（可以是 Python 代码或表达式）
        return self._execute_function(function_def, object_instance, params)
```

---

## 第四部分：Action 动态执行框架

# Axiolune 本体设计总体规划（第二部分）

本文档接续 `ONTOLOGY-DESIGN-MASTER-PLAN.md`

---

## 第四部分：Action 动态执行框架

### 4.1 Action 执行面临的挑战

**核心问题**：如何让 Action 能操作任意对象类型，同时保持严格的验证、审批、审计？

**反模式示例**（硬编码每个 Action）：
```python
def rebalance_portfolio(portfolio_id, target_weights):
    # 每个 Action 都要写大量代码
    portfolio = get_portfolio(portfolio_id)
    if portfolio.status != "active":
        raise Error("只能调仓活跃组合")
    if not check_permission(current_user, "rebalance", portfolio):
        raise PermissionDenied()
    # ... 100 行业务逻辑
```

**目标**：Action 定义在 YAML 中，框架自动执行验证、权限、审批、业务逻辑、审计。

### 4.2 Action 定义规范

**完整的 ActionType 定义必须包含**：

1. **元数据**：id、domain、targetClass、description、owner
2. **参数定义**：parameters（类型、必需、约束、默认值）
3. **前置条件**：preconditions（属性检查、能力检查、函数检查）
4. **执行效果**：effects（调用函数、创建对象、更新属性、发出事件）
5. **授权策略**：requiredPermissions、approvalPolicy、approvers
6. **执行语义**：idempotencyKey、transactional、async、timeout
7. **审计配置**：recordBefore、recordAfter、sensitiveFields

**示例**：参见第一部分 1.3 节 ActionType 定义。

### 4.3 Action 执行器实现

```python
class ActionExecutor:
    """通用 Action 执行器 - 关键：不需要为每个 Action 写代码"""
    
    def __init__(
        self,
        registry: TypeRegistry,
        policy_engine: PolicyEngine,
        audit_service: AuditService
    ):
        self.registry = registry
        self.policy_engine = policy_engine
        self.audit_service = audit_service
    
    def execute_action(
        self,
        action_id: str,
        target_object_id: str,
        params: dict,
        actor: str,
        context: ExecutionContext
    ) -> ActionResult:
        """执行 Action 的完整流程"""
        
        # 1. 获取 Action 定义
        action_def = self.registry.get_action_type(action_id)
        
        # 2. 验证参数
        validation_result = self._validate_parameters(action_def, params)
        if not validation_result.is_valid:
            raise ActionValidationError(validation_result.errors)
        
        # 3. 加载目标对象
        target = self._load_target_object(target_object_id)
        
        # 4. 检查对象类型匹配
        if not self._matches_target_class(target, action_def.targetClass):
            raise ActionValidationError(
                f"对象类型 {target.__class__} 不匹配 {action_def.targetClass}"
            )
        
        # 5. 检查前置条件
        precondition_result = self._check_preconditions(
            action_def,
            target,
            params,
            context
        )
        if not precondition_result.passed:
            raise PreconditionFailedError(precondition_result.failed_conditions)
        
        # 6. 评估权限
        policy_decision = self.policy_engine.evaluate(
            subject=actor,
            action=action_id,
            resource=target,
            context=context
        )
        if policy_decision.effect != "allow":
            raise PermissionDeniedError(policy_decision.reason)
        
        # 7. 检查是否需要审批
        if action_def.authorization.approvalPolicy:
            approval_required = self._check_approval_required(
                action_def,
                actor,
                target,
                params,
                context
            )
            if approval_required:
                # 创建审批任务
                approval_task = self._create_approval_task(
                    action_def,
                    target,
                    params,
                    actor
                )
                return ActionResult(
                    status="pending_approval",
                    approval_task_id=approval_task.id
                )
        
        # 8. 记录审计（执行前）
        audit_id = self.audit_service.record_action_start(
            action_id=action_id,
            actor=actor,
            target=target,
            params=params,
            context=context
        )
        
        # 9. 执行 effects（事务内）
        try:
            with transaction():
                results = []
                for effect in action_def.effects:
                    effect_result = self._execute_effect(
                        effect,
                        target,
                        params,
                        context,
                        previous_results=results
                    )
                    results.append(effect_result)
                
                # 10. 记录审计（执行后）
                self.audit_service.record_action_success(
                    audit_id=audit_id,
                    results=results,
                    target_after=target
                )
                
                return ActionResult(
                    status="succeeded",
                    results=results,
                    audit_id=audit_id
                )
        
        except Exception as e:
            # 11. 记录失败
            self.audit_service.record_action_failure(
                audit_id=audit_id,
                error=e
            )
            raise
    
    def _validate_parameters(
        self,
        action_def: ActionTypeDefinition,
        params: dict
    ) -> ValidationResult:
        """验证参数类型、必需性、约束"""
        errors = []
        
        # 检查必需参数
        for param_name, param_def in action_def.parameters.items():
            if param_def.required and param_name not in params:
                errors.append(f"缺少必需参数: {param_name}")
        
        # 检查未定义参数
        for param_name in params.keys():
            if param_name not in action_def.parameters:
                errors.append(f"未定义的参数: {param_name}")
        
        # 检查参数类型
        for param_name, param_value in params.items():
            if param_name in action_def.parameters:
                param_def = action_def.parameters[param_name]
                if not self._validate_type(param_value, param_def.type):
                    errors.append(
                        f"参数 {param_name} 类型错误: "
                        f"期望 {param_def.type}，实际 {type(param_value)}"
                    )
        
        # 检查自定义约束
        for param_name, param_value in params.items():
            if param_name in action_def.parameters:
                param_def = action_def.parameters[param_name]
                if param_def.validation:
                    for constraint in param_def.validation:
                        if not self._validate_constraint(param_value, constraint):
                            errors.append(
                                f"参数 {param_name} 违反约束: {constraint}"
                            )
        
        return ValidationResult(
            is_valid=len(errors) == 0,
            errors=errors
        )
    
    def _check_preconditions(
        self,
        action_def: ActionTypeDefinition,
        target: Any,
        params: dict,
        context: ExecutionContext
    ) -> PreconditionResult:
        """检查前置条件"""
        failed = []
        
        for precondition in action_def.preconditions:
            if precondition.type == "property_equals":
                actual_value = getattr(target, precondition.property)
                if actual_value != precondition.value:
                    failed.append({
                        "condition": precondition,
                        "reason": f"{precondition.property} = {actual_value}, "
                                  f"期望 {precondition.value}",
                        "error_message": precondition.errorMessage
                    })
            
            elif precondition.type == "has_capability":
                obj_type = self.registry.get_object_type(target.__class__.__name__)
                if precondition.aspect not in obj_type.aspects:
                    failed.append({
                        "condition": precondition,
                        "reason": f"对象未实现 {precondition.aspect}",
                        "error_message": precondition.errorMessage
                    })
            
            elif precondition.type == "function_check":
                function_result = self._call_function(
                    precondition.function,
                    precondition.parameters
                )
                if not self._meets_threshold(
                    function_result,
                    precondition.get("minValue"),
                    precondition.get("maxValue")
                ):
                    failed.append({
                        "condition": precondition,
                        "reason": f"函数 {precondition.function} 返回 {function_result}",
                        "error_message": precondition.errorMessage
                    })
        
        return PreconditionResult(
            passed=len(failed) == 0,
            failed_conditions=failed
        )
    
    def _execute_effect(
        self,
        effect: EffectDefinition,
        target: Any,
        params: dict,
        context: ExecutionContext,
        previous_results: List[Any]
    ) -> Any:
        """执行一个 effect"""
        
        if effect.type == "invoke_function":
            # 调用函数
            function_params = self._resolve_parameters(
                effect.parameters,
                target=target,
                params=params,
                previous_results=previous_results
            )
            result = self._call_function(effect.function, function_params)
            return result
        
        elif effect.type == "create_object":
            # 创建对象
            object_type = effect.objectType
            object_data = self._resolve_parameters(
                effect.data,
                target=target,
                params=params,
                previous_results=previous_results
            )
            new_object = self._create_object(object_type, object_data)
            return new_object
        
        elif effect.type == "create_objects":
            # 批量创建对象
            object_type = effect.objectType
            objects_data = self._resolve_expression(
                effect.fromList,
                target=target,
                params=params,
                previous_results=previous_results
            )
            new_objects = [
                self._create_object(object_type, data)
                for data in objects_data
            ]
            return new_objects
        
        elif effect.type == "update_property":
            # 更新属性
            new_value = self._resolve_expression(
                effect.value,
                target=target,
                params=params,
                previous_results=previous_results
            )
            setattr(target, effect.property, new_value)
            return new_value
        
        elif effect.type == "create_link":
            # 创建链接
            link_type = effect.linkType
            source = target
            target_obj = self._resolve_expression(
                effect.target,
                target=target,
                params=params,
                previous_results=previous_results
            )
            link = self._create_link(link_type, source, target_obj)
            return link
        
        elif effect.type == "emit_event":
            # 发出事件
            event_payload = self._resolve_parameters(
                effect.payload,
                target=target,
                params=params,
                previous_results=previous_results
            )
            event = self._emit_event(effect.eventType, event_payload)
            return event
        
        else:
            raise NotImplementedError(f"Unknown effect type: {effect.type}")
```

### 4.4 Action 验证器

```python
class ActionValidator:
    """验证 Action 定义的完整性和一致性"""
    
    def validate_action_definition(
        self,
        action_def: ActionTypeDefinition
    ) -> ValidationResult:
        """验证 Action 定义"""
        errors = []
        warnings = []
        
        # 1. 检查 targetClass 是否存在
        if not self.registry.has_object_type(action_def.targetClass):
            errors.append(f"目标类型不存在: {action_def.targetClass}")
        
        # 2. 检查参数定义
        for param_name, param_def in action_def.parameters.items():
            if not self._is_valid_type(param_def.type):
                errors.append(f"参数 {param_name} 类型无效: {param_def.type}")
        
        # 3. 检查前置条件
        for precondition in action_def.preconditions:
            if precondition.type == "property_equals":
                # 检查属性是否存在于 targetClass
                obj_type = self.registry.get_object_type(action_def.targetClass)
                props = self.registry.get_effective_properties(obj_type.id)
                if precondition.property not in props:
                    errors.append(
                        f"前置条件引用不存在的属性: {precondition.property}"
                    )
            
            elif precondition.type == "has_capability":
                # 检查 aspect 是否存在
                if not self.registry.has_interface(precondition.aspect):
                    errors.append(f"前置条件引用不存在的 Aspect: {precondition.aspect}")
            
            elif precondition.type == "function_check":
                # 检查函数是否存在
                if not self.registry.has_function_type(precondition.function):
                    errors.append(f"前置条件引用不存在的函数: {precondition.function}")
        
        # 4. 检查 effects
        for effect in action_def.effects:
            if effect.type == "invoke_function":
                if not self.registry.has_function_type(effect.function):
                    errors.append(f"Effect 引用不存在的函数: {effect.function}")
            
            elif effect.type in ["create_object", "create_objects"]:
                if not self.registry.has_object_type(effect.objectType):
                    errors.append(f"Effect 引用不存在的对象类型: {effect.objectType}")
            
            elif effect.type == "update_property":
                obj_type = self.registry.get_object_type(action_def.targetClass)
                props = self.registry.get_effective_properties(obj_type.id)
                if effect.property not in props:
                    errors.append(f"Effect 引用不存在的属性: {effect.property}")
            
            elif effect.type == "create_link":
                if not self.registry.has_link_type(effect.linkType):
                    errors.append(f"Effect 引用不存在的链接类型: {effect.linkType}")
            
            elif effect.type == "emit_event":
                if not self.registry.has_event_type(effect.eventType):
                    warnings.append(f"Effect 引用的事件类型未定义: {effect.eventType}")
        
        # 5. 检查幂等键
        if action_def.execution.idempotencyKey:
            # 验证幂等键表达式合法
            if not self._is_valid_expression(action_def.execution.idempotencyKey):
                errors.append("幂等键表达式无效")
        
        return ValidationResult(
            is_valid=len(errors) == 0,
            errors=errors,
            warnings=warnings
        )
```

### 4.5 关键设计决策

**决策 1：Effect 执行顺序**
- effects 按定义顺序执行
- 后续 effect 可引用前面 effect 的结果（通过 `$results.<name>`）
- 所有 effects 在一个事务内执行

**决策 2：幂等性保证**
- 通过 `idempotencyKey` 避免重复执行
- 幂等键可以包含 target.id、params.hash、日期等
- 相同幂等键的请求返回原结果

**决策 3：异步执行**
- `async: true` 的 Action 立即返回 ActionRun ID
- 客户端通过 ActionRun ID 轮询或订阅结果
- 长时间运行的 Action（如批量处理）必须异步

**决策 4：补偿逻辑**
- Action 定义可包含 `compensation` 配置
- 执行失败时自动调用补偿 Action
- 补偿不保证成功，可能需要人工介入

---

## 第五部分：2周冲刺实施计划

### 5.1 总体策略

**基于你的反馈**：
- **时间**：2周（包括本周）
- **重点**：本体框架核心，探索成熟的扩展机制
- **参考**：Apache Ossie YAML 体系 + OWL/RDF 转换器
- **建模策略**：单继承骨架 + Aspect 多接口 + 动态绑定

### 5.2 Week 1：核心本体引擎（Day 1-7）

#### Day 1-3：元模型 + 类型注册表

**目标**：定义"如何定义本体"的规则

**任务清单**：

1. **创建元模型定义**（4小时）
   - `ontology/meta/core-meta-model.yaml`
   - 定义 ValueType、InterfaceType、ObjectType、LinkType 的元模型
   - 定义 FunctionType、ActionType、PolicyType 的元模型

2. **实现类型注册表**（8小时）
   ```python
   packages/core/src/ontology/
   ├── type_registry.py       # 核心注册表
   ├── meta_model.py          # 元模型 Pydantic 定义
   └── loader.py              # YAML 加载器
   ```

3. **实现本体验证器**（6小时）
   ```python
   packages/core/src/ontology/
   └── validator.py           # 验证本体定义一致性
   ```

4. **编写单元测试**（4小时）
   ```python
   tests/ontology/
   ├── test_meta_model.py
   ├── test_type_registry.py
   └── test_validator.py
   ```

**验收标准**：
```python
# 测试：加载本体定义
registry = TypeRegistry()
registry.load_from_yaml("ontology/")
assert registry.validate().is_valid()

# 测试：查询类型
equity_type = registry.get_object_type("Equity")
assert equity_type.baseClass == "Instrument"
assert "Temporal" in equity_type.aspects
```

---

#### Day 4-5：单继承分类树 + Aspect 机制

**目标**：实现严格的单继承骨架 + 灵活的 Aspect 组合

**任务清单**：

1. **定义证券分类树**（3小时）
   ```yaml
   ontology/taxonomies/instrument-taxonomy.yaml
   # Instrument (abstract)
   #   ├── Equity
   #   ├── Bond
   #   ├── Derivative
   #   └── Fund
   ```

2. **定义核心 Aspects**（4小时）
   ```yaml
   ontology/aspects/
   ├── temporal.yaml          # 时间有效性
   ├── tradable.yaml          # 可交易
   ├── sourced.yaml           # 有来源
   └── evidenced.yaml         # 有证据
   ```

3. **实现 Aspect 能力引擎**（8小时）
   ```python
   packages/core/src/ontology/
   └── aspect_engine.py       # 执行 Aspect 附带的 capabilities
   ```

4. **编写测试**（3小时）
   ```python
   tests/ontology/
   ├── test_single_inheritance.py
   └── test_aspect_composition.py
   ```

**验收标准**：
```python
# 测试：属性继承
equity_props = registry.get_effective_properties("Equity")
assert "symbol" in equity_props          # 来自 Instrument
assert "validFrom" in equity_props       # 来自 Temporal Aspect
assert "tradingStatus" in equity_props   # 来自 Tradable Aspect

# 测试：能力继承
engine = AspectEngine(registry)
aapl_2023 = engine.execute_interface_query(
    "Equity",
    "asOf",
    {"object_id": "aapl-nasdaq", "timestamp": "2023-12-31"}
)
assert aapl_2023 is not None
```

---

#### Day 6-7：Schema 生成器（多格式导出）

**目标**：从本体定义自动生成多种格式 Schema

**任务清单**：

1. **实现 Schema 生成器**（8小时）
   ```python
   packages/core/src/ontology/
   ├── schema_generator.py    # 统一生成器
   └── generators/
       ├── json_schema.py     # JSON Schema
       ├── pydantic.py        # Pydantic Model
       ├── sql_ddl.py         # PostgreSQL DDL
       └── owl_rdf.py         # OWL/RDF
   ```

2. **实现 OWL/RDF 导出器**（6小时）
   - 兼容 FIBO、Dublin Core
   - 支持 owl:equivalentClass
   - 支持 SHACL 约束导出

3. **编写测试**（4小时）
   ```python
   tests/ontology/
   ├── test_schema_generation.py
   └── test_owl_export.py
   ```

**验收标准**：
```python
generator = SchemaGenerator(registry)

# JSON Schema
json_schema = generator.generate_json_schema("Equity")
assert "properties" in json_schema
assert "symbol" in json_schema["properties"]

# SQL DDL
sql = generator.generate_sql_ddl("Equity")
assert "CREATE TABLE equity" in sql.lower()
assert "valid_from" in sql.lower()  # 来自 Temporal

# OWL/RDF
owl = generator.generate_owl_rdf("Equity")
assert "rdfs:subClassOf :Instrument" in owl
assert "owl:equivalentClass :Temporal" in owl
```

---

### 5.3 Week 2：动态能力执行（Day 8-14）

#### Day 8-10：Action 定义规范 + 执行框架

**目标**：解决"Action 动态执行是混乱源泉"的问题

**任务清单**：

1. **定义 Action 规范**（4小时）
   ```yaml
   ontology/actions/
   ├── rebalance-portfolio.yaml
   └── submit-order.yaml
   ```
   - 完整的参数定义
   - 明确的前置条件
   - 类型化的 effects
   - 审批策略

2. **实现 Action 验证器**（6小时）
   ```python
   packages/core/src/ontology/
   └── action_validator.py
   ```
   - 验证参数类型
   - 验证前置条件引用
   - 验证 effects 引用
   - 拒绝未定义参数

3. **实现 Action 执行器**（10小时）
   ```python
   packages/core/src/ontology/
   └── action_executor.py
   ```
   - 参数验证
   - 前置条件检查
   - 权限评估
   - Effects 执行
   - 审计记录

4. **编写测试**（4小时）
   ```python
   tests/ontology/
   ├── test_action_validation.py
   └── test_action_execution.py
   ```

**验收标准**：
```python
executor = ActionExecutor(registry)

# 正常执行
result = executor.execute_action(
    "RebalancePortfolio",
    "demo-portfolio",
    {"targetWeights": {"aapl": 0.5, "msft": 0.5}},
    "trader-001"
)
assert result.status == "succeeded"

# 拒绝违反约束
try:
    executor.execute_action(
        "RebalancePortfolio",
        "demo-portfolio",
        {"targetWeights": {"aapl": 0.6, "msft": 0.5}},  # 和不为1
        "trader-001"
    )
    assert False
except ActionValidationError as e:
    assert "sum_equals" in str(e)

# 拒绝未定义参数
try:
    executor.execute_action(
        "RebalancePortfolio",
        "demo-portfolio",
        {"targetWeights": {...}, "unknown": 123},
        "trader-001"
    )
    assert False
except ActionValidationError as e:
    assert "未定义的参数" in str(e)
```

---

#### Day 11-12：Interface Capability 动态绑定

**目标**：解决"Interface 能力继承规范不清导致混乱"的问题

**任务清单**：

1. **完善 Aspect Capability 定义**（4小时）
   - 明确声明 queries、functions、constraints
   - 提供 SQL 模板或 Python 实现
   - 定义 SHACL 约束

2. **实现 Interface 能力引擎**（8小时）
   ```python
   packages/core/src/ontology/
   └── interface_engine.py
   ```
   - 查询能力：asOf、history、lineage
   - 函数能力：isValidAt、canTradeAt
   - 约束验证：时间范围、状态转换

3. **实现 SHACL 验证器**（6小时）
   ```python
   packages/core/src/ontology/
   └── shacl_validator.py
   ```
   - 集成 pySHACL
   - 验证对象实例
   - 生成验证报告

4. **编写测试**（4小时）
   ```python
   tests/ontology/
   └── test_interface_capabilities.py
   ```

**验收标准**：
```python
engine = InterfaceCapabilityEngine(registry)

# Equity 实现 Temporal，自动获得 asOf
aapl_2023 = engine.execute_interface_query(
    "Equity",
    "asOf",
    {"object_id": "aapl-nasdaq", "timestamp": "2023-12-31"}
)

# 尝试执行未声明的能力被拒绝
try:
    engine.execute_interface_query(
        "Equity",
        "undefined_query",
        {...}
    )
    assert False
except UndefinedCapabilityError:
    pass

# SHACL 约束验证
validator = SHACLValidator(registry)
result = validator.validate_object({
    "validFrom": "2024-01-01",
    "validTo": "2023-12-31"  # 错误
})
assert not result.is_valid
```

---

#### Day 13-14：集成测试 + 扩展性验证

**目标**：验证"添加新类型不会牵一发而动全身"

**任务清单**：

1. **扩展性测试场景 1：添加新对象类型**（2小时）
   ```yaml
   ontology/object-types/bond.yaml
   ObjectType:
     id: CorporateBond
     baseClass: Bond
     aspects: [Temporal, Tradable, Rated]
   ```
   - 无需修改框架代码
   - 自动生成所有 Schema
   - 自动继承 Aspect 能力

2. **扩展性测试场景 2：添加新 Aspect**（2小时）
   ```yaml
   ontology/aspects/monitorable.yaml
   Aspect:
     id: Monitorable
     capabilities:
       functions:
         - checkHealth
   ```
   - 绑定到现有对象类型
   - 自动获得新能力

3. **扩展性测试场景 3：添加新 Action**（2小时）
   ```yaml
   ontology/actions/submit-order.yaml
   ActionType:
     id: SubmitOrder
     targetClass: Portfolio
   ```
   - 立即可用
   - 无需写代码

4. **编写完整集成测试**（6小时）
   ```python
   tests/integration/
   └── test_extensibility.py
   ```

5. **生成测试报告**（2小时）
   - 单元测试覆盖率报告
   - 集成测试结果
   - 性能基准测试

6. **编写文档**（4小时）
   ```
   docs/ontology-design/
   ├── extension-guide.md
   ├── action-definition-spec.md
   └── owl-rdf-compatibility.md
   ```

**验收标准**：
- [ ] 添加新 ObjectType 不修改框架代码
- [ ] 添加新 Aspect 可绑定到任意 Class
- [ ] 添加新 Action 只需 YAML 定义
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 所有扩展性场景通过验证

---

### 5.4 两周交付物清单

#### 本体定义（YAML）
```
ontology/
├── meta/
│   └── core-meta-model.yaml
├── value-types.yaml
├── taxonomies/
│   └── instrument-taxonomy.yaml
├── aspects/
│   ├── temporal.yaml
│   ├── tradable.yaml
│   ├── sourced.yaml
│   └── evidenced.yaml
├── object-types/
│   ├── instrument.yaml
│   ├── equity.yaml
│   ├── portfolio.yaml
│   └── order.yaml
└── actions/
    ├── rebalance-portfolio.yaml
    └── submit-order.yaml
```

#### 框架核心代码
```
packages/core/src/ontology/
├── type_registry.py
├── meta_model.py
├── validator.py
├── loader.py
├── aspect_engine.py
├── interface_engine.py
├── action_validator.py
├── action_executor.py
├── shacl_validator.py
└── schema_generator.py
    └── generators/
        ├── json_schema.py
        ├── pydantic.py
        ├── sql_ddl.py
        └── owl_rdf.py
```

#### 测试
```
tests/ontology/
├── test_meta_model.py
├── test_type_registry.py
├── test_validator.py
├── test_single_inheritance.py
├── test_aspect_composition.py
├── test_schema_generation.py
├── test_owl_export.py
├── test_action_validation.py
├── test_action_execution.py
└── test_interface_capabilities.py

tests/integration/
└── test_extensibility.py
```

#### 文档
```
docs/ontology-design/
├── meta-model.md
├── single-inheritance-guide.md
├── aspect-oriented-modeling.md
├── action-definition-spec.md
├── interface-capabilities.md
├── extension-guide.md
└── owl-rdf-compatibility.md

docs/adrs/
├── ADR-001-single-inheritance-aspect.md
├── ADR-002-action-execution-model.md
├── ADR-003-owl-rdf-export.md
└── ADR-004-shacl-constraints.md
```

---

## 第六部分：参考本体对齐策略

### 6.1 FIBO 对齐

**FIBO（Financial Industry Business Ontology）对齐策略**：

1. **概念映射**
   ```yaml
   # Axiolune → FIBO 映射
   Instrument → fibo-sec-sec:FinancialInstrument
   Equity → fibo-sec-eq:Equity
   Bond → fibo-sec-dbt:DebtInstrument
   Portfolio → fibo-fnd-acc-acc:Portfolio
   ```

2. **OWL 导出兼容**
   ```turtle
   :Equity a owl:Class ;
     rdfs:subClassOf :Instrument ;
     owl:equivalentClass fibo-sec-eq:Equity ;
     rdfs:label "Equity"@en .
   ```

3. **保持 Axiolune 灵活性**
   - FIBO 用于语义交换和验证
   - Axiolune 运行时不依赖 FIBO 推理
   - 映射在导出时生成

### 6.2 Palantir Foundry 对齐

**参考 Palantir 三层结构**：

1. **Language 层对齐**
   - ObjectType → Palantir Object Type
   - LinkType → Palantir Link Type
   - ActionType → Palantir Action Type
   - Interface → Palantir Interface（Palantir 称为 "shared properties"）

2. **Engine 层对齐**
   - TypeRegistry → Palantir Ontology Registry
   - ObjectResolver → Palantir Object Resolver
   - ActionExecutor → Palantir Action Service
   - PolicyEngine → Palantir Access Control

3. **关键差异**
   - Palantir 是闭源 SaaS，Axiolune 是开源本体引擎
   - Axiolune 提供 OWL/RDF 导出，Palantir 不提供
   - Axiolune 使用 YAML 定义，Palantir 使用 Studio UI

### 6.3 Apache Ossie 对齐

**参考 Apache Ossie YAML 体系**：

1. **分类树设计**
   - Ossie：严格单继承设备分类树
   - Axiolune：严格单继承金融工具分类树

2. **动态属性绑定**
   - Ossie：设备属性通过 XML 配置绑定
   - Axiolune：对象属性通过 YAML Aspect 绑定

3. **能力声明**
   - Ossie：接口声明设备能力（RemoteControllable）
   - Axiolune：Interface 声明对象能力（Temporal、Tradable）

---

## 第七部分：后续阶段规划

### Phase 2：数据接入与血缘（Week 3-6）

**目标**：连接真实数据源，建立数据血缘追踪

**关键交付物**：
1. DataBinding 机制
2. 数据适配器（Yahoo Finance、Wind、Alpha Vantage）
3. 血缘追踪引擎
4. 时间序列存储（InfluxDB/TimescaleDB）
5. 数据质量检查框架

### Phase 3：研究工作流集成（Week 7-12）

**目标**：集成 Qlib，实现 Factor → Model → ResearchRun 血缘

**关键交付物**：
1. Qlib 适配器
2. Factor 注册表与版本管理
3. Model 注册表
4. ResearchRun 可重现性验证
5. 研究工作流 Demo

### Phase 4+：回测、执行、风控（延后）

- LEAN/NautilusTrader 集成
- Strategy → Order → Fill 本体
- Guard 模块（合规规则、审计追踪）
- Desk 模块（Web UI、组合管理仪表板）

---

## 附录：关键设计决策记录

### 决策 1：为什么选择单继承 + Aspect？

**理由**：
- 单继承树提供稳定的分类骨架（Instrument → Equity → CommonStock）
- Aspect 提供灵活的能力组合（Temporal + Tradable + Sourced）
- 避免菱形继承问题
- 符合金融领域的自然分类

**参考**：Apache Ossie、FIBO Securities 模块

### 决策 2：为什么 Interface 附带 capabilities？

**理由**：
- Interface 不应只是属性集合，应提供真正的能力
- 任何实现 Temporal 的对象自动获得 asOf 查询
- 减少代码重复
- 保证一致性（所有 Temporal 对象的时间查询行为一致）

**参考**：Palantir Interface 机制

### 决策 3：为什么 Action 定义在 YAML 而不是代码？

**理由**：
- 业务人员可以理解和审查 Action 定义
- 修改 Action 不需要重新编译部署
- 强制完整定义（参数、前置条件、审批策略）
- 自动生成文档和测试用例

**风险缓解**：
- 严格的 Action 验证器
- 禁止未定义参数
- 强制审计配置

### 决策 4：为什么支持 OWL/RDF 导出？

**理由**：
- 与 FIBO、Dublin Core 等标准本体交换
- 语义推理和验证（通过 SHACL）
- 监管报告可能需要标准本体格式
- 开放性和可移植性

**实现策略**：
- OWL/RDF 用于导出和交换，不是运行时格式
- Axiolune 运行时使用 YAML + Python，性能更好

---

## 总结与下一步

### 成功标准回顾

完成 2周冲刺后，系统应满足：

1. **可扩展性**：添加新对象类型、Aspect、Action 不修改框架代码
2. **严格验证**：所有 Action、Interface 定义经过完整验证
3. **能力继承**：Interface 真正提供可执行的能力
4. **动态执行**：Action 通过 YAML 定义，框架自动执行
5. **多格式导出**：支持 JSON Schema、Pydantic、SQL、OWL/RDF
6. **高测试覆盖**：单元测试覆盖率 ≥ 80%

### 立即行动

**Day 1（今天）开始**：
1. 创建 `ontology/meta/core-meta-model.yaml`
2. 实现 `TypeRegistry` 基础结构
3. 编写第一个单元测试

**需要的决策**：
- [ ] 确认项目文件结构
- [ ] 确认 Python 版本（建议 3.11+）
- [ ] 确认依赖管理工具（Poetry / PDM）
- [ ] 确认代码风格（Ruff / Black）

---

**文档版本**：1.0  
**最后更新**：2026-07-28  
**下次审查**：Week 1 结束（Day 7）

