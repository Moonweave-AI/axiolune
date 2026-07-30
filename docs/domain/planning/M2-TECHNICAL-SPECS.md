## 5. 技术规范

### 5.1 YAML文件结构规范

每个领域本体YAML文件必须遵循以下结构：

```yaml
# 文件头部注释
# Module: [模块名称]
# Version: [语义版本]
# Date: [创建/更新日期]
# Dependencies: [依赖的其他模块]

module:
  moduleIri: "https://axiolune.ai/ontology/domain/[layer]/[module-name]"
  baseIri: "https://axiolune.ai/ontology/domain/[layer]/[module-name]/"
  preferredPrefix: "ax-[abbrev]"
  version: "0.1.0"
  imports:
    - moduleIri: "https://axiolune.ai/ontology/meta/core"
      version: "0.4.0"
      importMode: All
    - moduleIri: "https://axiolune.ai/ontology/domain/core/identifiers"
      version: "0.1.0"
      importMode: Selective
      importedTypes: [ISIN, CUSIP]
  metadata:
    author: "Meta-Model Team"
    license: "Proprietary"
    description: "[模块用途描述]"

# 类型定义区
TypeDefinitions:
  TypeName:
    kind: ObjectTypeDefinition  # 或 AssociationTypeDefinition, EnumTypeDefinition, ValueTypeDefinition
    definition: "[ISO 704规范的定义]"
    superTypes: [ParentType]  # 可选
    attributes:
      - name: attributeName
        type: string  # 或其他基础类型/引用类型
        required: true  # 或 false
        pattern: "^[regex]$"  # 可选约束
        range: [min, max]  # 可选约束
    participantRoles:  # 仅ObjectType和AssociationType
      - name: roleName
        targetType: ReferencedType
        cardinality: "1"  # 或 "0..1", "0..*", "1..*"
    invariants:  # 可选不变式
      - "逻辑约束描述"
    alignments:  # FIBO对齐
      - vocabulary: FIBO
        vocabularyVersion: "2024-Q3"
        targetIri: "https://spec.edmcouncil.org/fibo/..."
        relation: exactMatch  # 或 closeMatch, broadMatch等
        rationale: "[对齐理由]"
        verifiedBy: "[审查人]"
        verifiedDate: "2026-07-30"
```

### 5.2 类型命名规范

#### PascalCase (大驼峰)
- ObjectTypeDefinition: `Instrument`, `QuoteTick`, `OrderFilled`
- AssociationTypeDefinition: `OCO_Order`, `Issuer_Of`
- EnumTypeDefinition: `OrderStateEnum`, `SecurityTypeEnum`

#### snake_case (下划线)
- 属性名: `bid_price`, `order_state`, `total_quantity`
- 文件名: `order-lifecycle.yaml`, `china-extensions.yaml`

#### 模块前缀
- core: `ax-core:ISIN`
- instruments: `ax-instruments:Equity`
- market-data: `ax-market:QuoteTick`
- orders: `ax-orders:Order`
- positions: `ax-positions:Position`
- strategy: `ax-strategy:Factor`
- risk: `ax-risk:VaR`
- operations: `ax-ops:Settlement`

### 5.3 ADR-012三轴时间绑定规范

所有时序数据类型必须显式绑定三个时间轴：

```yaml
QuoteTick:
  kind: ObjectTypeDefinition
  attributes:
    - name: bidPrice
      type: decimal
    - name: askPrice
      type: decimal
  temporalPattern: "ax-pattern:BiTemporalSnapshot"
  # temporalPattern引用cross-domain-patterns.yaml中定义的模式

# 对应的数据绑定
QuoteTickMapping:
  kind: SemanticMappingDefinition
  targetType: "ax-market:QuoteTick"
  temporal:
    patternRef: "ax-pattern:BiTemporalSnapshot"
    validTime:
      from: {bindingType: directField, source: {dataset: "quotes", field: "timestamp"}}
      # 业务时间: 报价产生的时间
    knowledgeTime:
      from: {bindingType: directField, source: {dataset: "quotes", field: "received_at"}}
      # 事务时间: 系统接收到报价的时间
    availabilityTime:
      from: {bindingType: runtimeContext, contextField: "assertionTime"}
      # 合规时间: 数据可供查询的时间（物化时间）
```

