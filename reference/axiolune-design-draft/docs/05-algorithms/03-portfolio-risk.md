# 组合、净值、风险、流动性与对账算法规范

## 1. 目的与控制边界

本章定义组合持仓、现金、净值、损益、敞口、优化、VaR/CVaR、压力测试、流动性、融券和多源对账的统一算法口径。输出服务于投资、风险、运营和报告，但不能替代法定估值、托管确认或人工审批。

风险模型是对特定假设下风险的估计，不覆盖所有尾部、流动性、模型和操作风险。所有模型需独立验证、回测/压力测试和持续监控；优化或风险数值不得被描述为收益保证。

## 2. 输入对象、账簿与时点

| 输入 | 关键内容 | 时点 |
| --- | --- | --- |
| `PositionLot` / `Position` | 数量、成本、冻结、来源、账户/组合/标的 | 估值 `as_of`，双时间 |
| `CashBalance` / `Reservation` | 币种、可用/冻结/应收应付 | 账户来源时点 |
| `Execution` / `Allocation` | 成交、费用、归属、结算状态 | 成交/结算时间 |
| `LedgerEntry` | 双重记账分录、币种、科目、冲销 | 业务/系统时间 |
| `Instrument` / `CorporateAction` | 乘数、应计、除权、到期、停牌 | 当时有效/可知 |
| `MarketData` / `FXRate` | 价格、估值源、汇率、质量 | 估值时点与来源 |
| `Portfolio` / `Benchmark` | 基准、基础币种、估值/绩效政策 | 版本化有效期 |
| `FactorExposure` / `ClassificationMembership` | 风格、行业、国家、期限等暴露 | 点时快照 |
| `RiskRuleSet` / `Limit` | 范围、窗口、单位、缺失策略 | 决策时有效版本 |
| `BorrowAvailability` / `BorrowReservation` | 可借量、已占用、费率、召回 | 实时/日终快照 |

关键原则：

- 订单/成交/分录是不可变事件，`Position` 是按时点解析的视图；
- 实盘运营优先以账本/柜台/托管等登记的权威来源为准；
- 估值价和交易价分开，来源优先与降级规则版本化；
- 所有跨币种计算固定 FX 时点、方向和三角校验；
- 日内估算、日终正式净值和法定披露净值是不同 `MetricType`。

## 3. 持仓、现金与账本

### 3.1 持仓演进

对标的 \(i\)：

\[
q_{i,t}=q_{i,t-1}
+q^{buy}_{i,t}
-q^{sell}_{i,t}
+q^{transfer}_{i,t}
+q^{corp}_{i,t}
+q^{adjust}_{i,t}
\]

`adjust` 只能来自经审批、更正原因明确的 Action/分录。证券借贷、期货多空、期权、质押和冻结不能压缩为一个无方向数量；按产品模型分别表达。

### 3.2 双重记账

每个业务事件生成借贷平衡分录：

\[
\sum_e amount^{base}_e=0
\]

跨币种分录同时保存原币金额、汇率、基础币金额和舍入差额科目。冲销通过反向分录，不 UPDATE 原分录。批次级不平衡是 blocking failure。

### 3.3 可用量

\[
available =
settled + allowed\_unsettled
- frozen - reserved - pending\_out
\]

具体结算、T+N、回转、卖空和保证金规则由市场/账户能力决定。研究模拟和生产可用量使用同一稳定接口，但不同来源与策略版本。

## 4. 估值、净值与损益

### 4.1 市值

普通现金证券：

\[
MV_{i,t}=q_{i,t}\times P^{valuation}_{i,t}\times multiplier_i
\]

转换到组合基础币：

\[
MV^{base}_{i,t}=MV^{ccy}_{i,t}\times FX_{ccy\rightarrow base,t}
\]

衍生品按经批准的定价模型、结算价、应计和保证金口径计算；不能一律使用“数量 × 价格”。

估值价优先策略示例：

`official close → valid last trade → executable mid → approved model price → prior approved price`

