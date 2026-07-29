# 金融本体驱动平台：总体设计与实施规范

**基线版本：** 1.0  
**基线日期：** 2026-07-27  
**适用对象：** 面向机构投资管理场景的数据、投研、组合、交易、风控、产品与 AI 一体化平台  
**设计定位：** 借鉴 Palantir Foundry/AIP 的系统化方法，形成可自主建设、可替换底层组件、可审计的金融平台方案

交付规模、格式和自动验证结果见 [交付包清单](PACKAGE-SUMMARY.md)。

## 阅读入口

- [执行摘要](docs/00-overview/00-executive-summary.md)
- [设计范围、假设与边界](docs/00-overview/01-scope-assumptions.md)
- [核心设计原则与关键决策](docs/00-overview/02-design-principles.md)
- [需求—模块—证据追踪矩阵](docs/00-overview/03-requirements-traceability.md)
- [目标总体架构](docs/01-architecture/00-target-architecture.md)
- [完整技术选型](docs/02-technology/00-selection-summary.md)
- [业务与平台模块全景](docs/03-modules/00-module-map.md)
- [金融本体方法与元模型](docs/04-ontology/00-method-meta-model.md)
- [逻辑域与算法体系](docs/05-algorithms/00-algorithm-framework.md)
- [安全、治理与工程规范](docs/06-engineering/00-engineering-overview.md)
- [分阶段实施路线图](docs/07-delivery/00-roadmap.md)
- [Palantir 能力映射](docs/08-reference/00-palantir-capability-mapping.md)
- [Palantir 完整文档体系审计](docs/08-reference/04-palantir-document-system-audit.md)
- [参考资料登记册](docs/08-reference/03-source-register.md)

## 文档结构

```text
financial-ontology-platform-design/
├── README.md
├── docs/                         # Markdown 设计真源
│   ├── 00-overview/              # 范围、结论、追踪矩阵
│   ├── 01-architecture/          # 总体架构、领域边界、部署与非功能
│   ├── 02-technology/            # 前后端、通信、数据、AI、DevSecOps 选型
│   ├── 03-modules/               # 各业务与平台模块的功能和交互
│   ├── 04-ontology/              # 元模型、对象、链接、动作、函数与治理
│   ├── 05-algorithms/            # 行情、因子、交易、风控、图谱与 Agent 算法
│   ├── 06-engineering/           # API、事件、数据契约、安全、SRE、测试
│   ├── 07-delivery/              # 路线图、组织、验收、迁移
│   └── 08-reference/             # Palantir 映射、附件审计、术语与来源
├── ontology/                     # 可机读的本体设计清单
├── contracts/                    # API、事件和数据契约示例
├── evidence/                     # 经脱敏的附件与文档覆盖证据
├── html/                         # 与 Markdown 同源生成的离线静态 HTML 站点
└── tools/                        # HTML 构建和交付验证工具
```

## 建议阅读顺序

1. 决策者先读执行摘要、总体架构、技术选型摘要和路线图。
2. 产品与业务人员读模块全景、各业务域说明和需求追踪矩阵。
3. 本体与数据团队读本体章节、数据架构、数据契约和来源追踪。
4. 开发团队读技术分册、工程规范、机器可读本体与接口契约。
5. 安全、运维与合规团队读安全模型、SRE、灾备、测试和治理章节。

## 机器可读工件

- [`ontology/financial-ontology.yaml`](ontology/financial-ontology.yaml)：值类型、接口、12 个域、核心对象、链接、Action、Function、Policy 与不变量；
- [`contracts/ontology-api.openapi.yaml`](contracts/ontology-api.openapi.yaml)：对象查询、Action、审批与证据检索的 OpenAPI 3.1.1 样例；
- [`contracts/events.asyncapi.yaml`](contracts/events.asyncapi.yaml)：订单、成交、风险、本体变更和动作生命周期的 AsyncAPI 3.1.0 契约；
- [`contracts/data-contract.example.yaml`](contracts/data-contract.example.yaml)：Level-2 事件的点时、质量、SLO、血缘、许可和保留契约示例；
- [`evidence/palantir_url_inventory.csv`](evidence/palantir_url_inventory.csv)：3,275 个 Palantir 当前公开文档条目的可审计清单；
- [`evidence/attachment_inventory.csv`](evidence/attachment_inventory.csv)：145 个附件资产的脱敏覆盖登记；
- [`evidence/platform_sources.csv`](evidence/platform_sources.csv)：93 条技术、标准、论文和监管来源。

## HTML 版本

离线阅读入口为 [`html/index.html`](html/index.html)。HTML 与 Markdown 同源生成，包含多级侧栏、全文搜索、亮/暗主题、响应式表格、打印样式和本地 Mermaid 渲染库；不依赖 CDN。

如修改 Markdown，可在本目录执行：

```bash
python3 tools/build_site.py
python3 tools/validate_package.py
```

`html/` 是生成物；设计真源仍为 `docs/`、`ontology/` 和 `contracts/`。

## 重要说明

- 本方案不是 Palantir 产品的复制，也不假定采购 Palantir。Palantir 官方文档用于提炼“数据—逻辑—动作—安全”统一建模、对象化应用、分支治理、可追踪动作和 Human+AI 协作等方法。
- “本体”不是独立图数据库的同义词。它是跨数据、逻辑、动作、权限、证据与应用的运行时契约层；对象数据仍可驻留在最合适的事务、分析、搜索、图、向量和对象存储中。
- 附件中存在明文凭据和内部网络参数。本交付物未复写这些值，并将其列为必须立即整改的安全问题。
- 所有时延、容量、可用性指标均作为初始工程基线；正式立项后必须用真实行情量、账户数、并发量和监管要求进行容量校准。
