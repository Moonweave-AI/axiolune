# 核心对象与链接目录

## 1. 核心对象字段

以下是首个发布包必须包含的最小对象集；更细字段见机器可读清单。

### 1.1 Instrument

关键属性：

- canonical_id、instrument_type；
- primary_symbol、exchange_code、name；
- currency、price_precision、quantity_unit、lot_size；
- issue/list/delist/maturity dates；
- trading_status；
- valid/system time；
- source、quality、classification。

链接：

- ISSUED_BY Issuer；
- TRADED_ON Venue；
- CLASSIFIED_AS ClassificationMembership；
- HAS_CORPORATE_ACTION CorporateAction；
- UNDERLYING/CONSTITUENT_OF Instrument。

### 1.2 FundProduct / Portfolio / Account / AssetUnit

`FundProduct`：产品代码、名称、法人、策略、基准、币种、状态。  
`Portfolio`：组合类型、基准、估值口径、负责人、状态。  
`TradingAccount`：账户类型、市场、券商、环境、状态、能力，不含秘密。  
`AssetUnit`：代码、名称、类型、所属产品/账户、杠杆、状态、连接引用。

关键链接：

- Product HAS_PORTFOLIO Portfolio；
- Portfolio USES_BENCHMARK Instrument；
- Product AUTHORIZED_FOR TradingAccount；
- AssetUnit BELONGS_TO Product/Account；
- TradingAccount CONNECTED_VIA Gateway。

### 1.3 Position / TargetPosition

Position：

- portfolio/account/instrument；
- quantity、available、frozen；
- cost、market_value、currency；
- realized/unrealized PnL；
- source_snapshot、as_of；
- quality/reconciliation state。

TargetPosition：

- target quantity/weight/value；
- source strategy/signal；
- effective window；
- constraints、approval；
- current deviation。

### 1.4 ParentOrder / ChildOrder / Execution

ParentOrder：

- order_id 字符串；
- instruction、account、instrument；
- side、order type、quantity、limit；
- algo provider/definition/config version；
- start/end、state、filled/remaining；
- benchmarks、environment、version。

ChildOrder：

- parent、external order ID；
- venue/gateway、quantity/price/type；
- normalized state、external state；
- sent/ack/update times；
- reject code/source/message。

Execution：

- execution ID、child order；
- quantity、price、amount、fee；
- venue/time/trading date；
- source sequence、operator、currency、hedge/margin flags。

### 1.5 FactorDefinition / FactorVersion / BacktestRun

FactorDefinition 保存稳定身份和假设。FactorVersion 保存表达式、输入、频率、lag、清洗、中性化和实现。BacktestRun 保存：

- factor/model versions；
- point-in-time dataset snapshots；
- universe/benchmark；
- date、rebalance、horizon/group；
- execution/fee/slippage；
- code commit/image/seed；
- outputs、quality、review。

### 1.6 RiskRule / RiskAssessment / RiskAlert

RiskRule：

- scope、condition、threshold/unit/window；
- hard/warn/approve；
- priority/conflict；
- missing/freshness policy；
- effective period、owner、version。

RiskAssessment：

- subject/object/action；
- input snapshot；
- rule set/version；
- decision、metrics、reason；
- latency、time、evidence。

RiskAlert：

- severity、status、first/last seen；
- affected objects；
- assessment/rules/evidence；
- assignee、SLA、mitigation/outcome。

### 1.7 Document / Claim / EvidenceFragment

Document 保存原件引用、来源、许可、hash、版本和时间。EvidenceFragment 保存页/段/时间片/框坐标。Claim 保存结构化声明、置信、复核和反证。Citation 把结论精确指向 fragment。

## 2. 首批 LinkType