每次降级均记录价格来源、年龄、原因、haircut 和质量状态。停牌、无报价、极端价和模型价需独立披露。

### 4.2 NAV

\[
NAV_t =
\sum_i MV^{base}_{i,t}
+Cash^{base}_t
+Receivables_t
-Payables_t
-AccruedFees_t
-OtherLiabilities_t
\]

单位净值：

\[
NAVPU_t=\frac{NAV_t}{UnitsOutstanding_t}
\]

份额、应收应付、费用计提、税和估值调整必须使用同一估值截面。分母为零或份额状态未确认时输出 `NotCalculated`，不能以 1 代替。

### 4.3 PnL

总损益的基本守恒：

\[
PnL_t =
NAV_t-NAV_{t-1}
-NetFlow_t
+Distribution_t
\]

交易级可分：

\[
TotalPnL=RealizedPnL+UnrealizedPnL+Income
-Fees-Financing+FXPnL+Adjustments
\]

成本基础可用 FIFO、LIFO、移动平均或监管指定法，但每个产品固定一个版本化政策。日内估算与正式账务差异进入 `ReconciliationBreak`。

### 4.4 收益

含外部现金流的期间收益需明确时间加权或金额加权。简单区间基线：

\[
R_t=\frac{NAV_t-NAV_{t-1}-Flow_t}{NAV_{t-1}^{adjusted}}
\]

大额日内流入流出的调整方法、分红再投资和费用口径必须登记。年化时使用与频率一致的日历，不能机械乘 252 掩盖缺失日。

## 5. 敞口与归因

### 5.1 基本敞口

\[
GrossExposure=\frac{\sum_i |E_i|}{NAV},\qquad
NetExposure=\frac{\sum_i E_i}{NAV}
\]

其中 \(E_i\) 是 delta-adjusted 或经产品定义的经济敞口。普通股票可取市值；期货使用名义金额/Delta；期权需要 Greeks 和定价版本。

维度包括：

- 标的、发行人、集团和对手方；
- 行业、主题、国家/地区、市场；
- 币种、利率期限、信用等级；
- 多空、流动性桶、产品/账户/策略；
- 因子 beta、风格和集中度。

聚合前先统一币种、单位、净额规则和穿透层级。基金/衍生品穿透不完整时同时显示已覆盖比例。

### 5.2 因子风险

线性模型：

\[
r_p=\beta^\top f+\epsilon
\]

\[
\sigma_p^2=\beta^\top\Sigma_f\beta+\sigma_\epsilon^2
\]

因子暴露、协方差、特异风险、估计窗口和收缩方法属于 `ModelVersion`。小样本、结构突变和非线性产品必须披露限制，并使用压力情景补充。

### 5.3 归因

绩效/风险归因可按资产、行业、因子、决策和交易成本分层。各贡献在舍入容差内与总收益/总方差一致；交叉项和残差不能静默丢弃。归因是解释框架，不自动证明因果。

## 6. 组合优化

### 6.1 通用目标

示例均值—风险—成本问题：

\[
\max_w
\quad \hat{\mu}^\top w
-\lambda w^\top\Sigma w
-C(w-w_0)
-\gamma T(w,w_0)
\]

约束可包括：

\[
\mathbf{1}^\top w=1,\quad
l_i\le w_i\le u_i,\quad
A w\le b
\]

以及行业/因子偏离、跟踪误差、换手、现金、杠杆、持股数、可借、参与率和合规限制。

### 6.2 工程规则

- 预期收益、协方差、成本和约束均引用版本；
- 输入只能使用决策时可得数据；
- 单位、币种、年化和收益频率相容；
- 协方差执行 PSD 检查/经批准的收缩；
- 求解状态、gap、迭代、容差和违反约束完整保存；
- 整手/离散化后重新验证所有约束；
- infeasible 时输出最小冲突集/松弛建议，不私自删硬约束；
- 目标对参数、成本、约束和估计误差做敏感性分析；
- 优化结果只生成 `RebalanceProposal`，不直接下单。

