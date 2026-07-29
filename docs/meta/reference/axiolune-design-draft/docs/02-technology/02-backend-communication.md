# 后端、接口与通信

## 1. 服务形态

### 1.1 模块化核心

首期将本体元数据、动作、审批、协同、产品经营等中等负载能力放入边界清楚的 Java 模块化核心，可独立打包或按证据拆分。使用架构测试禁止跨模块绕过公开接口。

### 1.2 独立服务

以下能力从一开始独立：

- 行情接入与标准化；
- 交易/柜台适配器；
- OMS/RMS 关键路径；
- Kafka/Flink 流处理；
- ClickHouse 查询；
- 搜索/图/向量；
- 媒体处理；
- 模型推理；
- Notebook/研究任务。

## 2. Java 栈

- Java 当前 LTS，经组织兼容性验证后冻结；
- Spring Boot、Spring Security、Spring Data；
- Gradle Version Catalog/BOM；
- jOOQ 或显式 SQL 处理复杂查询；JPA 只用于适合的简单聚合；
- Flyway/Liquibase 管理数据库迁移；
- Resilience4j 处理超时、限流、断路和重试；
- Micrometer + OpenTelemetry；
- Testcontainers 做集成测试。

关键交易服务避免反射过重、不可控 ORM 查询和无边界线程池；所有超时、队列、批量和内存上限显式配置。

## 3. Python 栈

- Python 当前受支持版本；
- FastAPI + Pydantic 负责服务契约；
- Polars/PyArrow/DuckDB 负责本地和中等规模列式计算；
- Spark/Flink/Ray 只在规模触发时使用；
- uv/锁文件和内部制品源保证可复现；
- MLflow 记录实验与模型；
- Ruff、mypy/pyright、pytest、Hypothesis；
- 生产服务以镜像和只读依赖运行，禁止从 Notebook 目录直接启动。

## 4. Rust/C++ 边界

只用于：

- 供应商原生 SDK；
- 共享内存/低时延行情；
- 柜台会话和严格延迟预算；
- 经 Java/Python 方案压测不能达到的关键路径。

对平台暴露 Protobuf/gRPC 或 Kafka 规范事件，保留原始报文和来源序号。禁止业务规则分叉成与 Java RMS 不一致的隐式实现。

## 5. API 分工

| 类型 | 适用场景 | 约束 |
| --- | --- | --- |
| REST/OpenAPI | 外部集成、命令、资源管理、下载任务 | 幂等键、ETag、错误模型、版本 |
| GraphQL | 对象详情、关系、聚合和应用 BFF | 查询成本、深度、字段级权限、持久查询 |
| gRPC/Protobuf | 内部低延迟/强类型调用 | Deadline、兼容字段号、重试语义 |
| Kafka/AsyncAPI | 已发生事实、CDC、异步命令与状态 | Schema、键、顺序、去重、保留 |
| WebSocket | 行情、订单、风险和任务实时推送 | 订阅授权、背压、恢复游标 |
| SSE | 单向低频通知或长任务进度 | 断线重连、Last-Event-ID |

## 6. API 设计规则

- URI 和字段使用稳定 API 名，展示名可本地化；
- 时间使用带时区的 ISO 8601，交易日另设字段；
- 金额和价格使用 decimal 字符串或明确定点类型，不用二进制浮点；
- 列表使用游标分页，避免深 offset；
- 大查询返回异步任务，不阻塞网关；
- 写操作包含 `idempotency_key`、`expected_version` 和 `reason`；
- 错误采用稳定 code、可读 message、retryable、field_errors 和 trace_id；
- 批量接口逐项返回结果，不以整体 200 掩盖部分失败；
- PII、权限和来源字段不得被通用序列化器意外暴露。

## 7. 对象与动作 SDK

从本体发布版本生成：

- TypeScript：前端对象查询、动作参数和实时事件；
- Java：领域服务与集成；
- Python：研究与 Agent 工具；
- OpenAPI：其他语言和外部系统。

SDK 只包含应用获准使用的对象、动作和函数。生成产物记录本体版本、兼容范围和权限声明；API 名变化视为破坏性变更。

## 8. 事件规范

所有领域事件包含：

```json
{
  "event_id": "uuid",
  "event_type": "OrderAccepted",
  "event_version": 1,
  "aggregate_type": "Order",
  "aggregate_id": "canonical-id",
  "aggregate_version": 42,
  "occurred_at": "2026-07-27T09:31:05.123456+08:00",
  "recorded_at": "2026-07-27T09:31:05.125000+08:00",
  "environment": "SIMULATION",
  "actor": {"type": "service", "id": "oms"},
  "correlation_id": "uuid",
  "causation_id": "uuid",
  "trace_id": "trace",
  "classification": ["INTERNAL"],
  "payload": {}
}
```

事件 Schema 只追加兼容字段；删除/改义需新版本。敏感字段不因 Kafka 是“内部系统”而免除权限和加密。

## 9. 可靠性模式

- Transactional Outbox：事务状态与待发事件同库提交；
- Inbox/去重：消费者按 event_id 和业务键幂等；
- Saga：跨域长事务与补偿；
- Retry：仅对已知幂等且可重试的操作；
- Dead Letter：带负责人、原因和重放工具；
- Circuit Breaker：外部供应商与非关键依赖；
- Bulkhead：交易、研究和报表线程池/资源池隔离；
- Rate Limit：按用户、服务、租户、动作和成本；
- Reconciliation：用权威快照修复“消息永远可靠”的假设。

## 10. 遗留系统过渡

附件现有配置显示 Redis Pub/Sub、共享内存、文件账户配置和命令行运维。迁移顺序：

1. 先增加只读遥测和适配器，不改交易行为；
2. 将秘密移出文件并引入工作负载身份；
3. 把状态、错误和操作转为规范事件；
4. 用受控管理 API 取代盘中修改文件/敲命令；
5. 引入双运行和回放比对；
6. 按账户/策略/供应商逐步切换；
7. 保留可验证回退，完成后退役旧通道。

