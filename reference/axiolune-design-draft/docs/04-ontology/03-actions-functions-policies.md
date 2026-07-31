# 动作、函数、模型、策略与工作流

## 1. Action 分类

| 类别 | ActionType | 风险等级 | 默认审批 |
| --- | --- | --- | --- |
| 主数据 | CorrectInstrument、MergeEntity、ChangeClassification | 中/高 | Steward；大范围需复核 |
| 数据 | PublishDataProduct、QuarantineAsset、SwitchSource | 中/高 | Data Owner；生产切源复核 |
| 研究 | RunBacktest、PublishFactor、RetireFactor | 低/中 | 发布需研究复核 |
| 组合 | SetTargetPosition、CreateRebalanceProposal | 中/高 | 基金经理/合规 |
| 交易 | SubmitOrder、PauseOrder、ResumeOrder、CancelOrder | 高 | 按额度和职责分离 |
| 风险 | AddWatchlistEntry、BlockInstrument、ApproveRiskException | 高 | 风控/合规双层 |
| 账户/网关 | EnableAccount、ChangeGateway、ResumeExecutionUnit | 高 | 运维 + 业务复核 |
| 报告 | PublishReport、WithdrawReport | 中/高 | 业务/合规 |
| 权限 | GrantAccess、DelegateAction、RevokeAccess | 高 | Owner + Security |
| 本体/平台 | PublishOntologyRelease、PromoteModel、RollbackDeployment | 高 | 对应变更委员会 |
| AI | CreateActionProposal | 低/中 | 不执行副作用 |

## 2. ActionType 完整结构

```yaml
api_name: SubmitParentOrder
context: [ParentOrder, TradingAccount, Instrument]
parameters:
  - order_id: Identifier
  - expected_version: Integer
  - reason: Text
preconditions:
  - environment_is_explicit
  - order_state_is_approved
  - account_is_enabled
  - market_session_allows_submission
policies:
  - trade_entitlement
  - instrument_watchlist
  - account_and_strategy_limits
approvals:
  mode: policy_driven
idempotency:
  key: order_id
execution:
  workflow: submit-order-v1
  timeout: bounded
  retry: only_before_external_acceptance
compensation:
  action: cancel_if_acknowledged
audit:
  before_after: true
  external_receipts: true
```

实际声明见 `ontology/financial-ontology.yaml`。

## 3. Action 执行状态机

`Draft → Validating → Denied | AwaitingApproval → Approved → Executing → Succeeded | PartiallySucceeded | Failed | UnknownExternalState → Compensating → Compensated | Escalated`

规则：

- `Accepted` 只表示平台受理，不表示外部成功；
- 外部未知不自动重发不可幂等动作；
- 幂等键在类型级定义；
- 任何手工修复也是 Action；
- 结果生成不可变 receipt；
- Action 可在 Scenario 中 dry-run，不触发生产副作用。

## 4. 函数目录

### 4.1 主数据与时间

- ResolveInstrumentIdentifier；
- ResolvePartyIdentity；
- NormalizeCurrencyAndUnit；
- ResolveTradingSession；
- ApplyCorporateAction；
- BuildPointInTimeUniverse。

### 4.2 行情与市场

- BuildOHLCVBar；
- BuildOrderBook；
- DetectSequenceGap；
- CalculateMarketDataLatency；
- CalculateBasis/AnnualizedBasis/ZScore；
- CalculateTWAP/VWAP/ArrivalPrice；
- CalculateMicrostructureFeatures。

### 4.3 因子与研究

- CleanFactor（winsorize/standardize/missing）；
- NeutralizeFactor；
- CalculateIC/RankIC/ICIR；
- CalculateGroupedReturn；
- CalculateFactorTurnover/Decay/Capacity；
- CalculateCorrelation/VIF/Cluster；
- DetectLookAhead/Leakage；
- RunEventDrivenBacktest；
- CalculateAttribution。

### 4.4 组合、交易与风险