### 6.3 失败边界

- NAV 非正、估值覆盖不足或关键输入冲突时阻断；
- 协方差奇异：使用经验证收缩/因子模型或失败，不临时加任意常数；
- 极端集中解：触发集中度/稳定性门；
- 解对微小输入扰动剧烈变化：标记不稳定，需限制或复核；
- 求解超时：返回最近可行解仅在策略允许且显示 optimality gap，否则失败。

## 7. VaR

### 7.1 口径

损失 \(L=-\Delta V\)。置信水平 \(\alpha\)：

\[
VaR_\alpha=\inf\{l:P(L\le l)\ge\alpha\}
\]

必须声明：

- 置信度、持有期和基础币；
- 历史窗口、权重/衰减和缺失日；
- 全重估、Delta-Normal、Delta-Gamma 或其他方法；
- 当前持仓还是滚动历史持仓；
- 市场因子映射、汇率和非线性处理；
- 是否含费用、流动性和信用风险。

### 7.2 历史模拟

1. 固定当前持仓和定价模型；
2. 取得点时一致的历史风险因子冲击；
3. 对每个情景重估组合；
4. 得到损失分布并取经验分位数。

缺失风险因子映射、上市历史太短和制度变化必须有代理与质量标记。代理选择不能用未来表现优化。

### 7.3 参数法

线性正态近似：

\[
VaR_\alpha \approx z_\alpha \sigma_p V
\]

只适用于近似线性且分布假设获验证的组合。非线性、厚尾和流动性不足组合不得仅依赖该数值。

### 7.4 回测

- 比较每日预测 VaR 与后续实际/假设 PnL；
- 记录例外次数、聚类和市场阶段；
- 使用监管/内部要求的覆盖检验和独立性检验；
- VaR 模型、持仓、PnL 口径必须一致；
- 模型变更前后并行运行，例外不能用事后修订数据消除。

## 8. CVaR / Expected Shortfall

\[
ES_\alpha=E[L\mid L\ge VaR_\alpha]
\]

离散样本需正确处理分位点权重，不能简单平均“严格大于 VaR”的样本而忽略边界。ES 对尾部样本数量高度敏感，需报告有效尾部样本、置信区间和稳定性。

可在优化中使用线性化 CVaR，但需记录情景集、权重、求解器和离散化误差。ES 也不等于最大可能损失。

## 9. 压力测试

### 9.1 情景类型

- 历史：金融危机、极端波动、流动性枯竭、汇率/利率冲击；
- 假设：股指、行业、利率曲线、信用利差、FX、波动率联合冲击；
- 反向压力：寻找使 NAV/限额达到阈值的最小冲击；
- 流动性联动：价差扩大、成交量下降、冲击上升、借券召回；
- 操作/对手方：柜台不可用、结算失败、价格源中断。

### 9.2 运行

`StressScenario` 保存因子、相关变化、路径、期限、叙事、适用范围、owner 和版本。`ScenarioResult` 保存对象级损益、风险贡献、限额突破、数据覆盖和模型限制。

若情景是路径依赖的，按时间步更新保证金、现金、止损/限制和流动性，不能只做终点线性相加。风险处置只生成 `MitigationAction` 提案。

## 10. 流动性风险

### 10.1 基本指标

以最大批准参与率 \(\rho_i\) 和保守 ADV：

\[
DaysToLiquidate_i=
\frac{|Q_i|}
{\rho_i\cdot ADV_i}
\]

组合不能简单取平均；应报告在第 \(d\) 天可变现比例、最慢尾部和集中拥挤。ADV 窗口、异常成交过滤、币种和单位固定版本。

Amihud 类指标：

\[
ILLIQ_i=\operatorname{mean}
\left(\frac{|r_{i,t}|}{TurnoverAmount_{i,t}}\right)
\]

价差、深度、零成交天数、冲击曲线和历史压力期应共同使用，不以单一指标下结论。

### 10.2 冲击与清算

可校准平方根冲击基线：

