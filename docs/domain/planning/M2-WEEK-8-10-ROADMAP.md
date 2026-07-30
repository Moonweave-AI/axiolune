## 4.6 Week 8: 策略系统 (2026-09-17 至 09-23)

#### 目标
实现因子DSL框架，支持qlib Expression兼容的因子表达。

#### 交付物

**1. ontology/domain/strategy/signals.yaml**
- Signal基类 (BUY, SELL, HOLD)
- SignalStrength (信号强度)
- Indicator基类
- TechnicalIndicator (技术指标)

**2. ontology/domain/strategy/factors.yaml**
- Factor基类
- FactorExpression (qlib兼容的表达式DSL)
- AlphaFactor
- RiskFactor
- StyleFactor

**qlib Expression兼容示例**:
```yaml
MomentumFactor:
  kind: ObjectTypeDefinition
  definition: "动量因子"
  superTypes: [AlphaFactor]
  attributes:
    - name: expression
      type: string
      example: "Ref($close, -20) / $close - 1"
    - name: lookbackWindow
      type: integer
      default: 20
```

**3. ontology/domain/strategy/rules.yaml**
- EntryRule (入场规则)
- ExitRule (出场规则)
- RiskRule (风险规则)
- PositionSizingRule (仓位规则)

**4. ontology/domain/strategy/backtest.yaml**
- BacktestRun
- BacktestConfig
- Performance
- Metrics (Sharpe, MaxDrawdown, WinRate)

**5. ontology/domain/strategy/execution.yaml**
- ExecutionAlgorithm基类
- VWAP (成交量加权平均价格)
- TWAP (时间加权平均价格)
- IcebergAlgorithm

**6. 数据绑定示例**
- FactorValueMapping (因子值计算结果绑定)
- BacktestResultMapping (回测结果绑定)

#### 验收标准
- Factor/Signal/Rule三层体系定义完成
- qlib Expression兼容性验证
- BacktestRun元数据定义
- ExecutionAlgorithm基类定义
- 2个数据绑定示例

#### 参考来源
- qlib: qlib/data/ops.py (Expression DSL)
- nautilus_trader: model/strategy.py
- Lean: Algorithm/QCAlgorithm.cs

---

## 4.7 Week 9: 风险管理 (2026-09-24 至 09-30)

#### 目标
实现风险度量、Greeks计算、限额管理。

#### 交付物

**1. ontology/domain/risk/exposure.yaml**
- Exposure基类
- NetExposure (净敞口)
- GrossExposure (总敞口)
- SectorExposure (行业敞口)
- CurrencyExposure (货币敞口)

**2. ontology/domain/risk/var.yaml**
- VaR基类 (Value at Risk)
- HistoricalVaR (历史模拟法)
- ParametricVaR (方差-协方差法)
- MonteCarloVaR (蒙特卡洛模拟)
- CVaR (Conditional VaR, 条件风险价值)
- ConfidenceLevel枚举 (95%, 99%)

**3. ontology/domain/risk/greeks.yaml**
- Greeks基类
- Delta (价格敏感度)
- Gamma (Delta敏感度)
- Vega (波动率敏感度)
- Theta (时间衰减)
- Rho (利率敏感度)

参考Lean ModeledGreeks实现:
```yaml
OptionGreeks:
  kind: ObjectTypeDefinition
  definition: "期权Greeks"
  participantRoles:
    - name: option
      targetType: ax-instruments:Option
      cardinality: "1"
  attributes:
    - name: delta
      type: decimal
      range: [-1.0, 1.0]
    - name: gamma
      type: decimal
      range: [0.0, +inf]
    - name: vega
      type: decimal
    - name: theta
      type: decimal
    - name: rho
      type: decimal
    - name: impliedVolatility
      type: decimal
      range: [0.0, +inf]
```

**4. ontology/domain/risk/limits.yaml**
- PositionLimit (持仓限额)
- OrderSizeLimit (单笔订单限额)
- LossLimit (亏损限额)
- LeverageLimit (杠杆限额)
- ConcentrationLimit (集中度限额)

**5. ontology/domain/risk/compliance.yaml**
- ComplianceCheck
- PreTradeCheck (交易前检查)
- PostTradeCheck (交易后检查)
- Restriction (限制规则)
- Violation (违规记录)

**6. ontology/domain/risk/stress-test.yaml**
- StressScenario (压力测试场景)
- ScenarioResult
- SensitivityAnalysis