- MarkToMarket；
- CalculateNAV/PnL/Exposure；
- OptimizePortfolio；
- CalculateOrderAvailability；
- CalculateImplementationShortfall；
- AttributeExecutionCost；
- CalculateVaR/ExpectedShortfall；
- RunStressScenario；
- EvaluateRiskRuleSet；
- ReconcileOrder/Execution/Position/Cash。

### 4.5 证据、图与 AI

- ParseDocument/OCR/Transcribe；
- ExtractClaimCandidate；
- LinkEntityCandidate；
- RankEvidence；
- TraverseRiskPath；
- PropagateEventImpact；
- BuildPermissionAwareContext；
- VerifyCitationSupport；
- GenerateActionProposal。

## 5. FunctionType 运行语义

每个函数声明：

- 输入/输出 Value/Object/Metric 类型；
- sync/async/batch/stream；
- pure/deterministic/model-assisted；
- event time、as-of 和窗口；
- 缺失、异常和冲突；
- 资源、超时、成本和缓存；
- 数据/模型/代码版本；
- 访问、用途和敏感输出；
- 测试、质量门和 owner。

纯函数可安全缓存；依赖外部实时状态的函数必须声明新鲜度。产生副作用的逻辑不能伪装成 Function，必须由 Action 承载。

## 6. MetricType

指标定义至少含：

- formula/function；
- dimensions、grain；
- unit、currency、precision；
- event/business/system time；
- allowed aggregations；
- numerator/denominator；
- null/zero/not-applicable/not-calculated；
- source priority；
- owner、version、quality；
- applicability。

例如“撤单率”要分别定义母单、子单、委托粒度和分母；“绩效 BP”要定义买卖方向、benchmark 和正负号；附件中的 `VMAP` 需由业务确认是否是 `VWAP` 拼写或独立口径。

## 7. ModelType

模型不等于 Function 实现细节。ModelType 包含：

- task、inputs/outputs；
- training/evaluation snapshots；
- algorithm/artifact/license；
- adapter and serving endpoint；
- performance, uncertainty, limitations；
- risk tier、approval；
- drift and monitoring；
- fallback and retirement。

Function 可以调用 ModelVersion，但对应用暴露稳定的业务输入/输出和回退语义。

## 8. Policy 示例

### 8.1 对象读取

允许读取 Position，当且仅当：

- 主体属于产品/组合授权团队或有审计职责；
- 目的属于 Investment/Risk/Operations/Audit；
- 环境授权匹配；
- 属性分类不超过主体许可；
- 授权未过期。

### 8.2 交易动作

SubmitOrder 要求：

- 交易员对账户和策略有 entitlement；
- RiskAssessment 为 Allow 或在有效例外范围；
- 订单版本未变化；
- 额度、时间、市场和环境符合；
- 大额/敏感动作获得第二审批；
- Agent 不能作为最终审批主体。

### 8.3 导出

ExportData 要求：

- 估算对象数和分类；
- 用途和保存期；
- 禁止字段/脱敏；
- 超阈值审批；
- 水印/加密；
- 短期下载与审计；
- 下游使用限制继承。

## 9. WorkflowType

### 9.1 风险标的闭环

`Detect → CreateAlert → GatherEvidence → Triage → ProposeRestriction → Approve → ExecuteRestriction → Verify → ReviewExpiry`

### 9.2 因子发布

`Draft → PointInTimeCheck → Reproduce → PeerReview → Risk/UsageReview → Publish → Monitor → Deprecate`

### 9.3 报告发布

`FreezeSnapshot → QualityCheck → Generate → AuthorReview → ComplianceReview → Publish → Distribute → Revise/Withdraw`

### 9.4 本体发布

`Branch → Edit → Generate → ContractTest → ImpactAnalysis → SecurityReview → DomainReview → Merge → Materialize → Observe`

## 10. 自动化约束

- 触发条件有 stable ID 和版本；
- recovery 与 trigger 是不同事件；
- 多效果默认并行，不隐式依赖顺序；
- 每对象/批执行明确；
- 重复触发按业务键去重；
- 失败重试和人工介入有上限；
- 自动动作仍执行 Action Policy；
- 高风险只创建 proposal。

