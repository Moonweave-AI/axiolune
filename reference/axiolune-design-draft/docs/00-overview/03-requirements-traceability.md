# 需求—模块—本体—证据追踪矩阵

## 1. 追踪口径

本矩阵把附件中的页面、字段、截图和导出样例重新组织为可实施能力。证据编号 `IMG-n` 对应附件审计中的截图序号；`MD-001` 为需求 Markdown；`CSV-001/002` 为委托与持仓导出；`WEB-*` 为嵌套网页资产。原附件不是正式需求规格，因此：

- `已设计`：已给出模块、本体、技术和验收框架，不代表已完成开发；
- `需确认`：材料可以证明页面存在，但业务语义、规则或权限仍需访谈冻结；
- `归档评估`：材料明确停用或价值不足，迁移前需由业务决定只读、归档或退役；
- 任何截图中的实际数据、账号、网络参数和凭据均不进入本交付物。

## 2. 工作台与数据资讯

| 需求 ID | 附件能力 | 证据 | 目标模块 | 核心对象/函数/动作 | 状态与缺口 |
| --- | --- | --- | --- | --- | --- |
| R-WB-01 | 黑灰名单监控 | IMG-0 | 统一工作台／监控画布 | Watchlist、WatchlistEntry、Instrument、PriceSeries；`AcknowledgeAlert` | 已设计；名单语义、告警阈值和维护权需确认 |
| R-WB-02 | 策略监控卡片 | IMG-1 | 统一工作台／策略健康 | StrategyBook、Portfolio、Signal、SLO；`OpenIncident` | 已设计；空卡片原因、实时频率需确认 |
| R-WB-03 | 市场总览 | IMG-2 | 市场数据工作台 | Instrument、MarketSnapshot、KLine | 已设计 |
| R-WB-04 | 网下打新规模表 | MD-001 | 产品与市场机会 | Offering、Subscription、Allocation | 需确认；附件无字段或截图 |
| R-DI-01 | 财经新闻 | IMG-3 | 资讯与证据中心 | Document、Source、Claim、Citation；检索/关注 | 已设计；内容许可与保存期需确认 |
| R-DI-02 | 互动问答 | IMG-4 | 公司事件与投资者关系 | Communication、Party、Instrument、Claim | 已设计 |
| R-DI-03 | 数据集市与数据字典 | IMG-5、WEB-* | 数据产品目录 | DataProduct、DataAsset、DataContract、SchemaVersion；`RequestAccess` | 已合并设计；去除重复信息架构 |
| R-DI-04 | 投资日历 | IMG-6 | 事件与日历 | CalendarEvent、CorporateEvent、TradingCalendar | 已设计 |
| R-DI-05 | Level-2 查询 | IMG-7 | 市场微观数据 | OrderBookEvent、Quote、TradePrint；事件时间查询 | 已设计；供应商码表和许可需确认 |
| R-DI-06 | 分时/K 线 | IMG-8–9 | 行情与图表 | MarketObservation、KLine、CorporateAction | 已设计；复权和时区规则进入数据契约 |
| R-DI-07 | 期指基差四视图 | IMG-10–12 | 衍生品分析 | FutureContract、Index、BasisObservation、SeasonalSeries；`ComputeBasisBand` | 已设计；0.5–3σ 仅为可配置研究参数 |
| R-MD-01 | 基金、资金账号、资产单元、券商、网关、板块成分 | IMG-13–14、MD-001 | 主数据管理 | FundProduct、TradingAccount、AssetUnit、Broker、Gateway、ClassificationMembership | 已设计；基数、生命周期、归属需确认 |
| R-INF-01 | 图、向量、消息、S3/云存储 | MD-001 | 多模态数据平面 | StorageBinding、Projection、Topic、MediaReference | 已完成职责选型；不得把技术组件当业务真源 |

## 3. 交易、执行与风险