**禁止模式**:
- ❌ 单一`timestamp`字段
- ❌ 使用`CURRENT_TIMESTAMP`
- ❌ 隐式时间语义

### 5.4 FIBO对齐规范

#### 对齐关系选择指南

| 场景 | 关系 | 示例 |
|------|------|------|
| ISO标准标识符 | exactMatch | ax:ISIN ↔ fibo:ISIN |
| 通用金融概念（含义相同） | exactMatch | ax:Equity ↔ fibo:Equity |
| 实现细节不同 | closeMatch | ax:Order ↔ fibo:SecuritiesOrder |
| 我们的概念更具体 | broadMatch | ax:AShare → fibo:Equity |
| FIBO的概念更具体 | narrowMatch | ax:Instrument ← fibo:FinancialInstrument |
| 概念相关但非层次 | relatedMatch | ax:BacktestRun ↔ fibo:AnalysisResult |

#### 对齐记录模板

```yaml
TypeName:
  kind: ObjectTypeDefinition
  alignments:
    - vocabulary: FIBO
      vocabularyVersion: "2024-Q3"  # 必须指定版本
      targetIri: "https://spec.edmcouncil.org/fibo/ontology/[module]/[concept]"
      relation: exactMatch
      rationale: |
        [详细说明为什么选择这个对齐关系，
         包括概念定义对比、属性对比、使用场景对比]
      verifiedBy: "[金融专家姓名]"
      verifiedDate: "2026-07-30"
      notes: "[可选的额外说明]"
```

#### 核心对齐清单 (必须完成的50个)

**标识符类 (5个)**:
1. ISIN → fibo:ISIN (exactMatch)
2. CUSIP → fibo:CUSIP (exactMatch)
3. LEI → fibo:LEI (exactMatch)
4. MIC → fibo:MIC (exactMatch)
5. Currency → fibo:Currency (exactMatch)

**工具类 (15个)**:
6. Instrument → fibo:FinancialInstrument (closeMatch)
7. Equity → fibo:Equity (exactMatch)
8. Bond → fibo:Bond (exactMatch)
9. Option → fibo:Option (exactMatch)
10. CallOption → fibo:CallOption (exactMatch)
11. PutOption → fibo:PutOption (exactMatch)
12. Future → fibo:FuturesContract (closeMatch)
13. Swap → fibo:Swap (exactMatch)
14. ETF → fibo:ExchangeTradedFund (exactMatch)
15. CommonStock → fibo:CommonStock (exactMatch)
16. PreferredStock → fibo:PreferredStock (exactMatch)
17. Treasury → fibo:TreasuryBond (closeMatch)
18. CryptoCurrency → fibo:DigitalAsset (relatedMatch)
19. Warrant → fibo:Warrant (exactMatch)
20. ConvertibleBond → fibo:ConvertibleBond (exactMatch)

**参与方类 (8个)**:
21. Issuer → fibo:Issuer (exactMatch)
22. Exchange → fibo:Exchange (exactMatch)
23. Broker → fibo:Broker (exactMatch)
24. Custodian → fibo:Custodian (exactMatch)
25. Counterparty → fibo:Counterparty (exactMatch)
26. ClearingHouse → fibo:ClearingHouse (exactMatch)
27. Account → fibo:Account (closeMatch)
28. Portfolio → fibo:Portfolio (closeMatch)

**市场数据类 (5个)**:
29. QuoteTick → fibo:Quote (closeMatch)
30. TradeTick → fibo:Trade (closeMatch)
31. Execution → fibo:Execution (exactMatch)
32. Venue → fibo:Venue (exactMatch)
33. TradingSession → fibo:TradingSession (closeMatch)

