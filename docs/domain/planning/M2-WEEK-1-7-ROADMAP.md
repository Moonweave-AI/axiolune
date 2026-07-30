## 4. 实施路线图 (Week 1-7)

### 4.1 Week 1: 核心基础 (2026-07-30 至 08-05)

#### 目标
建立M2的基础类型，完成第一个可验证的模块。

#### 交付物

**1. ADR-013: M2架构决策**
- 主题: M2领域本体架构决策
- 内容: 8层模块分层、继承vs组合、中国市场扩展、FIBO对齐策略

**2. ontology/domain/core/identifiers.yaml**
- ISIN (ISO 6166) - exactMatch to FIBO
- CUSIP
- LEI (ISO 17442)
- MIC (ISO 10383)

**3. ontology/domain/core/parties.yaml**
- Issuer, Counterparty, Broker, Custodian

**4. ontology/domain/core/money.yaml**
- Currency (ISO 4217), Money, FXRate

**5. scripts/validate-m2.js**
验证检查项:
- M3语法合规
- ADR-012时间语义
- 模块依赖完整性
- FIBO对齐完整性
- 禁止design-draft引用

**6. 第一个数据绑定示例**
- ISIN查找映射，符合ADR-011/012

#### 验收标准
- ADR-013发布并Accepted
- core模块3个YAML文件完成
- validate-m2.js通过所有检查
- 第一个数据绑定示例验证通过
- 核心4个标识符有FIBO exactMatch

---

### 4.2 Week 2-3: 金融工具 (2026-08-06 至 08-19)

#### 目标
定义8大金融工具类及18个子类。

#### 交付物

**1. ontology/domain/instruments/base.yaml**
- Instrument基类
- SecurityTypeEnum (EQUITY, BOND, OPTION, FUTURE, SWAP, CRYPTO, ETF)

**2. ontology/domain/instruments/equity.yaml**
- Equity基类
- CommonStock, PreferredStock, ADR, ETF

**3. ontology/domain/instruments/derivatives.yaml**
- Option, CallOption, PutOption
- Future, Swap, Forward

**4. ontology/domain/instruments/crypto.yaml**
- CryptoCurrency, CryptoPerpetual, CryptoFuture

**5. ontology/domain/instruments/china-extensions.yaml**
- AShare (A股 - T+1, 涨跌停10%)
- BShare (B股 - USD/HKD交易)
- ChiNextShare (创业板 - 涨跌停20%)
- STARShare (科创板 - 涨跌停20%)

#### 验收标准
- 8大工具类定义完成
- 18个子类完整（对照nautilus_trader）
- 核心工具类有FIBO exactMatch
- 中国市场扩展定义完成
- validate-m2.js通过

#### 参考来源
- nautilus_trader: model/instruments.pyx (18子类)
- Lean: Common/Securities/SecurityType.cs
- FIBO: SEC-SEC模块

---

### 4.3 Week 4: 市场数据 (2026-08-20 至 08-26)

#### 目标
定义行情数据结构，实现ADR-012三轴时间绑定。

#### 交付物

**1. ontology/domain/market-data/quotes.yaml**
- QuoteTick (bidPrice, askPrice, bidSize, askSize)
- L2_OrderBook (Level 2深度行情)
- BBO (Best Bid Offer)

**2. ontology/domain/market-data/trades.yaml**
- TradeTick (价格, 数量, 方向)
- Execution
- VolumeWeightedPrice

**3. ontology/domain/market-data/bars.yaml**
- Bar基类 (OHLCV)
- TimeBar, VolumeBar, TickBar
- Imbalance, Renko, HeikinAshi

**4. ontology/domain/market-data/market-structure.yaml**
- Venue, Exchange
- TradingSession, MarketPhase

**5. 数据绑定示例**
- QuoteTickMapping (三轴时间绑定)
- TradeTickMapping
- BarMapping