| API 名 | 起点 → 终点 | 基数 | 时间/证据 |
| --- | --- | --- | --- |
| `issuedBy` | Instrument → Issuer | N:1 | 有效期 |
| `tradedOn` | Instrument → Venue | N:M | 有效期 |
| `classifiedAs` | Instrument → ClassificationMembership | 1:N | 双时间、来源 |
| `constituentOf` | Instrument → Index | N:M | 权重、双时间 |
| `productHasPortfolio` | FundProduct → Portfolio | 1:N | 有效期 |
| `portfolioUsesBenchmark` | Portfolio → Instrument | N:1 | 有效期 |
| `productAuthorizedForAccount` | FundProduct → TradingAccount | N:M | 审批、有效期 |
| `assetUnitBelongsToAccount` | AssetUnit → TradingAccount | N:1 | 有效期 |
| `accountConnectedViaGateway` | TradingAccount → Gateway | N:M | 环境、有效期 |
| `portfolioHasPosition` | Portfolio → Position | 1:N | as-of |
| `positionInInstrument` | Position → Instrument | N:1 | as-of |
| `portfolioHasTarget` | Portfolio → TargetPosition | 1:N | 场景/有效期 |
| `targetForInstrument` | TargetPosition → Instrument | N:1 | 有效期 |
| `signalTargetsInstrument` | Signal → Instrument | N:M | 置信/有效期 |
| `orderImplementsInstruction` | ParentOrder → Instruction | N:1 | 不可变 |
| `orderForInstrument` | Order → Instrument | N:1 | 不可变 |
| `orderUsesAccount` | Order → TradingAccount | N:1 | 不可变 |
| `parentHasChild` | ParentOrder → ChildOrder | 1:N | 不可变 |
| `childHasExecution` | ChildOrder → Execution | 1:N | 不可变 |
| `orderUsesAlgo` | ParentOrder → AlgoDefinition | N:1 | 版本 |
| `assessmentEvaluatesAction` | RiskAssessment → ActionRun | N:1 | 不可变 |
| `alertAffectsObject` | RiskAlert → Identified | N:M | 证据 |
| `watchlistEntryTargets` | WatchlistEntry → Instrument/Party | N:1 | 双时间 |
| `exceptionOverridesRule` | RiskException → RiskRule | N:1 | 审批/有效期 |
| `researchUsesSnapshot` | ResearchRun → DatasetSnapshot | N:M | 不可变 |
| `factorDerivedFromAsset` | FactorVersion → DataAsset | N:M | 版本/血缘 |
| `backtestEvaluatesFactor` | BacktestRun → FactorVersion | N:M | 不可变 |
| `reportCitesEvidence` | ReportRun → EvidenceFragment | N:M | 精确引用 |
| `claimSupportedBy` | Claim → EvidenceFragment | N:M | 支持/反对 |
| `documentMentionsObject` | Document → Identified | N:M | 抽取/复核 |
| `actionExecutedBy` | ActionRun → Subject | N:1 | 审计 |
| `actionAffectsObject` | ActionRun → Identified | N:M | 前后版本 |
| `approvalApprovesAction` | ApprovalTask → ActionRun | N:1 | 审计 |
| `dataAssetBacksObjectType` | DataAsset → ObjectType | N:M | 映射版本 |
| `functionProducesMetric` | FunctionVersion → MetricType | N:M | 版本 |
| `agentUsedTool` | AgentRun → ToolCall | 1:N | 不可变 |
| `toolInvokesFunctionOrAction` | ToolCall → Function/Action | N:1 | 版本 |

## 3. 关系对象

以下关系应建成对象而不是简单边：

- ClassificationMembership：方案、节点、权重、有效期、来源；
- UniverseMembership：样本、权重、纳入/剔除原因和点时；
- CoverageAssignment：分析师、行业/公司、角色和期限；
- ThemeMembership：主题、对象、证据、置信和复核；
- Entitlement：主体、资源范围、动作、用途和期限；
- Delegation：委托人、代理人、范围和期限；
- AccountCapability：市场、方向、业务类型、额度和状态；
- ReconciliationBreak：两侧来源、差异、原因和处置。

## 4. 基数与完整性

- 每个 Order 必须有且只有一个 environment、account、instrument 和 side；
- Execution 必须关联一个已知 ChildOrder 或显式 Unmatched 状态；
- Position 必须有 portfolio/account/instrument/as_of；
- Published FactorVersion 必须有可复现 ResearchRun；
- Claim 至少有一个 EvidenceFragment 或状态为 Unsupported；
- RiskException 必须有 rule、scope、审批和 expires_at；
- ActionRun 必须有 actor、action type/version、idempotency key 和 audit；
- 媒体/附件只通过 MediaReference，不能把二进制内嵌对象 JSON。

## 5. 链接权限

查看链接需要：

1. 有权查看 link type；
2. 有权查看起点对象；
3. 有权查看终点对象；
4. 满足属性/用途/时间策略。

不可因知道边存在而泄露不可见对象。聚合结果需要最小群体阈值或差分策略，防止从计数反推受限对象。