\[
Impact_i \approx \eta_i\sigma_i
\sqrt{\frac{Q_i}{ADV_i}}
\]

这是经验模型，参数和适用范围需实证验证。模拟清算要考虑：

- 组合内标的同时卖出导致的共同冲击；
- ADV 在压力下收缩；
- 涨跌停、停牌、最小量和市场关闭；
- 对冲工具流动性和基差；
- 借券召回/平仓；
- 交易费用和结算现金。

### 10.3 质量门

- ADV/价差/深度新鲜度和覆盖率；
- 低流动性、上市历史短、异常成交单独处理；
- 数量单位与合约乘数正确；
- 清算量不超过持仓/可借和市场能力；
- 压力参数有 owner、校准窗口和审查日期。

## 11. 融券与借券

### 11.1 可借量

\[
AvailableToReserve =
SourceAvailable
-ConfirmedReservations
-PendingReservations
-SafetyBuffer
\]

多来源可借量不能在未验证独立性的情况下相加。来源优先、更新时间、硬/软 locate、费率、期限、召回概率和市场限制分别保存。

### 11.2 预留状态

`Proposed → Checking → Reserved → PartiallyUsed → Used | Released | Expired | Recalled | Failed | Reconciling`

- `BorrowReservation` 使用稳定幂等键；
- 订单提交与借券预留通过工作流/补偿协调；
- 预留成功但订单失败时释放；
- 外部状态未知时不重复占用；
- 召回触发风险告警和受控处置提案；
- 借券费、应计和返还进入现金/损益及对账。

### 11.3 失败策略

来源陈旧、可借量冲突、费率缺失或召回状态未知时，新增卖空默认阻断。已有空头的处置由风险规则决定，不由数据缺失自动强平。

## 12. 多层对账

### 12.1 对账范围

| 对账 | 两侧 | 关键键 |
| --- | --- | --- |
| 订单 | OMS ↔ 算法/柜台 | client/external order ID、账户、标的 |
| 成交 | 柜台 ↔ OMS ↔ 清算 | execution ID、量价、时间、费用 |
| 分配 | 成交 ↔ 产品/组合 | allocation ID、数量、金额 |
| 持仓 | 内部账本 ↔ 柜台/托管 | 账户、标的、结算日 |
| 现金 | 内部账本 ↔ 银行/托管 | 账户、币种、价值日 |
| 净值 | 投资估值 ↔ 运营/估值机构 | 产品、日期、份额、费用 |
| 借券 | 内部预留 ↔ 券源 | locate/reservation、标的、数量 |

### 12.2 规范化与匹配

1. 冻结双方快照和 cut-off；
2. canonical ID、币种、单位、时区和符号规范化；
3. 确定性主键匹配；
4. 对遗留数据用受控组合键/容差匹配；
5. 计算字段差异并分类；
6. 自动关闭零差异和批准容差内项目；
7. 建立 `ReconciliationBreak`，分派、补证、纠正、复核和关闭。

差异：

\[
\Delta_q=q_A-q_B,\qquad
\Delta_{amount}=amount_A-amount_B
\]

金额容差必须按币种、价格精度和业务类型定义；数量/订单 ID 等离散字段通常要求精确一致。

### 12.3 差异分类

- 时间差/在途；
- 标识符映射；
- 缺失或重复；
- 数量、价格、费用、汇率；
- 公司行动；
- 结算/价值日；
- 估值源/模型；
- 舍入；
- 外部更正；
- 未知需调查。

自动匹配模型只能建议，超过阈值或涉及金额/持仓更正时必须人工批准。关闭差异不能修改原始来源；更正用 Action、冲销和新版本。

## 13. 输出对象与 Action