#### 验收标准
- QuoteTick, TradeTick, Bar定义完成
- 所有时序数据类型绑定ADR-012三轴
- 3个数据绑定示例通过验证
- validate-m2.js检查temporal字段完整性

#### 参考来源
- nautilus_trader: model/data.pyx
- ADR-012: 三轴时间语义规范

---

### 4.4 Week 5-6: 订单系统 (2026-08-27 至 09-09)

#### 目标
实现完整的15状态订单FSM。

#### 交付物

**1. ADR-014: 订单状态机设计**
- 主题: 订单生命周期状态机
- 决策: 15状态 vs 简化状态，采用nautilus_trader完整15状态
- 理由: 生产系统验证、审计追溯

**2. ontology/domain/orders/order-lifecycle.yaml**
- OrderState枚举 (15状态)
  - INITIALIZED, SUBMITTED, ACCEPTED
  - PENDING_UPDATE, PENDING_CANCEL, PENDING_REPLACE
  - TRIGGERED, PARTIALLY_FILLED, FILLED
  - CANCELED, REJECTED, EXPIRED, REPLACED, DENIED, SUSPENDED
- OrderEvent基类 (16事件类型)
- 状态转换表文档

**3. ontology/domain/orders/order-types.yaml**
- Market, Limit, Stop, StopLimit
- Iceberg, TWAP, VWAP
- TrailingStop, TrailingStopLimit

**4. ontology/domain/orders/fills.yaml**
- OrderFilled
- PartialFill
- TradeReport

**5. ontology/domain/orders/contingent.yaml**
- OCO_Order (One-Cancels-Other)
- OTO_Order (One-Triggers-Other)
- BracketOrder (入场+止盈+止损)

**6. ontology/domain/orders/china-orders.yaml**
- ReverseRepo (逆回购)
- BondPledgeRepo (债券质押式回购)

#### 验收标准
- ADR-014发布
- 15状态FSM完整定义
- 16事件类型定义
- 状态转换表文档化
- OCO/OTO/Bracket订单关联定义
- 中国市场订单类型定义

#### 参考来源
- nautilus_trader: model/orders.pyx (15状态FSM)
- Lean: Common/Orders/

---

### 4.5 Week 7: 持仓管理 (2026-09-10 至 09-16)

#### 目标
实现事件溯源持仓模型，支持T+1交易制度。

#### 交付物

**1. ADR-015: 持仓与PnL计算**
- 主题: 持仓模型与盈亏计算
- 决策: FIFO vs LIFO，采用FIFO
- T+1实现: 使用T1Position子类型
- 理由: 合规要求、中国市场T+1规则

**2. ontology/domain/positions/position.yaml**
- Position基类
- PositionSide枚举 (LONG, SHORT, FLAT)
- PositionEvent (事件溯源)
- PositionEventType枚举

**3. ontology/domain/positions/china-positions.yaml**
- T1Position (T+1持仓)
  - totalQuantity (总持仓)
  - availableQuantity (可卖数量)
  - frozenQuantity (冻结数量)
  - todayBuyQuantity (当日买入，不可卖)
- 不变式: totalQuantity = availableQuantity + frozenQuantity + todayBuyQuantity

**4. ontology/domain/positions/pnl.yaml**
- RealizedPnL (已实现盈亏)
- UnrealizedPnL (浮动盈亏)
- Commission (佣金)
- NetPnL (净盈亏)

**5. ontology/domain/positions/portfolio.yaml**
- Portfolio
- Account
- Balance
- NetLiquidation (净清算价值)

**6. ontology/domain/positions/margin.yaml**
- MarginRequirement
- InitialMargin
- MaintenanceMargin
- MarginCall

#### 验收标准
- ADR-015发布
- Position基类定义
- PositionEvent事件溯源模型
- T1Position中国T+1支持
- PnL计算模型定义
- Portfolio/Account关联定义

#### 参考来源
- nautilus_trader: model/position.pyx (事件溯源)
- rqalpha: T+1交易制度实现

---
