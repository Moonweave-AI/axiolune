# 技术选型总表

## 1. 选型策略

技术选型遵循五条约束：

1. 先按负载和业务不变量选型，不按热门程度选型；
2. 关键交易路径追求确定性与可恢复，分析路径追求吞吐和开放格式；
3. 尽量使用开放协议和可替代组件，商业产品必须有退出路径；
4. 首期控制存储、语言和中间件种类，达到明确触发条件再扩展；
5. 版本在实施启动时以“当前受支持稳定版 + 兼容性测试”冻结，不在长期设计中硬编码易过期的小版本。

## 2. 推荐基线

| 能力 | 主选 | 备选/触发条件 | 不建议作为默认 |
| --- | --- | --- | --- |
| 前端语言与框架 | TypeScript、React、Vite | Next.js：确有 SSR/公网门户；Umi：仅用于低风险渐进迁移 | 多框架并存、微前端先行 |
| 状态与请求 | TanStack Query、TanStack Router、Zustand | Redux Toolkit：复杂可回放客户端状态 | 把服务端数据全部塞入全局 Store |
| UI 组件 | 基于 Ant Design 的自有 Token/组件层 | Radix/Headless：高定制模块 | 直接复制默认主题 |
| 数据表格 | AG Grid Enterprise（预算允许）或 TanStack Table + 虚拟化 | Handsontable：电子表格编辑场景 | 普通 DOM 表格承载十万行 |
| 图表 | Apache ECharts | Vega-Lite：声明式分析；Plotly：科研原型 | 每个页面引入不同图库 |
| K 线/逐笔 | Lightweight Charts；复杂交易图表采购合规授权组件 | ECharts 自研：需求有限 | 未授权复制商业 Charting Library |
| 图谱/流程/地图 | Cytoscape.js、React Flow、MapLibre GL | Sigma.js：超大只读图 | 用 Canvas 自研全部交互 |
| 核心业务服务 | Java LTS、Spring Boot、Gradle | Kotlin：团队成熟后；Quarkus：冷启动强需求 | 每个服务任选语言 |
| 研究与 AI 服务 | Python、FastAPI、Pydantic、Polars/PyArrow | Ray：需要分布式 Python；RAPIDS：GPU 数据处理 | Python 承担低延迟订单核心 |
| 低时延适配器 | Rust 稳定版；已有成熟 C++ 资产可保留 | Java 低延迟调优后达标则不新增语言 | 先写 Rust 再找需求 |
| 外部 API | REST + OpenAPI | GraphQL：对象聚合与自助查询 | 所有命令都走 GraphQL |
| 内部 RPC | gRPC + Protobuf | HTTP/JSON：低频、跨边界简单服务 | 自定义二进制协议 |
| 事件 | Apache Kafka + Schema Registry | Redpanda：评估兼容/支持后；Pulsar：多租户跨地域刚需 | Redis Pub/Sub 作为可靠业务总线 |
| 实时推送 | WebSocket；低频通知可用 SSE | MQTT：边缘设备/专门订阅语义 | 浏览器轮询实时订单 |
| 业务工作流 | Temporal | Camunda：BPMN/业务建模强刚需 | 用 Airflow 跑人工审批 |
| 数据编排 | Airflow 3.x + dbt | Dagster：团队已具备资产编排经验且通过运维评估 | 用 Temporal 跑大数据资产依赖 |
| 流计算 | Apache Flink | Kafka Streams：简单单服务聚合 | 定时批处理模拟实时风控 |
| 批计算 | Apache Spark、Trino、dbt | DuckDB：本地/小样本 | 每个指标都上 Spark |
| 事务数据库 | PostgreSQL 高可用 | 分布式 SQL：单库容量/地域写入成为实证瓶颈 | 多主写入先行 |
| 湖仓 | S3 兼容存储 + Apache Iceberg | Delta Lake：已有生态；Hudi：强 upsert 需求 | 私有表格式锁定 |
| OLAP/时序分析 | ClickHouse | Apache Druid/Pinot：团队已有专长 | PostgreSQL 承担全部逐笔分析 |
| 搜索 | OpenSearch | Elasticsearch 商业版：功能/支持明确需要 | 数据库 LIKE 代替全文检索 |
| 向量 | pgvector/OpenSearch 起步 | Milvus：规模、召回、延迟实测触发 | 首期同时上三套向量库 |
| 图 | PostgreSQL 保存本体真源；Neo4j Enterprise 或 NebulaGraph 做投影 | JanusGraph：全 OSS 且能承担运维复杂度 | 把图数据库内部 Schema 当本体真源 |
| 缓存 | Valkey | 本地 Caffeine：服务内短缓存 | 缓存作为订单/持仓真源 |
| 对象/媒体 | 云 S3/OSS/COS/OBS 或 Ceph RGW；统一 S3 接口 | MinIO：许可、支持和路线评估通过后 | DB BLOB 存大媒体 |
| 数据目录与血缘 | OpenMetadata + OpenLineage 事件 | DataHub：大型组织明确需要可扩展元数据图时 | 同时运行两套主目录；与业务本体混成一个图 |
| 数据质量 | Great Expectations/Soda Core + 领域校验 | Deequ：Spark 生态 | 只靠人工抽样 |
| 本体运行层 | 自研元模型、解析、动作、策略和 SDK 生成 | 采购 Palantir/语义平台：满足预算与主权 | 仅部署 RDF 三元组库即宣称完成 |
| 机器学习治理 | MLflow、Feast（确有在线特征）、KServe | Kubeflow：已有平台团队 | Notebook 文件即生产模型 |
| LLM 推理 | 统一 Model Gateway；vLLM/TGI 等自托管引擎 | 商用模型 API：数据边界允许 | 应用直接持有供应商 API Key |
| 身份 | 对接现有企业 IdP；缺失时 Keycloak | 商业 IAM：SLA/合规要求 | 自研密码和 MFA |
| 授权 | OpenFGA/SpiceDB + OPA | Cedar：团队/云生态适配 | 只用前端菜单权限 |
| 密钥 | Vault + KMS/HSM | 云 Secret Manager | 明文 TOML、CSV、环境镜像 |
| 容器与发布 | Kubernetes、Argo CD、Helm、OpenTofu | OpenShift：企业支持/安全基线需要 | 手工 SSH + crontab/screen |
| 制品与供应链 | GitLab/GitHub、Harbor、SBOM、Cosign、Trivy | 商业 SCA/SAST | 未签名镜像直接生产 |
| 可观测性 | OpenTelemetry、Prometheus/VictoriaMetrics、Grafana、Loki/Tempo | ClickHouse 日志后端 | 各服务私有日志格式 |

