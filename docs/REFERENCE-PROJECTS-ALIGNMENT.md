# 参考项目对齐指南

**目的**：本文档详细说明如何参考 FIBO、Qlib、Lean、NautilusTrader 等项目的设计模式来指导 Axiolune 本体设计。

**重要性**：避免"自己捏一套本体"，确保与成熟项目对齐，效果才不会差劲。

---

## 一、FIBO（Financial Industry Business Ontology）对齐

### 1.1 FIBO 核心原则（必须遵循）

参考 `reference/ontology-design-reference/fibo/ONTOLOGY_GUIDE.md`：

#### 原则 1：Use Case Driven（用例驱动）
**FIBO 要求**：
- 每个本体元素（类、属性、个体）必须用于至少一个用例中的竞争力问题
- 任何修改必须关联到至少一个用例
- 新本体只有在支持至少一个用例时才被集成

**Axiolune 应用**：
```markdown
# 示例用例：Portfolio Rebalancing
## Competency Questions:
1. Q: 给定一个Portfolio，它当前的Position是什么？
   A: 通过 portfolioHasPosition Link 查询
   
2. Q: 一个Instrument的有效价格在特定时间点是什么？
   A: 通过 Temporal Interface 的 asOf 查询
   
3. Q: RebalancePortfolio Action 需要哪些前置条件？
   A: 检查 ActionType 定义的 preconditions
```

**行动项**：
- [ ] 为每个 Phase 编写完整用例文档（包含竞争力问题）
- [ ] 每个新增 ObjectType/ActionType 必须关联到用例

#### 原则 2：ISO 704 Conformant Definitions（ISO 704 符合性定义）

**FIBO 要求**：
- 所有定义必须遵循 ISO 704 原则
- 定义必须是"属-种差"结构（genus + differentia）
- 定义必须是部分句子，可以替换术语本身

**错误示例**：
```yaml
# ❌ 错误：循环定义
Equity:
  definition: "an equity instrument that represents ownership"
  # 定义中使用了术语本身 "equity"
```

**正确示例**：
```yaml
# ✓ 正确：属-种差结构
Equity:
  definition: "financial instrument that represents an ownership position in a publicly-traded corporation"
  # Genus: financial instrument
  # Differentia: represents ownership position in publicly-traded corporation
  
DebtInstrument:
  definition: "financial instrument that enables the issuing party to raise funds by accepting the obligation to repay a lender by a particular time in accordance with the terms of a contract"
  # Genus: financial instrument
  # Differentia: enables issuing party to raise funds + obligation to repay
```

**行动项**：
- [ ] 审查所有 ObjectType 定义，确保遵循属-种差结构
- [ ] 禁止循环定义
- [ ] 定义必须是可替换术语的部分句子

#### 原则 3：Unique Naming & Labeling（唯一命名和标签）

**FIBO 要求**：
- 即使跨命名空间，也强制唯一标签和唯一名称
- 不允许在不同本体中有同名类
- 如果需要提升到更高层级，应该弃用低层级的类

**Axiolune 应用**：
```yaml
# ❌ 错误：重复命名
# ontology/instruments/equity.yaml
ObjectType:
  id: Equity
  
# ontology/derivatives/equity_option.yaml
ObjectType:
  id: Equity  # ❌ 与上面冲突

# ✓ 正确：唯一命名
# ontology/instruments/equity.yaml
ObjectType:
  id: Equity
  
# ontology/derivatives/equity_option.yaml
ObjectType:
  id: EquityOption  # ✓ 唯一名称
  baseClass: OptionContract
  aspects: [Equity-Linked]  # 通过 Aspect 关联到 Equity
```

**行动项**：
- [ ] 实现唯一性验证器（检查所有 ObjectType/Property 名称）
- [ ] 如果需要跨域使用，提升到公共层级并弃用低层级版本

#### 原则 4：Polyhierarchical & Multiple Classification（多层次分类）