| 需求 ID | 附件能力 | 证据 | 目标模块 | 核心对象/函数/动作 | 状态与缺口 |
| --- | --- | --- | --- | --- | --- |
| R-EX-01 | 算法监控 | MD-001 | 执行控制台 | ParentOrder、ChildOrder、ExecutionMetricObservation | 已设计；VMAP/VWAP 命名需澄清 |
| R-EX-02 | 算法母单 | IMG-15、CSV-001 | OMS／母子单 | ParentOrder、ChildOrder、Execution；`CancelParentOrder` | 已设计；19 位订单号必须为字符串 |
| R-EX-03 | 算法绩效 | IMG-16 | TCA | BenchmarkObservation、TCAResult；TWAP/VWAP/IS 函数 | 已设计；详见算法分册 |
| R-EX-04 | 账户、交易与行情延时 | IMG-17–18 | 执行可观测性 | LatencyObservation、GatewaySession、SLO、Incident | 已设计；需用真实链路校准 SLO |
| R-EX-05 | 算法账户/AUG | MD-001 | 账户与连接管理 | AlgoAccount、AccountCapability、AlgoConfig | 需确认字段、密码迁移和供应商接口 |
| R-EX-06 | 厂商算法能力矩阵 | MD-001 | 算法目录 | AlgoProvider、AlgoDefinition、AlgoCapability、Constraint | 已设计；自然语言规则需结构化并版本化 |
| R-EX-07 | 现有手工启停/盘中改账号 | MD-001 | 平台运行与变更 | Deployment、ChangeRequest、Runbook、ApprovalTask | 替代设计完成；禁止以 screen/强杀进程作为正式方案 |
| R-RK-01 | 股票/期货风控配置与监控 | MD-001 | RMS | RiskRuleSet、Limit、RiskAssessment、RiskAlert | 已设计；规则优先级、缺失策略、豁免需确认 |
| R-RK-02 | 风险标的/黑灰名单 | IMG-19 | 监控与案件 | Watchlist、WatchlistEntry、Evidence、RiskCase | 已设计 |
| R-RK-03 | 事后/快速风控 | MD-001 | 盘后风险与应急控制 | PostTradeAssessment、EmergencyControl；`ActivateKillSwitch` | 已设计；权限和解除流程需双人审批 |
| R-GE-01 | Algohub 策略监控 | MD-001 | 组合与策略运营 | StrategyBook、PortfolioSnapshot、AccountSnapshot | 已设计 |
| R-GE-02 | OMS 概览/持仓/委托/成交/划拨/配置 | IMG-20–22、CSV-001/002 | OMS 与持仓 | Position、Order、Execution、Transfer、ConfigVersion | 已设计；快照/事件、枚举、精度需确认 |
| R-GE-03 | IMS 策略聚合与成交明细 | IMG-23 | 组合/执行联合工作台 | StrategyBook、PnLObservation、Execution、TargetPosition | 已设计 |
| R-GE-04 | 分仓 UFT | MD-001、WEB-* | 分仓与路由 | AllocationRule、Allocation、SubAccount | 需确认；附件仅有名称/实时通道线索 |

## 4. 量化与主动投研

| 需求 ID | 附件能力 | 证据 | 目标模块 | 核心对象/函数/动作 | 状态与缺口 |
| --- | --- | --- | --- | --- | --- |
| R-QR-01 | 分析师行业覆盖、强势股、调入调出 | IMG-24–25 | 覆盖与选股 | CoverageAssignment、Universe、Recommendation | 已设计 |
| R-QR-02 | 单因子回测参数与长因子目录 | IMG-26–68、MD-001 | 因子实验室 | FactorDefinition/Version、UniverseSnapshot、BacktestRun | 已设计；因子公式必须逐一登记而非仅迁移名称 |
| R-QR-03 | 测试结果汇总 | IMG-69 | 因子评测 | ICSeries、GroupReturn、FactorEvaluation | 已设计；无标题列需业务补义 |
| R-QR-04 | 因子相关性 | IMG-70 | 因子去冗余 | CorrelationRun、FactorCluster | 已设计 |
| R-QR-05 | 每日实盘/回测核对 | IMG-71–72 | 组合核对 | ReconciliationRun/Break、NAVObservation；`ResolveBreak` | 已设计；阈值、签署和重跑责任需确认 |
| R-QR-06 | 行业周期研究 | IMG-73 | 历史研究归档 | ResearchRun、ReportArtifact | 归档评估；材料明确已停用 |
| R-QR-07 | WIND65/八大类涨跌幅 | IMG-74–75 | 行业研究 | ClassificationScheme、IndustryReturnSeries | 已设计；数据授权需确认 |
| R-QR-08 | 一致预期研究 | IMG-76–88 | 预期与策略研究 | ConsensusEstimate、EstimateRevision、StrategyEvaluation | 已设计；指标口径和许可需确认 |
| R-QR-09 | 逐笔复盘 | MD-001 | 市场回放 | OrderBookSnapshot、ReplaySession | 已设计；b/s/bs/d 缩写码表需确认 |
| R-QR-10 | 融券管理 | IMG-89 | 券源与融券 | BorrowAvailability、BorrowReservation；`ReserveBorrow` | 已设计 |
| R-AR-01 | 财报披露率与明细 | IMG-90–91 | 公司事件 | FinancialReport、Disclosure、CompanyCoverage | 已设计 |
| R-AR-02 | 可视化估值与评级 | IMG-92 | 估值工作台 | ValuationModel/Run、RatingScale、Rating | 已设计；SS/S/AA/A/B/T 语义需确认 |
| R-AR-03 | 重点监控股票与理由 | IMG-93 | 推荐与跟踪 | Recommendation、Thesis、Evidence、TrackingEvent | 已设计 |
| R-AR-04 | 项目报告与路演日历 | IMG-94 | 研究项目 | ResearchProject、RoadshowEvent、ResearchReport | 已设计 |
| R-AR-05 | 股票池及模拟盘 | IMG-95–96 | 研究场景 | StockPool、SimulationPortfolio、Scenario | 已设计；与生产组合强隔离 |
| R-AR-06 | 主题点亮 | IMG-97 | 主题知识域 | Theme、ThemeMembership、Vote | 已设计；热度不能替代研究证据 |
| R-AR-07 | 指数估值与二阶段 PB | IMG-98–100 | 估值统计 | ValuationObservation、ScenarioResult | 已设计；公式和样本口径需模型审批 |
| R-AR-08 | AI 景气度仪表盘 | IMG-101、WEB-027 | 主题与 AI 监控 | IndicatorDefinition/Observation、ThresholdPolicy、Citation | 已设计；静态快照改为服务端数据与新鲜度标识 |