## 3. 语言边界

平台最多保留三类生产运行时：

- **Java：** 本体、Action、Policy、账户、组合、OMS、RMS、协同和控制面；
- **Python：** 数据处理、因子、回测、模型、文档/AI 和离线任务；
- **Rust/C++：** 行情或交易适配器中经压测证明需要的低延迟组件。

TypeScript 主要用于 Web 和生成 SDK。新语言必须通过架构决策记录说明业务收益、运维能力和退出成本。

## 4. 购买、复用与自研

### 4.1 必须自研或掌握真源

- 金融本体元模型及领域类型；
- 标识、双时间、证据、质量和权限映射；
- Action/Policy 与领域状态机；
- 点时正确的因子、回测、风险和 TCA 规范；
- 对外数据和接口契约；
- 供应商适配器的规范化层。

### 4.2 适合采购

- 交易所/柜台协议与认证连接；
- 专业 K 线、Level-2 和大表格组件；
- 商业图数据库、IAM、HSM、数据库支持；
- 恶意文件检测、DLP、SAST/SCA 和企业监控；
- 特定商业行情、财务与一致预期数据。

### 4.3 适合直接使用开源

Kafka、Flink、Iceberg、Trino、ClickHouse、PostgreSQL、OpenTelemetry、Prometheus、Grafana、Temporal、OpenMetadata 等基础能力。生产使用仍需明确维护团队、升级策略和商业支持选项。

## 5. 2026-07 调研参考版本

下列版本用于本设计的兼容性与容量验证起点，不是“自动追新”承诺。项目启动时必须重新核验厂商支持矩阵、依赖兼容性和安全公告，并把实际采用版本写入 ADR 与软件物料清单。

| 能力 | 调研参考基线 | 落地策略 |
| --- | --- | --- |
| Web | React 19.2、TypeScript 5.9、Vite 8、Ant Design 6 | TypeScript 6 先在工具包试点；公网门户才考虑 Next.js |
| 核心后端 | JDK 25 LTS、Spring Boot 4.0.x | 4.1.x 经预生产浸泡后升级；交易核心不跟随短周期版本漂移 |
| 事件 | Kafka 4.2、Flink 当前稳定版 | 以连接器端到端语义、回放和幂等测试决定上线 |
| 数据 | PostgreSQL 18、Iceberg v2、Spark 4.2、Trino 当前稳定版、ClickHouse 当前稳定版 | 生产采用受支持补丁版；不把实验性表格式功能纳入首期 |
| 编排 | Airflow 3.3、Temporal 当前稳定版 | 数据 DAG 与业务长事务分别治理 |
| 搜索/向量 | OpenSearch 3、pgvector | Milvus/Neo4j 仅在容量与查询基准触发后引入 |
| 平台 | Kubernetes 1.35 起步、containerd 2、Argo CD | 采用 N-1 稳定策略；低抖动链路可用专用节点或裸金属 |
| AI | MLflow、KServe、vLLM 0.14 | 商用模型与自托管模型统一经过 Model Gateway |

## 5. 引入新组件的触发门

新数据库或中间件需给出：

- 现有方案无法达到的量化指标；
- 预计三年数据量和并发；
- 数据真源、同步和恢复方案；
- 安全、备份、监控和升级能力；
- 许可、支持和退出成本；
- 负载测试与故障演练结果。

没有这些证据时，优先扩展现有组件而不是增加技术种类。