**FIBO 设计**：
- 支持多继承和多分类
- 示例：InterestRateSwap 可按利率类型、货币、合约特征分类

**Axiolune 设计**（单继承 + 多 Aspect）：
```yaml
# FIBO 风格（多继承）
InterestRateSwap:
  subClassOf: [Swap, InterestRateBased, Bilateral]

# Axiolune 风格（单继承 + Aspect）
InterestRateSwap:
  baseClass: Swap          # 单继承
  aspects: [InterestRateBased, Bilateral, Evidenced]  # 多 Aspect
```

**对齐策略**：
- 主分类骨架：单继承树（清晰稳定）
- 能力与特征：通过 Aspect 组合（灵活）
- OWL 导出时：可以生成 owl:equivalentClass 映射到 FIBO

#### 原则 5：Minimal Compliance Hygiene Tests（最小合规卫生测试）

**FIBO 自动测试**（必须实现）：
1. 无未类型化引用
2. 交叉域/范围检查
3. 标签和定义完整性
4. 本体元数据完整性
5. 无循环导入
6. 特殊字符限制
7. 唯一标签
8. 非循环定义
9. 对象属性逆关系唯一性
10. 避免使用 rdfs:comment
11. 避免显式引用 owl:Thing
12. 同义词作为类（避免等价类滥用）
13. 避免循环（类和属性层次）
14. 避免 min 1 基数限制（性能考虑）
15. 弃用资源不被使用
16. 避免 punning
17. 检测字符串中意外空格
18. 性能瓶颈检测

**行动项**：
- [ ] Week 1 Day 3：实现 FIBO 风格的验证器
- [ ] 将所有 21 项测试集成到 CI/CD
- [ ] 参考 `fibo/etc/testing/hygiene_parameterized/*.sparql` 编写 SPARQL 测试

### 1.2 FIBO 领域结构参考

**FIBO 领域**：
- **FND** (Foundations) - 基础概念
- **BE** (Business Entities) - 业务实体
- **FBC** (Financial Business & Commerce) - 金融业务与商业
- **SEC** (Securities) - 证券
- **DER** (Derivatives) - 衍生品
- **IND** (Indices & Indicators) - 指数和指标
- **LOAN** - 贷款
- **MD** (Market Data) - 市场数据

**Axiolune 对齐**：
```
Axiolune Domain          → FIBO Domain
────────────────────────────────────────
Organization & Access    → FND (Parties/Roles)
Parties                  → BE (LegalEntities)
Instruments & Markets    → SEC (Securities), DER (Derivatives)
Products & Accounts      → FBC (ProductsAndServices)
Portfolios & Positions   → FBC (Portfolio)
Research & Factors       → (Axiolune 特有，无直接对应)
Orders & Execution       → FBC (ProductsAndServices/Orders)
Risk & Compliance        → FBC (RiskManagement)
Companies & Events       → BE (Corporations), CAE (CorporateActions)
Information & Evidence   → FND (Arrangements/Documents)
```

### 1.3 FIBO 核心类对齐

**必须对齐的核心类**：

```yaml
# Axiolune Instrument → FIBO fibo-sec-sec:FinancialInstrument
Instrument:
  owl:equivalentClass: fibo-sec-sec:FinancialInstrument
  mappings:
    - to: fibo-fnd-agr-ctr:Contract
      reason: "Instrument is a contract"
    - to: fibo-fbc-fi-fi:FinancialInstrument
      reason: "Direct mapping"

# Axiolune Equity → FIBO fibo-sec-eq:Equity
Equity:
  owl:equivalentClass: fibo-sec-eq:Share
  rdfs:subClassOf: fibo-sec-eq:Equity

# Axiolune Portfolio → FIBO fibo-fbc-pas-fpas:Portfolio
Portfolio:
  owl:equivalentClass: fibo-fbc-pas-fpas:Portfolio
```

**行动项**：
- [ ] 为所有核心 ObjectType 定义 FIBO 映射
- [ ] OWL 导出器自动生成 owl:equivalentClass

