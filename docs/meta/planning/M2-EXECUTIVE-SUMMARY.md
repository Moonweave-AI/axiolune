# M2领域本体：执行摘要

**状态**: 规划完成，待启动  
**日期**: 2026-07-29  
**M3基线**: v0.5.0 ✅ 已验收  
**决策者**: Meta-Model Team

---

## 当前状态

**M3（元本体）已完成** ✅
- 4层架构完整：core, patterns, behavior, data-binding
- ADR-011（单一真值源）: Accepted
- ADR-012（三轴时间语义）: Accepted
- 验证：16/16检查通过
- 版本：0.5.0
- 摘要：sha256:f16924434185d5074c5c3a2327c0092618fed619469997ed87b98a17a9ff611e

**M2（领域本体）尚未开始** ⬜
- 目录结构：未创建
- 类型定义：0个
- 数据绑定：0个
- 参考系统分析：已完成
- 实施路线图：已完成 ✅

---

## M2是什么？

M2使用M3定义的语法构建**量化金融的具体概念体系**。

| 层次 | 定义内容 | 示例 |
|------|----------|------|
| M3 | 如何定义本体 | ObjectTypeDefinition是什么 |
| M2 | 具体金融概念 | fin:Equity, fin:Order, fin:Position |
| M1 | 真实业务数据 | AAPL股票, 2026-07-29收盘价$195.23 |

**类比**:
- M3 = Java语言规范（class、interface语法）
- M2 = 你写的业务类（class Instrument）
- M1 = 运行时对象（new Instrument("AAPL")）

---

## 为什么现在做M2？

1. **M3已生产就绪**: 所有元类型、模式、验证器完成
2. **数据绑定已就绪**: ADR-011/012提供完整的物理→语义映射能力
3. **参考系统已分析**: nautilus_trader、Lean、qlib生产概念已提取
4. **阻塞下游工作**: 没有M2，无法物化真实数据到知识图谱

---

## M2规模与范围

### 8个核心模块

```
ontology/domain/
├── core/          ← Week 1  (标识符、货币、参与方)
├── instruments/   ← Week 2-3 (8大金融工具类)
├── market-data/   ← Week 4   (行情：tick/quote/bar)
├── orders/        ← Week 5-6 (15状态FSM + 16事件)
├── positions/     ← Week 7   (持仓、PnL、Portfolio)
├── strategy/      ← Week 8   (因子、信号、回测)
├── risk/          ← Week 9   (VaR、Greeks、限额)
└── operations/    ← Week 10  (清算、对账、公司行动)
```

### 预估工作量

- **类型定义**: 200-300个
- **数据绑定示例**: 10-15个
- **FIBO对齐**: 50+个核心概念
- **实施周期**: 8-12周
- **团队规模**: 2-3人（1本体工程师 + 1金融工程师 + 1数据工程师）

---

## 核心原则

### 1. M3语法强制遵循
所有类型必须使用：
- `ObjectTypeDefinition` (对象类型)
- `AssociationTypeDefinition` (N元关系)
- `EnumTypeDefinition` (枚举)
- `ValueTypeDefinition` (值对象)

❌ **禁止**自定义元类型或偏离M3语法。

### 2. ADR-012三轴时间强制绑定
所有时序数据必须显式绑定：
- `validTime`: 事实为真的时间（业务时间）
- `knowledgeTime`: 平台知晓的时间（事务时间）
- `availabilityTime`: 消费者可用的时间（合规时间）

❌ **禁止**使用单一时间戳或CURRENT_TIMESTAMP。

### 3. 生产系统验证优先
参考权威顺序：
1. **nautilus_trader** (工具、订单、持仓、行情)
2. **Lean** (工具枚举、Greeks、订单类型)
3. **qlib** (因子DSL、PIT查询)
4. **rqalpha** (T+1、中国市场)
5. **FIBO** (标准金融概念)

❌ **禁止**使用未验证的design-draft概念。

