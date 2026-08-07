# Axiolune 进度报告（指针页）

**状态**: **Approved** — M2 v1.0.0 语义审查通过 + v1.1.0/v2.0.0 架构修订已落地  
**日期**: 2026-08-07

本文件仅为入口指针。**不要**引用 Round 5–11 或 v0.2.0 的 PASS/approved 叙事作为最终完成证据。

## Canonical 文档

| 用途 | 路径 |
|------|------|
| 诚实 M2 进度 | [docs/domain/decisions/PROGRESS-REPORT.md](docs/domain/decisions/PROGRESS-REPORT.md) |
| v1.0.0 基线审查 | [docs/domain/decisions/M2-REVIEW-ROUND-12.md](docs/domain/decisions/M2-REVIEW-ROUND-12.md) |
| 架构修订审查 (R13–R19) | [docs/domain/decisions/M2-REVIEW-ROUND-13.md](docs/domain/decisions/M2-REVIEW-ROUND-13.md) … [Round-19](docs/domain/decisions/M2-REVIEW-ROUND-19.md) |
| v1.0.0 完成 + M1 交接 | [docs/domain/decisions/ADR-017-m2-v1-completion-and-m1-handoff.md](docs/domain/decisions/ADR-017-m2-v1-completion-and-m1-handoff.md) |
| 撤销 v0.2.0 授权 | [docs/domain/decisions/ADR-015-revoke-v0.2.0-approval.md](docs/domain/decisions/ADR-015-revoke-v0.2.0-approval.md) |
| 语义验收合同 | [docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md](docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md) |
| 实施计划 | [docs/domain/planning/M2-PLAN.md](docs/domain/planning/M2-PLAN.md) |
| 文档索引 | [docs/CANONICAL-INDEX.md](docs/CANONICAL-INDEX.md) |

## 门禁命令（冒烟，非 acceptance）

```bash
node scripts/meta/test-all.js              # M3 meta-model
node scripts/domain/test-all-domain.js     # M2 domain structural smoke
node scripts/domain/run-all-cq-probes.cjs  # CQ honesty probes
node scripts/domain/audit-sidecar-sync.cjs # sidecar/registry 同步审计
```