---

## 二、Qlib（量化投研框架）对齐

### 2.1 Qlib 核心架构

参考 `reference/project-reference/qlib/README.md` 和源码：

**Qlib 分层**：
```
Infrastructure Layer (基础设施层)
├── DataServer: 数据服务
├── Trainer: 模型训练
├── Analyzer: 分析器
└── DataOps: 数据运维

Workflow Layer (工作流层)
├── Information Extractor: 信息提取
├── Forecast Model: 预测模型
├── Portfolio Generator: 组合生成
└── Order Executor: 订单执行
```

**Axiolune 对齐**：
```
Qlib Component              → Axiolune Ontology
──────────────────────────────────────────────
DataServer / DataHandler    → DataAsset + DataBinding
Feature / Factor            → FactorDefinition + FactorVersion
Model                       → ModelDefinition + ModelVersion
Strategy                    → Strategy (ObjectType)
Portfolio                   → Portfolio (ObjectType)
Order / Execution           → ParentOrder + ChildOrder + Execution
Backtest / Research         → BacktestRun + ResearchRun
```

### 2.2 Qlib Point-in-Time 数据库

**Qlib 核心特性**：Point-in-Time database 确保回测时只使用当时可知的数据。

**Axiolune 必须对齐**：
```yaml
# Temporal Interface 的实现必须支持 Point-in-Time
InterfaceType:
  id: Temporal
  properties:
    validFrom: Instant      # 业务有效时间
    validTo: Instant
    recordedAt: Instant     # 系统记录时间（Qlib 的 observed_at）
  
  capabilities:
    queries:
      - name: asOf
        description: "查询特定时间点的对象状态（Point-in-Time）"
        implementation: |
          SELECT * FROM {table}
          WHERE valid_from <= :timestamp
          AND (valid_to IS NULL OR valid_to > :timestamp)
          AND recorded_at <= :timestamp  # 关键：确保 Point-in-Time 正确性
```

**Qlib 的 CalendarProvider、InstrumentProvider**：
```python
# Qlib 的设计
class InstrumentProvider:
    def list_instruments(self, market, date):
        # 返回在 date 时刻市场上存在的股票列表
        pass

# Axiolune 对齐
ObjectType:
  id: Universe
  properties:
    name: string
    asOfDate: BusinessDate
  
  links:
    - hasMemberships: UniverseMembership
  
  capabilities:
    queries:
      - name: getConstituentsAsOf
        parameters: {asOfDate: BusinessDate}
        returns: List[Instrument]
        implementation: |
          # 返回在 asOfDate 时刻的成分股
          SELECT instrument FROM universe_membership
          WHERE universe_id = :universe_id
          AND valid_from <= :asOfDate
          AND (valid_to IS NULL OR valid_to > :asOfDate)
```

### 2.3 Qlib Factor 系统

**Qlib Factor 定义**：
```python
# Qlib 的 Factor 表达式
class Alpha001(Factor):
    def __init__(self):
        self.expression = "(rank(ts_argmax(signed_power(((returns < 0) ? " \
                          "stddev(returns, 20) : close), 2.), 5)) - 0.5)"
```

**Axiolune 对齐**：
```yaml
ObjectType:
  id: FactorDefinition
  properties:
    name: string
    expression: string        # Qlib 风格的表达式
    hypothesis: string        # 因子假设
    
ObjectType:
  id: FactorVersion
  properties:
    version: string
    expression: string
    frequency: FrequencyEnum  # daily, minute, tick
    lag: integer              # 数据延迟（避免 look-ahead bias）
    dependencies: list<string>  # 数据依赖
    
    # Qlib 集成
    qlibExpression: string    # Qlib 原生表达式
    qlibDataHandler: string   # Qlib DataHandler 配置
```

**行动项**：
- [ ] Phase 3：实现 Qlib 适配器
- [ ] FactorVersion 支持 Qlib 表达式解析
- [ ] 数据血缘追踪 Qlib DataHandler 的数据源

