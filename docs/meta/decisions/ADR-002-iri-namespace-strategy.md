# ADR-002: IRI Namespace Strategy (Deferred)

**Status**: Draft  
**Date**: 2026-07-28  
**Decision**: Deferred - IRI namespace design requires explicit architecture decision

---

## Context

本体工程中的 IRI (Internationalized Resource Identifier) 命名空间设计是关键架构决策，影响：

1. **全局唯一性保证**: IRI 是 RDF/OWL 中实体的全局标识符
2. **版本管理策略**: 如何在 IRI 中编码版本信息
3. **解析与内容协商**: IRI 是否可解析（HTTP 303 重定向）
4. **组织归属与治理**: 谁拥有这个命名空间的控制权
5. **外部标准对齐**: 如何与 FIBO、BIAN 等标准的 IRI 模式对齐

---

## Problem

当前代码中存在临时 IRI 示例 `https://moonweave.ai/ontology/...`，这些示例可能被误认为是最终决策。

**问题**：
- 域名 `moonweave.ai` 的所有权未确定
- IRI 结构（`/ontology/finance/Equity` vs `/ontology/finance/instruments#Equity`）未确定
- 版本化策略未确定（路径版本 vs 查询参数 vs 内容协商）
- 是否需要可解析的 IRI（Linked Data 原则）未决定

---

## Decision

**暂时搁置 IRI 命名空间的最终设计，使用占位符模式。**

### 占位符约定

在所有元模型、文档、示例中使用以下占位符：

```yaml
# ✅ 使用占位符
iri: "{BASE_IRI}/finance/Equity"
namespace: "fin"
example: "{BASE_IRI}/finance/instruments"

# ❌ 不要使用具体域名
iri: "https://moonweave.ai/ontology/finance/Equity"  # 错误！
```

### 待决策的问题

需要在后续 ADR 中明确决定：

1. **IRI 基础 URI**:
   - 选项 A: `https://ontology.moonweave.ai/axiolune/`
   - 选项 B: `https://moonweave.ai/ontology/axiolune/`
   - 选项 C: `https://w3id.org/moonweave/axiolune/` (使用 W3C 永久标识符服务)
   - 选项 D: `urn:moonweave:axiolune:` (URN 方案，不可解析)

2. **版本化策略**:
   - 选项 A: 路径版本 `{BASE}/v1/finance/Equity`
   - 选项 B: 无版本路径 + HTTP 内容协商
   - 选项 C: 查询参数 `{BASE}/finance/Equity?version=1.0.0`
   - 参考: FIBO 使用 `https://spec.edmcouncil.org/fibo/ontology/FND/...?version=master%2F2026Q1`

3. **Hash vs Slash**:
   - 选项 A: Hash IRI `{BASE}/finance/instruments#Equity` (本体文档 URL)
   - 选项 B: Slash IRI `{BASE}/finance/Equity` (需要 HTTP 303 重定向)
   - 参考: FIBO 使用 Slash IRI

4. **可解析性**:
   - 选项 A: IRI 可通过 HTTP GET 解析，返回 RDF/Turtle/JSON-LD
   - 选项 B: IRI 仅作为标识符，不保证解析
   - 参考: Linked Data 原则要求可解析

---

## Consequences

### 正面影响
- ✅ 避免过早承诺特定命名空间设计
- ✅ 允许充分评估不同 IRI 策略的利弊
- ✅ 与 FIBO、BIAN、schema.org 等标准的 IRI 模式对齐后再决定
- ✅ 确保域名所有权和 DNS 配置就绪后再发布

### 负面影响
- ⚠️ 开发期间需要使用占位符，增加后期替换成本
- ⚠️ 生成的 OWL/RDF 文件在占位符替换前无法发布
- ⚠️ 外部引用（如果有）需要在 IRI 确定后更新

### 缓解措施
1. **自动化替换**: 创建脚本 `scripts/replace-iri-placeholders.sh`，一键替换所有占位符
2. **CI 检查**: 在 CI 中检测是否有未替换的占位符泄漏到生产环境
3. **文档标注**: 在所有使用占位符的地方添加 `# TODO: Replace {BASE_IRI} after ADR-XXX`

---

## Implementation Plan

### Phase 1: 修正现有文件（立即执行）
- [ ] 替换 `core-meta-model.yaml` 中的示例 IRI
- [ ] 替换 `data-binding-meta-model.yaml` 中的示例 IRI
- [ ] 替换 ADR-001 中的示例 IRI
- [ ] 添加 `# TODO: IRI namespace pending ADR-002` 注释

### Phase 2: 调研与决策（Week 1-2）
- [ ] 研究 FIBO IRI 解析机制（spec.edmcouncil.org）
- [ ] 研究 BIAN IRI 策略
- [ ] 评估 W3C Permanent Identifier (w3id.org) 的适用性
- [ ] 评估内容协商 vs 路径版本的利弊
- [ ] 确定域名所有权和 DNS 配置

### Phase 3: 最终决策（Week 3）
- [ ] 编写 ADR-XXX 确定最终 IRI 命名空间策略
- [ ] 实现 `scripts/replace-iri-placeholders.sh` 脚本
- [ ] 一键替换所有占位符
- [ ] 验证生成的 OWL/RDF 文件

---

## References

- [Cool URIs for the Semantic Web](https://www.w3.org/TR/cooluris/) - W3C Interest Group Note
- [Best Practice Recipes for Publishing RDF Vocabularies](https://www.w3.org/TR/swbp-vocab-pub/)
- [FIBO IRI Strategy](https://spec.edmcouncil.org/fibo/ontology/)
- [W3C Permanent Identifier Service](https://w3id.org/)
- [Linked Data Principles](https://www.w3.org/DesignIssues/LinkedData.html) - Tim Berners-Lee

---

## Notes

**重要**: 在 IRI 命名空间最终确定前：
- 所有示例使用 `{BASE_IRI}` 占位符
- 所有工具（验证器、OWL 导出器）需支持占位符模式
- CI/CD 管道需检测占位符泄漏
- 不要对外发布包含占位符的 RDF 文件
