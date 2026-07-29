# 本体、自动化、Agent 与平台运维

## 1. Ontology Studio

面向本体工程师、领域专家和数据 Steward：

- Domain/Namespace；
- ObjectType、InterfaceType、SharedProperty、ValueType；
- LinkType、EventType；
- Metric/Function/Model；
- ActionType、Policy 和 Workflow；
- 默认 Object View、搜索和展示元数据；
- 数据映射、主键、时间和来源；
- 分支、差异、评审、发布和退役；
- 下游影响、质量和索引状态。

编辑器同时提供图形视图、表单和声明文件，不以图形界面为唯一真源。

## 2. Object Explorer

- 全局按类型、属性、关系、时间和空间搜索；
- Token、phrase、prefix、范围和组合过滤；
- 保存对象集；
- 关系图、时间线、地图和统计；
- 对象批量动作；
- 证据、血缘、权限和历史；
- 将对象集传入研究、工作流或报告。

查询能力矩阵明确各入口的搜索语义，避免同一过滤器在全局搜索、属性过滤、前端列表和函数 API 中结果不一致。

## 3. Function & Metric Studio

- 定义输入/输出类型；
- SQL/Python/Java/表达式/模型适配器；
- 点时和缺失语义；
- 单元、黄金数据和性能测试；
- 版本、所有者、权限和成本；
- 发布、弃用和影响；
- 同步查询、流、批或异步执行模式。

## 4. Action & Policy Studio

- 参数与对象上下文；
- 前置/后置条件；
- RBAC/ABAC/ReBAC；
- 审批、职责分离和理由；
- 外部适配器和副作用；
- 幂等、超时、重试和补偿；
- 场景预览、历史回放和测试；
- 可用 UI 和 Agent 工具暴露；
- 审计与结果反馈。

## 5. Automation Studio

触发器：

- 对象集进入/退出条件；
- 领域事件；
- 数据资产/质量状态；
- 时间/交易日历；
- 工作流依赖；
- 人工或外部 webhook。

效果：

- 通知/任务；
- 函数/模型；
- 动作提案；
- 受控动作；
- 报告/数据运行；
- 外部 webhook。

执行顺序、并行、重试和幂等必须显式；多个效果不可依赖未保证的隐式顺序。该约束也可从 Palantir Automate 文档中得到启发。[Automate overview](https://www.palantir.com/docs/foundry/automate/overview/)

## 6. Agent Studio

- 选择本体对象、检索源、函数和动作；
- 定义角色、用途、预算、会话状态和输出 Schema；
- 配置引用、拒答、人工接管和审批；
- 构建评测集并比较模型/提示/工具版本；
- 预览有效权限；
- 影子发布、灰度、监控和回滚；
- 查看每轮检索、工具、策略和结果。

高风险动作默认只允许 `CreateActionProposal`。

## 7. Data Operations

- Connector Registry：来源、负责人、网络、凭证引用和 SLA；
- Pipeline：流/批资产、版本、运行、回填和成本；
- Data Catalog：Schema、语义、质量、血缘、权限和使用；
- Data Health：新鲜度、完整性、分布、业务与点时检查；
- Lineage：跨数据—对象—函数—应用—报告；
- Quarantine：失败数据、修复和再发布；
- Change Management：Schema、来源和影响。

## 8. Model Operations

- 模型/特征/提示/评测集注册；
- 训练、批推理、在线推理；
- 模型适配器和统一 Gateway；
- 准确、漂移、延迟、成本和公平性；
- GPU/CPU 配额；
- 发布、灰度、回滚和退役；
- 风险等级和人工监督。

## 9. Security & Administration

- 用户、团队、组织、角色和服务身份；
- 产品/账户/对象/属性/动作范围；
- 数据分类、用途、保留和导出；
- 权限申请、审批、复核和到期；
- 策略模拟与“为什么允许/拒绝”；
- 秘密、证书和轮换状态；
- 审计搜索与取证导出；
- 许可证、外部供应商和数据授权。

## 10. System Operations

- 服务目录、依赖、版本和负责人；
- SLO、告警、运行手册和维护窗口；
- 环境、配置、Feature Flag 和发布；
- 交易日启动/就绪/收盘检查；
- 容量、成本和配额；
- 备份、恢复和 DR；
- 事件管理、复盘和改进任务；
- 支持工单与 trace/object/action 深链。

原附件中的 crontab、screen、手工恢复和加账号命令应转化为：

- 声明式计划和服务管理；
- 受控运维动作；
- 健康检查和启动门；
- 审批、审计、自动超时与回滚；
- 可演练的运行手册。

## 11. 验收重点

- 本体变更能看到数据、函数、应用和 SDK 影响；
- 对象、动作和策略在分支中端到端测试；
- 自动化重复触发不会产生重复副作用；
- Agent 无法发现或调用未授权资源；
- 运维人员不需要共享静态密码或 SSH 进程管理；
- 平台健康与业务新鲜度在同一事件上下文中可追踪。