---

## 三、Lean（算法交易引擎）对齐

### 3.1 Lean 的 Security 体系

**Lean 核心类**：
```csharp
// Lean 的 Security 基类
public class Security {
    public Symbol Symbol { get; set; }
    public SecurityCache Cache { get; set; }
    public SecurityExchange Exchange { get; set; }
    public SubscriptionDataConfig SubscriptionDataConfig { get; set; }
}

public class Equity : Security { }
public class Option : Security { }
public class Future : Security { }
```

**Axiolune 对齐**：
```yaml
# Lean Security → Axiolune Instrument
ObjectType:
  id: Instrument
  aspects: [Identified, Temporal, Tradable]
  properties:
    symbol: string
    exchange: string
    securityType: SecurityTypeEnum  # Lean 的 SecurityType
    
  # Lean 的 SecurityCache 概念
  derivedProperties:
    - currentPrice: {function: getCurrentPrice}
    - bidPrice: {function: getBidPrice}
    - askPrice: {function: getAskPrice}
    - volume: {function: getCurrentVolume}
```

### 3.2 Lean 的 Algorithm + Order 系统

**Lean 设计**：
```csharp
public class QCAlgorithm {
    public OrderTicket MarketOrder(Symbol symbol, decimal quantity);
    public OrderTicket LimitOrder(Symbol symbol, decimal quantity, decimal limitPrice);
}

public class Order {
    public int Id { get; set; }
    public Symbol Symbol { get; set; }
    public decimal Quantity { get; set; }
    public OrderStatus Status { get; set; }
}
```

**Axiolune 对齐**：
```yaml
ObjectType:
  id: Strategy
  properties:
    name: string
    algorithm: string         # Lean QCAlgorithm 类名
    parameters: json          # 策略参数
  
  availableActions:
    - SubmitMarketOrder
    - SubmitLimitOrder
    - CancelOrder

ActionType:
  id: SubmitMarketOrder
  targetClass: Portfolio
  parameters:
    instrument: {type: InstrumentId, required: true}
    quantity: {type: Quantity, required: true}
    side: {type: enum[buy, sell], required: true}
  
  effects:
    - type: create_object
      objectType: ParentOrder
      data:
        orderType: "market"
        # ... 其他字段
```

**行动项**：
- [ ] Phase 4：Lean 集成适配器
- [ ] Strategy ObjectType 支持 Lean QCAlgorithm 引用
- [ ] Order 状态机对齐 Lean 的 OrderStatus

---

## 四、NautilusTrader（高性能交易系统）对齐

### 4.1 Nautilus 的 Domain Model

**Nautilus 核心概念**：
- `Instrument`: 交易工具
- `Order`: 订单（含完整生命周期）
- `Position`: 持仓
- `Account`: 账户
- `Execution`: 成交

**设计特点**：
- 强类型、不可变数据结构
- 事件驱动架构
- 完整的双时间语义（event_time + system_time）

**Axiolune 对齐**：
```yaml
# Nautilus 的 Instrument.precision
ObjectType:
  id: Instrument
  aspects: [Tradable]
  properties:
    pricePrecision: integer   # Nautilus precision
    sizePrecision: integer
    priceIncrement: decimal   # Nautilus price_increment
    sizeIncrement: decimal

# Nautilus 的 Order 生命周期
ObjectType:
  id: ParentOrder
  aspects: [Stateful, Auditable]
  stateTransitions:
    - from: initialized
      to: [submitted, denied, cancelled]
    - from: submitted
      to: [accepted, rejected, cancelled]
    - from: accepted
      to: [partially_filled, filled, cancelled]
    # 完整对齐 Nautilus OrderStatus
```

### 4.2 Nautilus 的 Event Sourcing

**Nautilus 设计**：所有状态变更通过事件记录。