| 算法结果 | 输出对象 | 后续 Action |
| --- | --- | --- |
| 持仓解析 | `Position`、`PositionLot`、`Reservation` | `AdjustPosition` 提案 |
| 估值/NAV/PnL | `NAVObservation`、`PnLObservation` | `ApproveNAV` / `PublishReport` |
| 敞口 | `ExposureObservation` | `CreateRiskCase` |
| 优化 | `RebalanceProposal`、`TargetPosition`（场景） | `ApproveRebalanceProposal` |
| VaR/ES | `RiskAssessment`、`MetricObservation` | `CreateRiskAlert` |
| 压力 | `ScenarioResult` | `ProposeMitigation` |
| 流动性 | `LiquidityAssessment` | `ApplyLiquidityLimit` 提案 |
| 借券 | `BorrowAvailability`、`BorrowReservation` | `ReserveBorrow` / `ReleaseBorrow` |
| 对账 | `ReconciliationRun`、`ReconciliationBreak` | `ResolveReconciliationBreak` |

任何更正、限额调整、强平、下单或净值发布都必须经过对应 Action、策略和审批。

## 14. 质量门与边界

### 14.1 输入阻断

- 持仓/现金/成交 cut-off 不一致且无法解释；
- 关键 ID、单位、币种、乘数或汇率未解析；
- 账本不平衡；
- 估值覆盖低于产品阈值；
- 公司行动冲突；
- 风险模型版本未批准或超适用范围；
- 持仓、借券、账户或限额超新鲜度。

### 14.2 边界处理

- NAV ≤ 0：禁止比例指标或优化，升级处理；
- 价格为零/负值：按资产类型验证，不以通用过滤误删合法负价格；
- 无报价/停牌：按估值政策降级，显示陈旧天数；
- 极端公司行动：独立复核数量与成本基础；
- 新资产无历史：使用批准代理并显示模型风险，或不计算；
- 非线性产品：使用全重估/Greeks 质量门；
- 现金流与估值同刻：按 cut-off 顺序版本化；
- 外部快照晚到：日终结果生成修订版本，不覆盖已发布版本；
- 大规模差异：停止自动纠正，启动事件和来源隔离。

## 15. 版本、血缘、性能与验收

### 15.1 血缘

每个指标能下钻：

`Source/Ledger/Execution → Position Snapshot → Price/FX/Model → NAV/PnL/Exposure/Risk Function → Quality → RiskAssessment/Report/Action`

保存估值政策、成本基础、FX、公司行动、因子模型、协方差、情景、优化器、求解器、流动性/借券和对账规则版本。

### 15.2 性能

- 日内持仓/现金/敞口用事件增量计算，定期全量重算校验；
- 硬风控使用预计算暴露加同步 delta，不能等待批仓；
- 日终 NAV/风险按产品/组合分区并设置数据就绪门；
- 历史 VaR/压力/优化可并行情景，但同一输出固定归约顺序；
- 常用指标物化到 ClickHouse，对象事实保留在权威存储；
- 对账支持分区重跑和断点续作；
- 压测覆盖日内峰值成交、全市场重估、月末组合、海量差异和来源晚到。

### 15.3 验收

1. 成交、公司行动、转入转出、冻结和调整的持仓守恒通过属性测试；
2. 每批账本借贷平衡，冲销不覆盖原分录；
3. 多币种 NAV、费用、现金流、份额和 PnL 通过手算黄金集；
4. 停牌、陈旧价、模型价和 FX 降级有清晰质量与影响；
5. gross/net、行业/币种/因子敞口在穿透不完整时显示覆盖率；
6. 优化约束、不可行、离散化和敏感性通过测试，结果仅为提案；
7. 历史/参数 VaR、ES 边界权重和回测例外与独立实现一致；
8. 历史、假设、路径和反向压力结果可复现；
9. 流动性在 ADV 收缩、停牌、涨跌停和共同冲击下不虚增可变现量；
10. 借券重复预留、超时、释放、到期和召回保持数量守恒；
11. 订单、成交、持仓、现金、NAV 和借券差异全链路可审计；
12. 容量、P99、重算窗口、恢复和日终时限达到批准 SLO；
13. 独立验证、模型限制、监控、阈值和复审周期已登记；
14. 所有界面和报告说明模型局限，且不承诺收益或风险被完全覆盖。
