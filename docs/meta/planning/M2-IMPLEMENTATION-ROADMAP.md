# M2 领域本体实施路线图

**状态**: 规划中  
**日期**: 2026-07-29  
**M3基线**: v0.5.0 ✅  
**周期**: 8-12周  
**规模**: 8模块，200-300类型

---

## 一、核心原则

1. **M3语法严格遵循**: 所有类型必须是ObjectTypeDefinition/AssociationTypeDefinition
2. **ADR-012强制绑定**: 所有时序数据绑定validTime/knowledgeTime/availabilityTime
3. **生产验证优先**: nautilus_trader > Lean > qlib > rqalpha，禁用design-draft
4. **FIBO对齐**: 核心金融概念必须有FIBO exactMatch
5. **中国市场扩展**: T+1、涨跌停、结算价等特殊逻辑

---

## 二、实施阶段

### Week 1: 核心基础
- **模块**: `ontology/domain/core/`
- **交付**: identifiers.yaml, parties.yaml, money.yaml
- **内容**: ISIN, CUSIP, LEI, MIC, Currency, Money
- **参考**: FIBO + ISO 6166/10383
- **里程碑**: 第一个M2模块完成 + 验证脚本通过

### Week 2-3: 金融工具
- **模块**: `ontology/domain/instruments/`
- **交付**: base.yaml, equity.yaml, derivatives.yaml, crypto.yaml
- **内容**: Instrument基类, Equity, Option, Future, CryptoCurrency
- **参考**: nautilus_trader/model/instruments.pyx (18子类)
- **里程碑**: 8大工具类 + FIBO对齐完成

### Week 4: 市场数据
- **模块**: `ontology/domain/market-data/`
- **交付**: quotes.yaml, trades.yaml, bars.yaml
- **内容**: QuoteTick, TradeTick, Bar, OrderBook
- **参考**: nautilus_trader/model/data.pyx
- **里程碑**: 行情数据结构 + 三轴时间绑定

### Week 5-6: 订单系统
- **模块**: `ontology/domain/orders/`
- **交付**: order-lifecycle.yaml, fills.yaml, contingent.yaml
- **内容**: 15状态FSM, 16事件类型, OCO/OTO
- **参考**: nautilus_trader/model/orders.pyx
- **里程碑**: 完整订单状态机 + 中国市场订单类型

### Week 7: 持仓管理
- **模块**: `ontology/domain/positions/`
- **交付**: position.yaml, portfolio.yaml
- **内容**: Position, PnL, Portfolio, FIFO
- **参考**: nautilus_trader/model/position.pyx + rqalpha
- **里程碑**: 事件溯源持仓 + T+1支持

### Week 8: 策略系统
- **模块**: `ontology/domain/strategy/`
- **交付**: signals.yaml, backtest.yaml
- **内容**: Factor, Signal, BacktestRun
- **参考**: qlib Expression DSL
- **里程碑**: 因子表达框架 + 回测元数据

### Week 9: 风险管理
- **模块**: `ontology/domain/risk/`
- **交付**: exposure.yaml, limits.yaml
- **内容**: VaR, Greeks, PositionLimit
- **参考**: Lean Greeks + nautilus
- **里程碑**: 风险度量 + 限额管理

### Week 10: 运营支持
- **模块**: `ontology/domain/operations/`
- **交付**: settlement.yaml, corporate-actions.yaml
- **内容**: Settlement, Dividend, Split
- **里程碑**: 清算对账 + 公司行动

---

## 三、示例：Week 1交付物

### identifiers.yaml 结构

```yaml
module:
  moduleIri: "https://axiolune.ai/ontology/domain/core/identifiers"
  baseIri: "https://axiolune.ai/ontology/domain/core/identifiers/"
  preferredPrefix: "ax-id"
  version: "0.1.0"
  imports:
    - moduleIri: "https://axiolune.ai/ontology/meta/core#sha256:6a38..."
      version: "0.4.0"
      importMode: All

Identifiers:
  ISIN:
    kind: ObjectTypeDefinition
    definition: "International Securities Identification Number per ISO 6166"
    superTypes: [ax-meta:IdentifierType]
    attributes:
      - name: code
        type: string
        pattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$"
        required: true
    alignments:
      - vocabulary: FIBO
        targetIri: "https://spec.edmcouncil.org/.../ISIN"
        relation: exactMatch
        
  CUSIP:
    kind: ObjectTypeDefinition
    definition: "Committee on Uniform Securities Identification Procedures identifier"
    superTypes: [ax-meta:IdentifierType]
    attributes:
      - name: code
        type: string
        pattern: "^[0-9A-Z]{9}$"
        required: true
        
  LEI:
    kind: ObjectTypeDefinition
    definition: "Legal Entity Identifier per ISO 17442"
    attributes:
      - name: code
        type: string
        pattern: "^[A-Z0-9]{20}$"
        required: true
```

