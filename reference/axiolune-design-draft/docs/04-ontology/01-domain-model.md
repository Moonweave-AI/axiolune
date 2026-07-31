# 金融本体逻辑域

## 1. 域模型总览

| 域 | 回答的问题 | 主要真源 |
| --- | --- | --- |
| Organization & Access | 谁、代表谁、为什么、在哪个环境做什么？ | IdP、HR、组织与策略 |
| Parties | 公司、发行人、券商、托管、供应商和分析师是谁？ | 主数据与外部注册 |
| Instruments & Markets | 交易什么、在哪交易、何时可交易？ | 交易所/供应商主数据 |
| Products & Accounts | 哪个产品、账户、资产单元与通道？ | 产品、柜台、运营 |
| Portfolios & Positions | 持有什么、目标是什么、价值和暴露如何？ | 组合、OMS、托管、估值 |
| Research & Factors | 为什么形成观点、因子/模型如何产生？ | 研究数据、代码与证据 |
| Orders & Execution | 意图如何变成母单、子单、成交？ | OMS、算法商、柜台 |
| Risk & Compliance | 哪些限制、告警、例外与处置？ | RMS、规则、合规 |
| Companies & Events | 公司、财务、公告、宏观和行业发生了什么？ | 公告、财务、新闻 |
| Information & Evidence | 结论依据是什么、来源是否可信？ | 文档、媒体、数据产品 |
| Product & Business | 产品规模、渠道、竞品和经营如何？ | 运营、销售、外部数据 |
| Platform Governance | 数据、函数、模型、应用和发布是否健康？ | 平台元数据与运行证据 |

## 2. 稳定依赖规则

- Organization & Access 可被所有域引用，但不包含业务对象；
- Parties 与 Instruments 是基础参考域；
- Products & Accounts 拥有账户能力，不拥有订单；
- Portfolios 拥有目标和持仓视图，Orders 拥有执行状态；
- Risk 可以判定/限制 Action，不直接写订单表；
- Evidence 连接所有声明，但不决定业务真源；
- Platform Governance 管理资产和版本，不取代业务领域所有者。

## 3. Organization & Access

对象：

- Tenant、LegalEntity、OrganizationUnit；
- Person、Team、Role、ServiceIdentity；
- Purpose、Environment、Entitlement；
- AccessRequest、PolicyDecision、Delegation。

关键链接：

- Person MEMBER_OF Team；
- Role ASSIGNED_TO Subject；
- Subject ENTITLED_TO ResourceScope；
- Delegation DELEGATES ActionScope；
- PolicyDecision AUTHORIZES/DENIES ActionRun。

关键约束：

- 用户身份与交易账户严格分离；
- 委托权限、代操作和有效期显式；
- 入离职、角色变化和权限到期自动同步；
- Break-glass 不继承日常权限。

## 4. Parties

对象：

- Party（Interface）；
- LegalEntity、Issuer、Broker、Custodian；
- AlgoProvider、DataProvider、Distributor；
- Analyst、Client；
- ExternalIdentifier、PartyAlias。

关系有来源和有效期。合并/拆分保留历史 ID、证据和下游影响。

## 5. Instruments & Markets

对象：

- Instrument（Interface）；
- Equity、FundInstrument、Index、FutureContract；
- Venue、Market、TradingSession、TradingCalendar；
- Currency、CorporateAction；
- ClassificationScheme、ClassificationNode、ClassificationMembership；
- InstrumentIdentifier、InstrumentStatus。

关键问题：

- 证券代码历史与多市场映射；
- 合约到期/主力/连续合约；
- 指数与行业成分 point-in-time；
- 复权、停牌、涨跌停、集合竞价和最小价位；
- 公司行动对价格、持仓和回测的影响。

## 6. Products & Accounts

对象：

- FundProduct、Mandate；
- TradingAccount、CashAccount、SubAccount；
- AssetUnit、AccountCapability；
- BrokerConnection、Gateway、SettlementProfile；
- FeeSchedule、MarginProfile。

关系：

- FundProduct OWNS/USES Portfolio；
- FundProduct AUTHORIZED_FOR Account；
- AssetUnit BELONGS_TO Account/Product；
- Account ROUTED_VIA Gateway；
- Gateway PROVIDED_BY Broker。

