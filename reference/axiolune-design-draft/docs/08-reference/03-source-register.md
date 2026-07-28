# 参考资料登记册

## 1. 使用原则

来源优先级为官方产品文档、法律法规/监管机构、开放标准、官方项目文档和原始论文。访问日期均为 2026-07-27。完整技术与监管来源共 93 条，见 `evidence/platform_sources.csv`；Palantir 当前公开文档逐条清单见 `evidence/palantir_url_inventory.csv`。

具体版本在实施启动时重新核验。以下链接支持架构方向，不构成法律意见、产品 SLA、许可证或适用性承诺。

## 2. 前端与接口

- [React 19.2](https://react.dev/blog/2025/10/01/react-19-2)
- [React versions](https://react.dev/versions)
- [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- [Vite 8](https://vite.dev/blog/announcing-vite8)
- [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
- [GraphQL specification](https://spec.graphql.org/)
- [CloudEvents](https://cloudevents.io/)

## 3. 后端、事件与工作流

- [Java LTS downloads](https://www.oracle.com/java/technologies/downloads/)
- [Spring Boot 4.1 announcement](https://spring.io/blog/2026/06/10/spring-boot-4)
- [Kafka design](https://kafka.apache.org/41/design/design/)
- [Kafka 4.2 release](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/)
- [Flink time and watermarks](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/)
- [Flink connector guarantees](https://nightlies.apache.org/flink/flink-docs-stable/docs/connectors/datastream/guarantees/)
- [Airflow asset-aware scheduling](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/asset-scheduling.html)
- [Temporal workflows](https://docs.temporal.io/workflows)
- [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

## 4. 数据、搜索、图与向量

- [PostgreSQL documentation](https://www.postgresql.org/docs/)
- [Apache Iceberg specification](https://iceberg.apache.org/spec/)
- [Trino Iceberg connector](https://trino.io/docs/current/connector/iceberg.html)
- [ClickHouse documentation](https://clickhouse.com/docs)
- [OpenSearch documentation](https://docs.opensearch.org/latest/)
- [pgvector](https://github.com/pgvector/pgvector)
- [Milvus documentation](https://milvus.io/docs)
- [Neo4j Operations Manual](https://neo4j.com/docs/operations-manual/current/)
- [Valkey documentation](https://valkey.io/topics/)
- [OpenMetadata lineage](https://docs.open-metadata.org/v1.12.x/how-to-guides/data-lineage)
- [OpenLineage](https://openlineage.io/docs/)
- [DataHub metadata model](https://docs.datahub.com/docs/metadata-modeling/metadata-model/)

## 5. 安全、身份与供应链

- [OAuth 2.0 Security Best Current Practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-security-profile-2_0-final.html)
- [Open Policy Agent](https://www.openpolicyagent.org/docs/latest/)
- [OpenFGA](https://openfga.dev/docs)
- [OpenTelemetry](https://opentelemetry.io/docs/)
- [SLSA v1.2](https://slsa.dev/spec/v1.2/)
- [Sigstore Cosign](https://docs.sigstore.dev/cosign/signing/signing_with_containers/)
- [Argo CD](https://argo-cd.readthedocs.io/en/stable/)

## 6. AI、MLOps 与评测

- [MLflow Model Registry](https://mlflow.org/docs/latest/ml/model-registry/)
- [KServe](https://kserve.github.io/website/)
- [Feast](https://docs.feast.dev/)
- [vLLM serving](https://docs.vllm.ai/en/v0.14.0/serving/openai_compatible_server/)
- [Retrieval-Augmented Generation paper](https://arxiv.org/abs/2005.11401)
- [GraphRAG paper](https://arxiv.org/abs/2404.16130)

## 7. 中国境内监管与标准

- [中华人民共和国网络安全法（2025 年修正）](https://www.cac.gov.cn/2025-12/29/c_1768735112911946.htm)
- [中华人民共和国数据安全法](https://www.cac.gov.cn/2021-06/11/c_1624994566919140.htm)
- [中华人民共和国个人信息保护法](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)
- [网络数据安全管理条例](https://www.cac.gov.cn/2024-09/30/c_1729384452307680.htm)
- [促进和规范数据跨境流动规定](https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm)
- [金融信息服务数据分类分级指南（2026）](https://www.cac.gov.cn/2026-06/13/c_1782919789934988.htm)
- [网络数据安全风险评估办法（2026-08-20 生效）](https://www.cac.gov.cn/2026-06/18/c_1783525609778371.htm)
- [个人信息保护合规审计管理办法](https://www.cac.gov.cn/2025-02/14/c_1741233507681519.htm)
- [人工智能生成合成内容标识办法](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm)
- [国家网络安全事件报告管理办法](https://www.cac.gov.cn/2025-09/15/c_1759583017717009.htm)

合规团队必须根据经营主体、部署地点、客户类型、数据内容、跨境路径和主管部门要求确认适用性；本设计只把可预见的控制接口纳入架构。