## 5. 产品、经营与客服

| 需求 ID | 附件能力 | 证据 | 目标模块 | 核心对象/函数/动作 | 状态与缺口 |
| --- | --- | --- | --- | --- | --- |
| R-PR-01 | 市场观察 | IMG-102 | 产品投研门户 | MarketSnapshot、LiquidityMetric、ValuationMetric | 已设计 |
| R-PR-02 | 规模/申赎/渠道仪表盘 | IMG-103–105 | 产品经营 | ProductMetricObservation、DistributionChannel、FlowObservation | 已设计；空状态需区分无数据/未计算/无权限 |
| R-PR-03 | 竞品筛选、上传、导出 | IMG-106–107 | 竞品分析 | CompetitorProduct、PeerGroup、ReportRun、ExportJob | 已设计；许可和可比性需确认 |
| R-PR-04 | 智能报表/公式/收益 | IMG-108 | 指标与报告中心 | MetricDefinition、FormulaVersion、ReportDefinition/Run | 已设计 |
| R-PR-05 | 结算估值/费率 | IMG-108 | 结算与运营 | Settlement、ValuationBreak、FeeSchedule | 已设计；字段需补充 |
| R-PR-06 | TRS 持仓/交易流水 | IMG-108 | 合约与交易运营 | TotalReturnSwap、Position、CashFlow、Trade | 需确认；附件只有导航 |
| R-PR-07 | 客户、沟通、申赎、开放日 | IMG-108 | 客户与渠道 | Client、Communication、Subscription、Redemption、OpenDay | 需确认；合规、PII、录音保存要求需冻结 |

## 6. 横向需求与安全整改

| 需求 ID | 横向问题 | 证据 | 设计落点 | 验收要求 |
| --- | --- | --- | --- | --- |
| R-X-01 | 四套视觉语言并存 | IMG-0–108 | 统一 Token、亮/暗主题、密度模式、语义色和组件层 | 同一对象/状态跨页面表达一致；WCAG 关键流程检测 |
| R-X-02 | 明文凭据、内部端点、人工命令 | MD-001、WEB-* | Vault/KMS/HSM、工作负载身份、GitOps、审批与审计 | 凭据轮换；代码/文档/镜像扫描无秘密；禁用共享账号 |
| R-X-03 | 超大整数 ID | CSV-001 | `Identifier` 值类型与字符串契约 | 浏览器、API、导出往返不丢精度 |
| R-X-04 | 枚举/单位/0/空值混乱 | CSV-001/002 | ValueType、CodeSet、Money/Quantity、MissingReason | 契约测试覆盖每个码表版本和缺失原因 |
| R-X-05 | 通用 SQL/前端权限风险 | WEB-* | Object/Action API、参数化查询、ABAC/ReBAC、审计 | 服务端负例测试证明不能越权或任意执行 SQL |
| R-X-06 | 生产/仿真/测试混用风险 | IMG-20–23 | Environment 强制上下文、颜色+文字+边框三重提示 | 生产 Action 不接受非生产对象；跨环境复制有审批 |
| R-X-07 | 原图中的个人信息与业务数据 | IMG-*、WEB-* | 证据最小化、脱敏、DLP、授权与留存 | 原始截图不随设计包分发；访问与导出可审计 |

## 7. 关闭追踪项的规则

每个 `需确认` 项关闭时必须留下：业务定义、对象/动作映射、数据 owner、权限矩阵、状态机或公式版本、SLO、异常与补偿、测试样例、迁移规则、审批记录。页面“看起来一致”不能作为需求关闭证据。
