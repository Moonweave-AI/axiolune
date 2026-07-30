# M2 领域本体实施计划

**状态**: Draft
**日期**: 2026-07-30
**M3 基线**: v0.5.1 (commit 1fefc18), 11/11 门禁通过

---

## 1. 目标

用 M3 元本体语法定义量化金融领域概念,产出可验证的领域本体(OntologyDefinition 实例),覆盖工具、行情、订单、持仓、策略、风险、运营等域。

## 2. 参考来源(已在 `docs/meta/reference/` 中)

概念定义从以下权威来源提取,不自行臆造:

| 概念域 | 主要参考 | 本地路径 |
|--------|----------|----------|
| 证券/衍生品分类 | FIBO SEC + DER + FBC | `docs/meta/reference/ontology-design-reference/fibo/SEC/` `DER/` `FBC/` |
| 工具层次结构 | nautilus_trader (18+ 子类) + Lean (12 SecurityType) | `docs/meta/reference/project-reference/nautilus_trader/` `Lean/` |
| 订单状态机 | nautilus_trader (15 状态 FSM + 16 事件) | `docs/meta/reference/project-reference/nautilus_trader/` |
| 持仓/PnL | nautilus_trader (事件溯源) + rqalpha (T+1/税基) | `docs/meta/reference/project-reference/nautilus_trader/` `rqalpha/` |
| 行情数据 | nautilus_trader (Bar/Tick/Quote/L2) + Lean (Bar/Tick) | 同上 |
| 因子/回测 | qlib (Expression DSL + PITProvider) | `docs/meta/reference/project-reference/qlib/` |
| 中国市场 | rqalpha (T+1/涨跌停) + vnpy (5 档 tick) | `docs/meta/reference/project-reference/rqalpha/` `vnpy/` |
| 行业术语 | FIBO ONTOLOGY_GUIDE (ISO 704 定义规范) | `docs/meta/reference/ontology-design-reference/fibo/ONTOLOGY_GUIDE.md` |

**不使用**: `axiolune-design-draft` 作为权威来源(其概念定义非行业标准,仅可参考其域划分思路)。

## 3. M2 YAML 语法约定

M2 领域本体遵循 M3 已定义的元类型语法。类型名作为 key,属性填入 value,不使用 `kind:` 判别字段(M3 元模型不用此方言)。具体 YAML 格式在 Phase 0 末尾通过第一个域的实际编写确定,不预先规定。

## 4. 推进方法:逐域增量

不采用固定周数时间表,而是按域增量推进。每个域走完以下流水线:

```
Step 1: 参考调研
  - 读对应 FIBO 模块 + 量化项目源码
  - 提取术语表(术语 + ISO 704 定义 + 来源行号)
  - 写 competency questions(这域要回答什么问题)

Step 2: 类型草稿
  - 用 M3 元类型定义该域的对象/关联/枚举/值对象
  - 声明 superTypes 继承层次
  - 声明 patternBindings(绑定 L2 模式:TemporalFact/ProvenancedFact 等)
  - 声明 attributeUses(属性 + 基数 + 约束)

Step 3: 验证
  - 用 M3 验证器(validate-structure / validate-references)检查 M2 YAML
  - 确认引用闭包:所有 superTypes / patternBindings / attributeUses 引用解析
  - 确认无循环依赖

Step 4: FIBO 对齐
  - 为核心概念标注 FIBO exactMatch/closeMatch
  - 对齐需读实际 FIBO OWL 文件确认 targetIri,不臆造
  - 记录 rationale

Step 5: 数据映射(选定域)
  - 用 L4 SemanticMappingDefinition 定义物理表→本体实例映射
  - 三轴时间绑定(validTime/knowledgeTime/availabilityTime 全必填)
  - 用 PITValidationRequest 契约验证 PIT 语义

Step 6: 审查
  - 跑扩展后的 test-all(含 M2 域门禁)
  - 投影漂移检查(M2 变更后 .ttl 须重生成)
```

每个域独立可验证,不依赖其他域完成(跨域关系可先声明后填充)。

## 5. 域推进顺序

按依赖关系排序,前 3 个域构成"价格→持仓→下单"最小闭环:

| 顺序 | 域 | 依赖 | 参考来源 |
|------|----|------|----------|
| 1 | instruments(工具与市场) | M3 core | FIBO SEC/FBC + nautilus_trader/Lean |
| 2 | market-data(行情) | instruments | nautilus_trader/Lean + FIBO MD |
| 3 | orders(订单与执行) | instruments + market-data | nautilus_trader FSM + Lean |
| 4 | positions(持仓与组合) | instruments + market-data | nautilus_trader/rqalpha |
| 5 | strategy(因子与回测) | positions | qlib |
| 6 | risk(风险) | positions | Lean Greeks + FIBO |
| 7 | operations(清算/对账/公司行动) | orders + positions | FIBO FBC/BP |
| 8 | china-extensions(中国市场) | instruments + positions + orders | rqalpha + vnpy |

域 1-3 完成后即可端到端验证"价格查询→持仓计算→订单提交"闭环。域 8 横切多个域,最后做。

## 6. 验证策略

复用 M3 已建工具链,M2 是 M3 语法的"用户":

| 检查 | 工具 | 说明 |
|------|------|------|
| YAML 语法 | validate-yaml.js | M2 YAML 同样需通过 |
| 结构校验 | validate-structure.js | M2 类型需符合 M3 元类型语法 |
| 引用闭包 | validate-references.js | superTypes/patternBindings/attributeUses 引用解析 |
| 投影 | generate-owl.js / generate-shacl.js | M2 类型投影到 OWL/SHACL |
| 投影验证 | test-projection.js | M2 实例经 SHACL 校验 |
| 漂移 | git diff --exit-code | M2 变更后投影产物须同步 |
| 全量门禁 | test-all.js | 扩展为含 M2 域 |

**不预先编写 validate-m2.js**。M2 验证需求在第一个域完成后,基于实际问题确定需要哪些 M2 专属检查,再编写。

## 7. ADR

以下 ADR 在对应域推进时按需创建,不预先批量写:

| ADR | 触发时机 | 内容 |
|-----|----------|------|
| ADR-013 | Phase 0 末 | M2 架构:域划分、继承 vs 组合、IRI 命名空间 |
| ADR-014 | orders 域 | 订单状态机选型(nautilus_trader 15 状态) |
| ADR-015 | positions 域 | 持仓模型:事件溯源 vs 快照、PnL 计算、T+1 |
| 按需 | 各域 | 重大设计决策随时记录 |

## 8. 不做的事

- 不预定义类型数量(321 是旧文档臆造的,实际数量由参考调研决定)
- 不预定义字段名(字段从参考源提取,不臆造)
- 不预定义 FIBO 对齐 IRI(需读实际 FIBO OWL 确认)
- 不预设团队/预算/工时(AI 辅助开发)
- 不用 design-draft 作为权威来源
- 不发明 M3 不存在的 YAML 语法(如 `kind:` 字段)
