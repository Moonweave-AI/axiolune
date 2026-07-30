# M2 领域本体完整实施方案

**版本**: 1.0.0  
**状态**: 规划完成，待启动  
**日期**: 2026-07-30  
**M3基线**: v0.5.0 (sha256:f16924434185d5074c5c3a2327c0092618fed619469997ed87b98a17a9ff611e)  
**负责团队**: Meta-Model Team  
**预估周期**: 10周 (2026-07-30 至 2026-10-08)

---

## 📋 文档导航

本M2实施方案由以下独立文档组成，建议按顺序阅读：

### 1️⃣ [Week 1-7 实施路线图](./M2-WEEK-1-7-ROADMAP.md)
核心基础到持仓管理的详细实施计划（前7周）

**内容概览**:
- Week 1: 核心基础 (core模块: identifiers, parties, money)
- Week 2-3: 金融工具 (instruments模块: 8大工具类 + 18子类)
- Week 4: 市场数据 (market-data模块: tick/bar + ADR-012绑定)
- Week 5-6: 订单系统 (orders模块: 15状态FSM)
- Week 7: 持仓管理 (positions模块: 事件溯源 + T+1)

**关键交付物**: ADR-013, identifiers.yaml, validate-m2.js, 15状态订单FSM, T1Position

---

### 2️⃣ [Week 8-10 实施路线图](./M2-WEEK-8-10-ROADMAP.md)
策略系统、风险管理、运营支持的详细实施计划（后3周）

**内容概览**:
- Week 8: 策略系统 (strategy模块: 因子DSL + 回测)
- Week 9: 风险管理 (risk模块: VaR + Greeks + 限额)
- Week 10: 运营支持 (operations模块: 清算 + 对账 + 公司行动)

**关键交付物**: qlib兼容因子DSL, 期权Greeks, 审计追踪, 最终验收

---

### 3️⃣ [技术规范](./M2-TECHNICAL-SPECS.md)
YAML结构、命名规范、ADR-012绑定、FIBO对齐的详细技术规范

**内容概览**:
- 5.1 YAML文件结构规范（module头部 + 类型定义区）
- 5.2 类型命名规范（PascalCase vs snake_case）
- 5.3 ADR-012三轴时间绑定规范（validTime/knowledgeTime/availabilityTime）
- 5.4 FIBO对齐规范（exactMatch/closeMatch选择指南 + 核心50个清单）
- 5.5 模块依赖管理（imports声明 + 依赖规则）
- 5.6 语义版本控制（semver 2.0.0规范）

**适用场景**: 编写YAML定义、创建数据绑定、FIBO对齐时参考

---

### 4️⃣ [质量标准与验收](./M2-QUALITY-STANDARDS.md)
validate-m2.js验证规则、测试标准、文档标准、最终验收门禁

**内容概览**:
- 6.1 validate-m2.js验证规则（6大检查项）
- 6.2 代码审查清单（本体设计 + 数据绑定 + FIBO对齐）
- 6.3 测试标准（单元测试 + 集成测试 + 性能测试）
- 6.4 文档标准（README模板 + 类型定义文档）
- 6.5 最终验收门禁（自动化检查 + 人工审查 + 生产就绪）

**适用场景**: 模块完成后自检、提交审查前、最终验收时

---

### 5️⃣ [风险管理与资源计划](./M2-RISK-RESOURCES.md)
风险识别矩阵、缓解策略、应急预案、团队配置、预算估算

**内容概览**:
- 7.1 风险识别矩阵（10个风险 + 概率影响评估）
- 7.2 风险缓解策略（R-001至R-010的详细缓解措施）
- 7.3 应急预案（4个关键场景的应急措施）
- 7.4 风险复盘机制（每周回顾 + 里程碑评审）
- 8.1 团队配置（核心3人 + 支持团队）
- 8.2 时间投入估算（704总工时）
- 8.3 工具与环境
- 8.4 预算估算（¥370.5k）
- 8.5 关键依赖与假设

**适用场景**: 项目启动前、风险回顾会、资源申请时

---

## 🎯 核心原则

### 1. M3语法强制遵循
所有类型定义必须使用：
- `ObjectTypeDefinition` (对象类型)
- `AssociationTypeDefinition` (N元关系)
- `EnumTypeDefinition` (枚举)
- `ValueTypeDefinition` (值对象)

❌ **禁止**自定义元类型或偏离M3语法