**订单类 (7个)**:
34. Order → fibo:SecuritiesOrder (closeMatch)
35. MarketOrder → fibo:MarketOrder (exactMatch)
36. LimitOrder → fibo:LimitOrder (exactMatch)
37. StopOrder → fibo:StopOrder (exactMatch)
38. OrderFilled → fibo:OrderExecution (closeMatch)
39. OrderState → fibo:OrderStatus (relatedMatch)
40. TradeReport → fibo:TradeReport (closeMatch)

**持仓类 (5个)**:
41. Position → fibo:Position (exactMatch)
42. RealizedPnL → fibo:RealizedGainOrLoss (closeMatch)
43. UnrealizedPnL → fibo:UnrealizedGainOrLoss (closeMatch)
44. MarginRequirement → fibo:MarginRequirement (exactMatch)
45. NetLiquidation → fibo:NetAssetValue (relatedMatch)

**风险类 (5个)**:
46. VaR → fibo:ValueAtRisk (exactMatch)
47. Delta → fibo:Delta (exactMatch)
48. Gamma → fibo:Gamma (exactMatch)
49. Vega → fibo:Vega (exactMatch)
50. Exposure → fibo:Exposure (closeMatch)

### 5.5 模块依赖管理

#### 依赖声明

```yaml
module:
  imports:
    - moduleIri: "https://axiolune.ai/ontology/meta/core"
      version: "0.4.0"
      importMode: All  # 导入所有类型
    - moduleIri: "https://axiolune.ai/ontology/domain/core/identifiers"
      version: "0.1.0"
      importMode: Selective
      importedTypes: [ISIN, CUSIP, LEI]  # 只导入指定类型
```

#### 依赖规则

1. **向下依赖**: 只能依赖更低层的模块
   - ✅ instruments → core
   - ✅ orders → instruments + market-data
   - ❌ core → instruments (反向依赖)

2. **禁止循环依赖**
   - ❌ A → B → C → A

3. **禁止跨层依赖**
   - ❌ strategy → instruments (应通过positions)

4. **版本固定**: imports必须指定精确版本

#### validate-m2.js依赖检查

```javascript
function validateDependencies(modules) {
  // 检查1: 构建依赖图
  const graph = buildDependencyGraph(modules);
  
  // 检查2: 检测循环依赖
  const cycles = detectCycles(graph);
  if (cycles.length > 0) {
    throw new Error(`Circular dependencies detected: ${cycles}`);
  }
  
  // 检查3: 验证分层规则
  const layerViolations = checkLayerRules(graph);
  if (layerViolations.length > 0) {
    throw new Error(`Layer violations: ${layerViolations}`);
  }
  
  // 检查4: 验证版本完整性
  const missingVersions = checkVersions(modules);
  if (missingVersions.length > 0) {
    throw new Error(`Missing versions: ${missingVersions}`);
  }
}
```

### 5.6 语义版本控制

遵循 Semantic Versioning 2.0.0 (semver.org):

- **MAJOR.MINOR.PATCH** (例: 1.2.3)

**MAJOR** (主版本，破坏性变更):
- 删除类型或属性
- 改变属性类型（如string → integer）
- 改变不变式约束（更严格）
- 改变IRI命名空间

**MINOR** (次版本，向后兼容的功能新增):
- 新增类型
- 新增可选属性
- 新增participantRole
- 放宽约束（如增大range）

**PATCH** (修订版本，向后兼容的bug修复):
- 修正definition文字错误
- 改进注释和文档
- 修正FIBO对齐关系
- 优化性能（不改变语义）

**示例**:
- 0.1.0: Week 1初始版本
- 0.2.0: Week 2新增工具类型
- 0.2.1: Week 2修正Equity定义的拼写错误
- 1.0.0: Week 10生产发布（所有模块验收通过）

---