**Axiolune 对齐**：
```yaml
EventType:
  id: OrderSubmitted
  properties:
    orderId: string
    instrumentId: string
    side: SideEnum
    quantity: Quantity
    orderType: OrderTypeEnum
    eventTime: Instant    # Nautilus event_ts_ns
    systemTime: Instant   # Nautilus ts_init

EventType:
  id: OrderAccepted
  properties:
    orderId: string
    venueOrderId: string  # Nautilus venue_order_id
    eventTime: Instant
    systemTime: Instant

EventType:
  id: OrderFilled
  properties:
    orderId: string
    executionId: string
    fillPrice: Price
    fillQuantity: Quantity
    commission: Money
    eventTime: Instant
    systemTime: Instant
```

**行动项**：
- [ ] 所有 Stateful ObjectType 的状态转换必须发出 Event
- [ ] Event 必须有 eventTime（业务时间）和 systemTime（记录时间）

---

## 五、综合对齐策略

### 5.1 优先级

**P0（必须在 Week 1 完成）**：
1. FIBO ISO 704 定义规范
2. FIBO 唯一命名约束
3. FIBO 属-种差定义结构
4. Qlib Point-in-Time 双时间语义

**P1（必须在 Week 2 完成）**：
1. FIBO 21 项卫生测试
2. Qlib Factor 数据依赖追踪
3. Lean Order 状态机对齐
4. Nautilus Event Sourcing 模式

**P2（Phase 2-3 完成）**：
1. FIBO OWL 导出和映射
2. Qlib 适配器完整集成
3. Lean 集成适配器
4. Nautilus 高性能优化

### 5.2 参考项目检查清单

在设计每个 ObjectType 时，必须检查：

**检查清单**：
- [ ] **FIBO 对齐**：是否有对应的 FIBO 类？定义是否符合 ISO 704？
- [ ] **Qlib 对齐**：如果是因子/模型/数据相关，是否与 Qlib 概念一致？
- [ ] **Lean 对齐**：如果是交易相关，是否与 Lean Security/Order 体系一致？
- [ ] **Nautilus 对齐**：状态转换是否完整？事件是否双时间？
- [ ] **用例驱动**：是否有明确的竞争力问题？

### 5.3 "不自己捏一套"原则

**❌ 错误做法**：
```yaml
# 自己捏一套，不参考任何项目
ObjectType:
  id: MyCustomInstrument  # ❌ 名称不符合 FIBO
  properties:
    myPrice: decimal      # ❌ 属性命名不规范
    myStatus: string      # ❌ 没有枚举类型
```

**✓ 正确做法**：
```yaml
# 参考 FIBO + Lean + Nautilus
ObjectType:
  id: Equity  # ✓ FIBO 标准名称
  owl:equivalentClass: fibo-sec-eq:Share  # ✓ 明确 FIBO 映射
  baseClass: Instrument
  aspects: [Temporal, Tradable, Sourced]  # ✓ Nautilus 风格
  
  properties:
    # ✓ 参考 FIBO 命名
    tickSize: decimal           # Lean tickSize
    priceIncrement: decimal     # Nautilus price_increment
    
    # ✓ Qlib Point-in-Time
    validFrom: Instant
    validTo: Instant
    recordedAt: Instant
```

---

## 六、实施检查点

### Week 1 Day 3 检查点
- [ ] 所有 ValueType 定义符合 ISO 704
- [ ] 元模型验证器实现 FIBO 唯一性检查
- [ ] Temporal Interface 支持 Point-in-Time（Qlib）

### Week 2 Day 10 检查点
- [ ] Action 状态机对齐 Lean + Nautilus
- [ ] Event 定义包含双时间
- [ ] 所有 ObjectType 有 FIBO 映射注释

### Phase 1 结束检查点
- [ ] 通过所有 FIBO 卫生测试
- [ ] OWL 导出包含 FIBO 映射
- [ ] 文档说明与 Qlib/Lean/Nautilus 的对齐点

---

**文档维护者**：Axiolune 本体团队  
**最后更新**：2026-07-28  
**版本**：1.0