### 2. ADR-012三轴时间强制绑定
所有时序数据必须显式绑定：
- `validTime`: 事实为真的时间（业务时间）
- `knowledgeTime`: 平台知晓的时间（事务时间）
- `availabilityTime`: 消费者可用的时间（合规时间）

❌ **禁止**使用单一时间戳或CURRENT_TIMESTAMP

### 3. 生产系统验证优先
参考权威顺序：
1. **nautilus_trader** (工具、订单、持仓、行情)
2. **Lean** (工具枚举、Greeks、订单类型)
3. **qlib** (因子DSL、PIT查询)
4. **rqalpha** (T+1、中国市场)
5. **FIBO** (标准金融概念)

❌ **禁止**使用未验证的design-draft概念

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

## 📊 规模与范围

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

| 类型 | 数量 |
|------|------|
| ObjectTypeDefinition | 142个 |
| AssociationTypeDefinition | 46个 |
| EnumTypeDefinition | 69个 |
| ValueTypeDefinition | 64个 |
| **类型定义总计** | **321个** |
| 数据绑定示例 | 15个 |
| FIBO对齐 | 50+个 |
| ADR决策文档 | 3个 |
| 验证脚本 | 1个 |

### 实施周期

- **时间跨度**: 10周 (2026-07-30 至 2026-10-08)
- **总工时**: 704小时
- **团队规模**: 3人全职 (本体工程师 + 金融专家 + 数据工程师)
- **预算**: ¥370.5k (约$51k USD)

---

## ✅ 成功标准

### 架构合规性
- [ ] 所有321个类型使用M3语法
- [ ] 时序数据100%绑定ADR-012三轴
- [ ] 核心50个概念有FIBO对齐
- [ ] 零design-draft引用
- [ ] validate-m2.js全部检查通过

### 功能完整性
- [ ] 8模块全部交付
- [ ] 8大工具类定义（Equity, Bond, Option, Future, Swap, Crypto, ETF, Warrant）
- [ ] 18个工具子类（对照nautilus_trader）
- [ ] 15状态订单FSM + 16事件类型
- [ ] tick/quote/bar市场数据结构
- [ ] 事件溯源持仓模型 + T+1支持
- [ ] qlib Expression兼容的因子DSL
- [ ] VaR/Greeks风险度量
- [ ] 15个数据绑定示例

### 生产就绪
- [ ] 每模块有README和使用文档
- [ ] 核心类型有单元测试
- [ ] PIT查询性能 < 100ms
- [ ] 语义版本控制完整
- [ ] 安全审查通过
- [ ] 金融专家审查通过

---

## 🚀 立即行动（Week 1）

### 1. 创建目录结构
```bash
mkdir -p ontology/domain/{core,instruments,market-data,orders,positions,strategy,risk,operations}
```

### 2. 编写ADR-013: M2架构决策
- 主题: M2领域本体架构
- 内容: 8层模块分层、继承vs组合、中国市场扩展、FIBO对齐策略
- 状态: Draft → Review → Accepted

### 3. 实现core/identifiers.yaml
- ISIN (ISO 6166) - exactMatch to FIBO
- CUSIP, LEI (ISO 17442), MIC (ISO 10383)

### 4. 创建validate-m2.js
- M3语法合规检查
- ADR-012时间语义检查
- 模块依赖完整性检查
- FIBO对齐完整性检查
- 禁止design-draft引用检查

### 5. 第一个数据绑定示例
- ISIN查找映射，符合ADR-011/012

---

## 📞 联系方式

**项目所有者**: Meta-Model Team  
**技术问题**: 本体工程师  
**业务问题**: 金融专家  
**数据问题**: 数据工程师  

**文档仓库**: `docs/domain/planning/`  
**本体仓库**: `ontology/domain/`  

---

## 📝 变更日志

| 版本 | 日期 | 变更内容 | 作者 |
|------|------|----------|------|
| 1.0.0 | 2026-07-30 | 初始完整版本，合并所有M2规划文档 | Meta-Model Team |

---

**文档状态**: ✅ 完整规划完成  
**下一步**: 启动Week 1实施（等待批准）  
**批准**: ⬜ 待决策  
**最后更新**: 2026-07-30

---

*本索引文档整合了M2领域本体的完整实施方案，包括10周路线图、技术规范、质量标准、风险管理和资源计划。所有旧的M2规划文档（M2-IMPLEMENTATION-ROADMAP.md、M2-EXECUTIVE-SUMMARY.md、M2-domain-ontology-plan-part1.md）已被此统一方案替代。*