## 7. Portfolios & Positions

对象：

- Portfolio、StrategyBook、Benchmark；
- TargetPosition、Position、PositionLot；
- CashBalance、Reservation；
- NAVObservation、PnLObservation、ExposureObservation；
- ReconciliationRun、ReconciliationBreak；
- RebalanceProposal。

持仓是已解析的时点视图；调整以事件/Action 形成，不直接改快照。账务要求可另建双重记账 LedgerEntry。

## 8. Research & Factors

对象：

- ResearchProject、ResearchQuestion、Thesis；
- CoverageAssignment、Recommendation；
- Universe、UniverseMembership；
- FactorDefinition、FactorVersion、FactorObservation；
- ResearchRun、BacktestRun、Experiment；
- ModelDefinition、ModelVersion、Signal；
- ValuationModel、RatingScale、Rating；
- StockPool、SimulationPortfolio、ResearchReport。

发布状态：

`Draft → Reproducible → Reviewed → Approved → Published → Deprecated → Retired`

## 9. Orders & Execution

对象：

- OrderIntent、Instruction；
- ParentOrder、ChildOrder、ExternalOrder；
- OrderEvent、Execution、Allocation；
- Transfer、SettlementInstruction；
- AlgoDefinition、AlgoCapability、AlgoConfig；
- ExecutionMetricDefinition、ExecutionMetricObservation；
- GatewaySession。

订单状态、外部状态、规范状态分开；原始回执永不覆盖。

## 10. Risk & Compliance

对象：

- RiskRuleSet、RiskRule、Limit；
- RiskAssessment、RiskAlert、RiskCase；
- Watchlist、WatchlistEntry；
- RiskException、MitigationAction；
- StressScenario、ScenarioResult；
- BorrowAvailability、BorrowReservation；
- ComplianceReport。

每个判定引用规则版本、输入时点、对象范围和缺失策略。

## 11. Companies & Events

对象：

- CompanyProfile、FinancialReport、FinancialMetric；
- Disclosure、EarningsEvent、CorporateEvent；
- ConsensusEstimate、EstimateRevision；
- CalendarEvent、MacroEvent、IndustryEvent；
- Theme、ThemeMembership、MarketNarrative。

来源事实、抽取 Claim 和人工确认事件分开。

## 12. Information & Evidence

对象：

- Source、DataAsset、DatasetSnapshot；
- Document、MediaItem、EvidenceFragment；
- Claim、Citation、ExtractionRun；
- DataLicense、UsageRestriction；
- QualityAssessment。

Claim 结构：

`subject + predicate + object/value + valid time + source + evidence + confidence + review state`

## 13. Product & Business

对象：

- DistributionChannel、Distributor；
- ProductMetricDefinition、ProductMetricObservation；
- CompetitorProduct、PeerGroup；
- Campaign、BusinessTarget；
- ReportDefinition、ReportRun、ReportArtifact。

内部产品和竞品实现可比较 Interface，但保留来源、可比性和许可差异。

## 14. Platform Governance

对象：

- Connector、Connection；
- DataContract、Pipeline、PipelineRun；
- QualityRule、QualityCheckRun、LineageEdge；
- OntologyResource、OntologyRelease、Branch、Scenario；
- FunctionVersion、ModelRelease、PromptVersion；
- AgentDefinition、AgentRun、ToolCall；
- ActionRun、ApprovalTask、WorkflowRun；
- Application、Deployment、Service、SLO、Incident；
- AuditEvent、ExportJob、RetentionPolicy。

## 15. 跨域不变量

1. 所有核心对象使用 canonical ID；
2. 金融事实带业务有效时间和系统记录时间；
3. 派生值带 Function/Model 版本和输入快照；
4. 每个外部值保留来源和原始引用；
5. 订单、动作、规则和报告版本不可静默覆盖；
6. 环境是强制上下文；
7. 权限随对象、属性、证据和导出传播；
8. 任何自动化和 Agent 调用最终进入 Action/Policy；
9. 图、搜索、向量和 OLAP 是投影，显示 as-of；
10. 退役类型保留替代项、下游迁移和历史解析。

