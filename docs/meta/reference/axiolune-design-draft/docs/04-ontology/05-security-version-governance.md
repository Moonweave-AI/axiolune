# 本体安全、版本、分支与治理

## 1. 权限层次

| 层 | 控制 |
| --- | --- |
| Ontology/Domain | 谁能查看/编辑领域资源 |
| Type | 谁能发现和查询某类型 |
| Object | 哪些实例可见 |
| Property | 哪些属性可见/脱敏 |
| Link | 是否能发现关系与终点 |
| Function/Metric | 谁能执行、对哪些对象 |
| Action | 谁能发起、审批、执行 |
| View/Search/Export | 显示、聚合、下载和分享 |
| Agent Tool | 哪个 Agent 在何用途可调用 |

Palantir 官方文档说明对象和属性策略可形成 row、column、cell-level 控制，并与数据源策略区分；本方案同样要求本体层与物理数据层纵深执行。[Manage object security](https://www.palantir.com/docs/foundry/object-permissioning/managing-object-security/)

## 2. 权限传播

- 派生指标继承所有输入中最严格的分类/许可/用途；
- 文档 chunk 和 embedding 继承原文 ACL；
- 图边同时检查边和两端；
- 聚合需要防推断阈值；
- 分享只分享视图定义，不复制越权数据；
- 导出保留水印、分类和到期；
- Agent 的权限不超过发起主体与 Agent 自身白名单的交集。

## 3. 编辑权限

编辑 Link 需要相应 LinkType 与两端类型权限；编辑 ActionType 需要其涉及全部资源的权限。该设计参考 Palantir 对 link/action 编辑权限的明确要求。[Ontology permissions](https://www.palantir.com/docs/foundry/object-permissioning/ontology-permissions/)

## 4. 版本

### 4.1 不可变发布

- 草稿可变；
- 发布版本不可变；
- 修复产生新 patch/minor；
- 破坏性变化产生 major 和迁移；
- SDK 绑定精确或兼容范围；
- 运行记录精确版本。

### 4.2 兼容性

兼容：

- 新增 optional property；
- 新增类型/动作；
- 扩展枚举需消费者容错；
- 新增无副作用函数。

潜在破坏：

- 删除/重命名 API name；
- 改类型/单位/时间语义；
- 改 Link 基数或方向；
- 收紧/放宽权限；
- 改 Action 副作用、幂等或审批；
- 改 Metric 分子分母；
- 改数据主键/解析策略。

## 5. 生命周期

`Example → Experimental → Active → Deprecated → Retired`

Promoted 是质量/可发现性标记，不替代 Active。Deprecated 需：

- replacement；
- migration guide；
- last supported date；
- downstream inventory；
- no-new-dependency gate；
- owner；
- archived history。

附件中的“行业周期研究（已停用）”应按此流程处理。

## 6. Global Branch

参考 Palantir Global Branching 的统一分支思想，本方案一个工程分支可以包含：

- 数据契约/管线；
- 本体类型/映射；
- 函数/指标/模型；
- 策略/动作/工作流；
- SDK/应用；
- 测试与迁移。

Palantir 官方说明 Global Branching 可在同一分支修改数据集逻辑和 Schema，并在 Ontology Manager 看到同分支变化；Actions 也能在分支运行而不写 main。[Global Branching](https://www.palantir.com/docs/foundry/global-branching/overview/)；[Branching action types](https://www.palantir.com/docs/foundry/action-types/branching-action-types/)

## 7. 分支流程

1. 从 main 和数据快照创建；
2. 声明变更意图和 owner；
3. 编辑和生成制品；
4. 单元、契约、权限和迁移测试；
5. 在 Replay/Scenario 运行；
6. 计算下游影响和成本；
7. 领域、数据、安全和运维评审；
8. rebase/解决冲突；
9. 合并、物化和灰度；
10. 观察、回滚或完成。

分支有 TTL 和数据预算，禁止长期平行真源。

## 8. Scenario

Scenario 是业务 what-if 覆盖层：

- 固定 base snapshot；
- 只保存变化；
- 所有读取、函数、指标和动作在场景上下文执行；
- 外部副作用禁用或模拟；
- 可比较 main vs scenario；
- 有 owner、用途、有效期和权限。

Palantir OSDK 当前支持 scenario-scoped client；本方案也要求场景上下文贯穿对象读取、聚合和动作预览。[Use scenarios with OSDK](https://www.palantir.com/docs/foundry/ontology/osdk-scenario/)

## 9. 发布门

- Schema/SDK/API 兼容；
- 数据映射和主键唯一；
- 质量与新鲜度；
- 对象/属性/动作权限负向测试；
- Action 幂等、审批和补偿；
- 性能和容量；
- 下游应用视觉/交互；
- 迁移、回填和回滚；
- 文档、owner 和支持；
- 合规/许可。

## 10. 组织治理

| 角色 | 职责 |
| --- | --- |
| Domain Owner | 业务边界、优先级、最终语义 |
| Ontology Architect | 元模型、跨域一致、兼容性 |
| Data Steward | 来源、映射、质量和冲突 |
| Function/Model Owner | 逻辑、评测和监控 |
| Action Owner | 不变量、副作用和运行手册 |
| Security/Compliance | 分类、策略、审批和证据 |
| Application Owner | ObjectView、工作流和体验 |
| SRE | 容量、SLO、发布、恢复 |

跨域设计由轻量 Ontology Council 审查共享类型、API 名、权限和破坏性变化；不审批每个普通属性。