### 4. FIBO对齐
核心金融概念必须：
- 有明确的FIBO `exactMatch` 或 `closeMatch`
- 记录对齐理由和验证人
- 遵循FIBO的ISO 704定义规范

### 5. 中国市场扩展
必须包含：
- T+1交易制度
- 涨跌停板机制
- 结算价vs收盘价
- A股/B股分类
- 可转债、ETF期权

---

## 关键里程碑

| 阶段 | 周 | 交付物 | 验收标准 |
|------|-----|--------|----------|
| 核心基础 | 1 | identifiers + parties + money | FIBO对齐 + validate-m2通过 |
| 金融工具 | 2-3 | 8大工具类 | 18子类 + FIBO exactMatch |
| 市场数据 | 4 | tick/quote/bar | 三轴时间绑定 |
| 订单系统 | 5-6 | 15状态FSM | 完整状态转换表 |
| 持仓管理 | 7 | Position + Portfolio | 事件溯源 + T+1 |
| 策略系统 | 8 | Factor + Signal | qlib Expression兼容 |
| 风险管理 | 9 | VaR + Greeks | Lean Greeks对齐 |
| 运营支持 | 10 | Settlement + 公司行动 | ISO 20022对齐 |

---

## 立即行动（本周）

### 1. 创建目录结构
```bash
mkdir -p ontology/domain/{core,instruments,market-data,orders,positions,strategy,risk,operations}
```

### 2. 编写ADR-013: M2架构决策
**主题**: M2领域本体架构
**内容**:
- 模块分层理由
- 继承vs组合策略
- 中国市场扩展设计
- FIBO对齐策略
- 参考系统优先级

### 3. 实现第一个模块: core/identifiers.yaml
**内容**:
- ISIN (ISO 6166)
- CUSIP
- LEI (ISO 17442)
- MIC (ISO 10383)
- FIBO对齐
- ISO标准验证

### 4. 创建验证脚本: scripts/validate-m2.js
**检查项**:
- M3语法合规（所有类型是ObjectTypeDefinition等）
- ADR-012时间语义（validTime/knowledgeTime/availabilityTime）
- 模块依赖完整性（imports可解析）
- FIBO对齐完整性（核心概念有targetIri）
- 禁止design-draft引用

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 参考系统理解偏差 | 高 | 每个概念链接到源代码行号 |
| 时间语义实施错误 | 高 | 自动化validate-m2脚本 |
| FIBO对齐不当 | 中 | 金融工程师审查 |
| 中国市场遗漏 | 中 | rqalpha/vnpy专项审查 |
| 模块循环依赖 | 中 | 严格分层 + 依赖图检查 |

---

## 成功标准

### 架构维度
- ✅ 所有类型遵循M3语法
- ✅ 时序数据绑定ADR-012三轴
- ✅ 核心概念有FIBO exactMatch
- ✅ 无design-draft污染
- ✅ 通过validate-m2.js全部检查

### 功能维度
- ✅ 8模块全部交付
- ✅ 200-300类型定义
- ✅ 10-15数据绑定示例
- ✅ 8大工具类 + 15状态订单FSM
- ✅ 事件溯源持仓 + 因子DSL

### 生产维度
- ✅ 每模块有README和示例
- ✅ 核心类型有单元测试
- ✅ PIT查询性能 < 100ms
- ✅ 语义版本控制
- ✅ 安全审查通过

---

## 参考文档

- **实施路线图**: `docs/meta/planning/M2-IMPLEMENTATION-ROADMAP.md`
- **M3元本体**: `ontology/meta/` (v0.5.0)
- **ADR-011**: 规范数据绑定真值源
- **ADR-012**: 可复现三轴时间语义
- **ADR-013**: M2架构决策 (待编写)

---

## 决策

**批准启动M2实施**: ⬜ 待决策  
**决策人**: _____________  
**日期**: _____________

---

**所有者**: Meta-Model Team  
**最后更新**: 2026-07-29  
**下次评审**: Week 1完成后