#### 验收标准
- VaR/CVaR三种计算方法定义
- 期权5个Greeks定义
- 限额管理5种限额类型
- ComplianceCheck规则引擎
- validate-m2.js通过

#### 参考来源
- Lean: Algorithm/Risk/ModeledGreeks.cs
- nautilus_trader: risk module
- FIBO: FBC-FI Risk模块

---

## 4.8 Week 10: 运营支持 (2026-10-01 至 10-08)

#### 目标
实现清算对账、公司行动、审计追溯。

#### 交付物

**1. ontology/domain/operations/settlement.yaml**
- Settlement (清算)
- ClearingInstruction (清算指令)
- DVP (Delivery Versus Payment, 券款对付)
- SettlementStatus枚举
- SettlementCycle (T+0, T+1, T+2)

**2. ontology/domain/operations/reconciliation.yaml**
- ReconRecord (对账记录)
- Break (差异)
- BreakType枚举 (QuantityBreak, PriceBreak, MissingTrade)
- ReconStatus枚举 (MATCHED, UNMATCHED, INVESTIGATING, RESOLVED)

**3. ontology/domain/operations/corporate-actions.yaml**
- CorporateAction基类
- Dividend (分红)
  - CashDividend
  - StockDividend
- Split (拆股)
- Merger (合并)
- SpinOff (分拆)
- RightsIssue (配股)

**4. ontology/domain/operations/reporting.yaml**
- ComplianceReport (合规报告)
- PnLReport (盈亏报告)
- RiskReport (风险报告)
- PositionReport (持仓报告)
- TradeReport (交易报告)

**5. ontology/domain/operations/audit.yaml**
- AuditTrail (审计追踪)
- AuditEvent
- DataLineage (数据血缘)
- ChangeLog (变更日志)

**6. 数据绑定示例**
- SettlementMapping (清算数据绑定)
- CorporateActionMapping (公司行动绑定)
- AuditTrailMapping (审计追踪绑定)

#### 验收标准
- Settlement/Reconciliation流程定义
- CorporateAction 6种类型定义
- Reporting 5种报告类型
- AuditTrail审计追溯能力
- 3个数据绑定示例
- validate-m2.js全模块通过

#### 参考来源
- ISO 20022: 金融消息标准
- FIBO: FBC-FI Operations模块
- Lean: Data/Auxiliary/CorporateActions

---

## 4.9 最终验收里程碑 (2026-10-08)

### 架构合规性验收
- [ ] 所有321个类型使用M3语法（ObjectTypeDefinition等）
- [ ] 时序数据100%绑定ADR-012三轴
- [ ] 核心50个概念有FIBO对齐
- [ ] 零design-draft引用
- [ ] validate-m2.js全部检查通过（零错误）

### 功能完整性验收
- [ ] 8模块全部交付（core, instruments, market-data, orders, positions, strategy, risk, operations）
- [ ] 8大工具类定义（Equity, Bond, Option, Future, Swap, Crypto, ETF, Warrant）
- [ ] 18个工具子类（对照nautilus_trader）
- [ ] 15状态订单FSM + 16事件类型
- [ ] tick/quote/bar市场数据结构
- [ ] 事件溯源持仓模型 + T+1支持
- [ ] qlib Expression兼容的因子DSL
- [ ] VaR/Greeks风险度量
- [ ] 15个数据绑定示例（符合ADR-011/012）

### 文档完整性验收
- [ ] ADR-013 (M2架构) - Accepted
- [ ] ADR-014 (订单状态机) - Accepted
- [ ] ADR-015 (持仓PnL) - Accepted
- [ ] 每个模块有README.md
- [ ] 每个模块有使用示例
- [ ] FIBO对齐文档完整

### 生产就绪验收
- [ ] 核心类型有单元测试
- [ ] PIT查询性能 < 100ms
- [ ] 语义版本控制完整
- [ ] 安全审查通过
- [ ] 代码审查完成
- [ ] 金融专家审查通过

### 交付物清单
1. **本体定义**: 8模块 × 40个YAML文件
2. **ADR文档**: ADR-013/014/015
3. **数据绑定**: 15个SemanticMappingDefinition
4. **验证脚本**: validate-m2.js
5. **测试用例**: 核心类型单元测试
6. **文档**: README × 8 + 使用示例 × 15
7. **FIBO对齐**: 50个对齐记录

---