---

## 四、数据绑定示例

### 行情数据绑定 (ADR-011/012)

```yaml
EquityQuoteMapping:
  kind: SemanticMappingDefinition
  source:
    datasets:
      - {dataset: "datasource:market/quotes", alias: "q"}
  targetType: "ax-market:QuoteTick"
  slotMappings:
    - target: {slotType: participantRole, targetRole: "instrument"}
      value:
        bindingType: transformation
        transformationRef: "data:LookupInstrumentBySymbol#v1.0.0"
        inputs:
          symbol: {bindingType: directField, source: {dataset: "q", field: "symbol"}}
    - target: {slotType: attribute, targetAttribute: "bidPrice"}
      value: {bindingType: directField, source: {dataset: "q", field: "bid"}}
    - target: {slotType: attribute, targetAttribute: "askPrice"}
      value: {bindingType: directField, source: {dataset: "q", field: "ask"}}
  temporal:
    validTime:
      from: {bindingType: directField, source: {dataset: "q", field: "timestamp"}}
    knowledgeTime:
      from: {bindingType: directField, source: {dataset: "q", field: "received_at"}}
    availabilityTime:
      from: {bindingType: runtimeContext, contextField: "assertionTime"}
```

---

## 五、验收标准

### 架构合规
- [ ] 所有类型使用M3语法
- [ ] 时序数据绑定ADR-012三轴
- [ ] 核心概念有FIBO对齐
- [ ] 无design-draft引用
- [ ] 通过validate-m2.js验证

### 功能完整性
- [ ] 8模块全部交付
- [ ] 8大工具类定义
- [ ] 15状态订单FSM
- [ ] tick/quote/bar行情
- [ ] 事件溯源持仓
- [ ] 因子表达框架
- [ ] 5个数据绑定示例

### 生产就绪
- [ ] 每模块有README
- [ ] 核心类型有测试
- [ ] PIT查询 < 100ms
- [ ] 语义版本控制
- [ ] 安全审查完成

---

## 六、关键决策点

### ADR-013: M2架构决策 (Week 1)
- 模块分层理由
- 继承vs组合策略
- 中国市场扩展点
- FIBO对齐策略

### ADR-014: 订单状态机 (Week 5)
- 15状态vs简化状态
- 事件溯源vs快照
- 父子单建模

### ADR-015: 持仓PnL (Week 7)
- FIFO vs LIFO
- T+1实现方式
- 实现盈亏vs浮动盈亏

---

## 七、参考资料

### 生产系统
- nautilus_trader: 工具/订单/持仓/行情
- Lean: 工具枚举/Greeks/订单类型
- qlib: 因子DSL/PIT查询
- rqalpha: T+1/中国市场

### 标准规范
- FIBO: SEC-SEC, FBC-FI, IND-IND
- ISO 6166: ISIN
- ISO 10383: MIC
- ISO 20022: 金融消息

### M3元本体
- core-meta-model.yaml v0.4
- cross-domain-patterns.yaml v0.4
- data-binding-meta-model.yaml v0.5
- ADR-011, ADR-012

---

## 八、下一步行动

### 本周必做
1. **创建目录结构**
   ```bash
   mkdir -p ontology/domain/{core,instruments,market-data,orders,positions,strategy,risk,operations}
   ```

2. **编写ADR-013**
   - 主题: M2架构决策
   - 内容: 模块分层、参考优先级、中国市场
   
3. **实现core/identifiers.yaml**
   - ISIN, CUSIP, LEI, MIC
   - FIBO对齐
   - ISO标准绑定

4. **创建validate-m2.js**
   - M3语法检查
   - ADR-012时间检查
   - 模块依赖检查
   - FIBO对齐检查

### Week 1里程碑
- [ ] ADR-013发布
- [ ] core模块3个文件完成
- [ ] validate-m2.js通过
- [ ] 第一个数据绑定示例

---

**所有者**: Meta-Model Team  
**审查**: 每阶段完成后  
**更新频率**: 每周
