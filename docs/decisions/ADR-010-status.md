# ADR-010: Meta-Model P0 Issues Resolution - Status Report

**Status**: Draft  
**Decision Owner**: TBD  
**Date**: 2026-07-29  
**Review Status**: ❌ Request Changes

---

## 状态声明

**本 ADR 当前状态为 Draft，不代表已完成或可验收的工作。**

先前的多个"完成报告"声称 3/7、4/7、4.5/7、7/7 完成均不准确，已移至 `superseded/` 目录。

---

## 实际完成情况

### ✅ 已完成 (2/7 门槛)

1. **YAML 语法有效性** ✅
   - 修复 core-meta-model.yaml 第 704 行正则表达式转义错误
   - 4/4 YAML 文件通过 `js-yaml` 严格解析
   - 证据: `node scripts/verify-meta-model.js` 输出

2. **导入摘要锁定** ✅
   - 6/6 导入引用锁定到当前模块摘要
   - 摘要一致性: 4/4 文件匹配 digests.json
   - 证据: `scripts/fix-digests.js` 成功收敛

### ❌ 未完成 (5/7 门槛)

3. **模式属性闭包** ❌
   - 已定义: 13/28 属性
   - 缺失: 15 个属性 (recordedAt, evidenceType, evidenceRef, evidenceDigest, evidenceTimestamp, evidenceDescription, lifecycleState, lifecycleVersion, createdAt, updatedAt, deprecatedAt, semanticVersion, versionedIri, priorVersion, incompatibleWith)
   - 阻断原因: 引用这些属性的模式无法生成 OWL/SHACL

4. **约束定义闭包** ❌
   - 已定义: 0/8 约束
   - 缺失: PublishBeforeReceive, ValidIntervalConsistency, KnowledgeIntervalConsistency, NoFutureKnowledge, ObservationBeforeRecording, ConfidenceRange, DigestFormat, SemanticVersionFormat
   - 阻断原因: 约束引用无法编译为可执行的 SHACL 验证

5. **数据绑定单一真源** ❌
   - 当前状态: 3 个并存的映射结构
     - Field.semanticMapping (字段级)
     - SemanticMappingDefinition (独立定义)
     - MaterializationPlan.semanticMappings (计划级)
   - 违反: ADR-007 单一真值源原则
   - 阻断原因: 架构不一致，无法确定 canonical truth source

6. **时间映射完整性** ⚠️ 部分
   - TemporalMappingSpec 未定义
   - 缺少 valid/knowledge/availability 三轴完整映射
   - 影响: 无法支持历史 PIT 查询

7. **Schema 深度验证** ❌
   - 当前 Schema 仅验证模块头部
   - 19/25 定义类型无法从根 Schema 可达
   - 允许任意额外字段，无法捕获错误

---

## P0 阻断问题详情

详见 [深度分析报告](../reports/deep-analysis-report.json) 和 [当前状态报告](../reports/current-state-2026-07-29.md)

**P0-1**: 模式属性闭包不完整 (15 个缺失)  
**P0-2**: 约束定义闭包缺失 (8 个缺失)  
**P0-3**: 数据绑定多真源 (违反 ADR-007)

---

## ADR-009 验收样例状态

| 样例 | 状态 | 原因 |
|------|------|------|
| 证券标识 | ❌ FAIL | M3 片段使用旧方言，issuer 错误地作为属性 |
| 价格观测 | ❌ FAIL | 使用已废弃的 StructuredValueTypeDefinition |
| 持仓双时间 | ❌ FAIL | 缺少 valid/knowledge 区间，无 M2 投影 |
| 订单生命周期 | ❌ FAIL | 使用旧字段，缺少回执与未知结果处理 |
| 研究断言 | ❌ FAIL | 无 M2 投影，Evidence 为平铺字段 |

**结论**: 0/5 样例可作为当前版本的可执行验收样例

---

## 工具链

### ✅ 已创建

- `scripts/verify-meta-model.js` - 基础验证（YAML、摘要、导入锁）
- `scripts/deep-analysis.js` - 深度架构分析（闭包、契约、真源）
- `scripts/fix-digests.js` - 自动摘要更新

### ❌ 缺失

- OWL/SHACL 生成器
- Schema 深度验证器
- 端到端集成测试
- 历史回放测试

---

## 修复路线图

### Phase 1: 模式闭包修复 (1-2 天)

1. 添加 15 个缺失的 AttributeTypeDefinition
   - recordedAt (TemporalObservation)
   - Evidence 属性 (5 个)
   - Lifecycle 属性 (5 个)
   - Versioning 属性 (4 个)
2. 添加 8 个 ConstraintDefinition
   - 时间约束 (4 个)
   - 格式约束 (3 个)
   - 范围约束 (1 个)

### Phase 2: 数据绑定重构 (2-3 天)

1. 设计单一真源架构
2. 移除冗余映射结构
3. 统一 field/row/dataset 级语义表达

### Phase 3: 时间语义完善 (2-3 天)

1. 定义 TemporalMappingSpec
2. 实现三轴时间映射 (valid/knowledge/availability)
3. 添加历史回放测试

### Phase 4: 验收准备 (3-5 天)

1. 重写 ADR-009 样例为可执行版本
2. 实现 OWL/SHACL 生成
3. 添加端到端测试
4. Schema 深度验证

---

## 签收标准

在以下所有条件满足前，本 ADR 保持 **Draft** 状态：

- [ ] 28/28 模式属性已定义
- [ ] 8/8 约束已定义
- [ ] 数据绑定为单一真源
- [ ] 时间映射完整（三轴）
- [ ] 5/5 ADR-009 样例可执行
- [ ] OWL/SHACL 生成成功
- [ ] 所有测试通过
- [ ] 文档与实现一致

---

## 决策

**当前**: 不签收，Request Changes

**理由**: 
1. 3/7 阻断问题未解决
2. ADR-009 样例无法基于当前模型执行
3. 架构不一致（多真源）
4. 闭包不完整（23 个缺失定义）

**下一步**: 完成 Phase 1-2 修复后重新评审

---

## 参考

- [深度分析报告](../reports/deep-analysis-report.json)
- [当前状态报告](../reports/current-state-2026-07-29.md)
- [验证工具](../../scripts/verify-meta-model.js)
- [已废弃的报告](superseded/)

---

**最后更新**: 2026-07-29T03:30:00Z  
**下次评审**: Phase 1 完成后
