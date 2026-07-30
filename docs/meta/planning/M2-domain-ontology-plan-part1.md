# M2 领域本体实现方案

**版本**: 1.0  
**日期**: 2026-07-29  
**状态**: 规划中  
**前置**: M3元本体v0.5 ✅ 完成

---

## 执行摘要

M3（元本体）已完成并验收，现进入M2（领域本体）构建阶段。M2使用M3定义的语法构建量化金融的具体概念体系。

**核心目标**: 构建生产级量化金融领域本体，支持回测、实盘交易、风险管理、合规报告。

**关键约束**:
- 必须使用M3语法（ObjectTypeDefinition、AssociationTypeDefinition等）
- 必须绑定ADR-012三轴时间语义
- 必须来源于生产系统验证的概念（nautilus_trader、Lean、qlib、FIBO）
- 禁止使用未验证的design-draft概念

**预估规模**:
- 核心模块: 8个
- 类型定义: 200-300个
- 实施周期: 8-12周

---

## 第一部分: M2架构设计

### 1.1 模块分层结构

```
M2/
├── core/                    # 核心基础（第1周）
│   ├── identifiers.yaml     # ISIN、CUSIP、LEI、MIC
│   ├── parties.yaml         # Issuer、Counterparty、Broker
│   └── money.yaml           # Currency、Money、FXRate
├── instruments/             # 金融工具（第2-3周）
│   ├── base.yaml            # Instrument基类、SecurityType枚举
│   ├── equity.yaml          # Equity、CommonStock、PreferredStock
│   ├── fixed-income.yaml    # Bond、ConvertibleBond
│   ├── derivatives.yaml     # Option、Future、Swap
│   └── crypto.yaml          # CryptoCurrency、Perpetual
├── market-data/             # 市场数据（第4周）
│   ├── quotes.yaml          # QuoteTick、BidAsk、L2_OrderBook
│   ├── trades.yaml          # TradeTick、Execution
│   ├── bars.yaml            # Bar、OHLCV、Imbalance、Renko
│   └── market-structure.yaml # Venue、Exchange、TradingSession
├── orders/                  # 订单系统（第5-6周）
│   ├── order-types.yaml     # Market、Limit、Stop、Iceberg
│   ├── order-lifecycle.yaml # OrderState FSM、OrderEvent
│   ├── fills.yaml           # OrderFilled、TradeReport
│   └── contingent.yaml      # OCO、OTO、BracketOrder
├── positions/               # 持仓管理（第7周）
│   ├── position.yaml        # Position、PositionSide、PnL
│   ├── portfolio.yaml       # Portfolio、Account、Balance
│   └── margin.yaml          # MarginRequirement、Leverage
├── strategy/                # 策略系统（第8周）
│   ├── signals.yaml         # Signal、Indicator、Factor
│   ├── rules.yaml           # EntryRule、ExitRule、RiskRule
│   └── backtest.yaml        # BacktestRun、Performance、Metrics
├── risk/                    # 风险管理（第9周）
│   ├── exposure.yaml        # Exposure、VaR、Greeks
│   ├── limits.yaml          # PositionLimit、OrderLimit
│   └── compliance.yaml      # ComplianceCheck、Restriction
└── operations/              # 运营支持（第10周）
    ├── reconciliation.yaml  # ReconRecord、Break
    ├── settlement.yaml      # Settlement、ClearingInstruction
    └── corporate-actions.yaml # Dividend、Split、Merger
```

### 1.2 权威参考源优先级

| 概念域 | 主要参考 | 次要参考 | 禁用 |
|--------|----------|----------|------|
| 工具分类 | nautilus_trader (18子类) | Lean (SecurityType枚举) | design-draft |
| 订单状态机 | nautilus_trader (15状态FSM) | Lean (OrderStatus) | - |
| 持仓模型 | nautilus_trader (事件溯源) | rqalpha (T+1) | - |
| 行情数据 | nautilus_trader (tick/bar) | Lean (TradeBar) | - |
| 因子DSL | qlib (Expression) | vectorbt | design-draft |
| 期权Greeks | Lean (ModeledGreeks) | nautilus_trader | - |
| 标准标识符 | FIBO (ISIN/LEI) | ISO 10962 (CFI) | - |

