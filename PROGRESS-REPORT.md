# Axiolune 进度报告（指针页）

**状态**: **Approved** — M2 v0.3.0 语义审查通过  
**日期**: 2026-08-03

本文件仅为入口指针。**不要**引用 Round 5 或 v0.2.0 的 PASS/approved 叙事。

## Canonical 文档

| 用途 | 路径 |
|------|------|
| 诚实 M2 进度 | [docs/domain/decisions/PROGRESS-REPORT.md](docs/domain/decisions/PROGRESS-REPORT.md) |
| **当前审查结论** | [docs/domain/decisions/M2-REVIEW-ROUND-11.md](docs/domain/decisions/M2-REVIEW-ROUND-11.md) |
| 上一轮 Stop-Ship | [docs/domain/decisions/M2-REVIEW-ROUND-10.md](docs/domain/decisions/M2-REVIEW-ROUND-10.md) |
| 撤销 v0.2.0 授权 | [docs/domain/decisions/ADR-015-revoke-v0.2.0-approval.md](docs/domain/decisions/ADR-015-revoke-v0.2.0-approval.md) |
| 语义验收合同 | [docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md](docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md) |
| 实施计划 | [docs/domain/planning/M2-PLAN.md](docs/domain/planning/M2-PLAN.md) |
| 文档索引 | [docs/CANONICAL-INDEX.md](docs/CANONICAL-INDEX.md) |

## 门禁命令（冒烟，非 acceptance）

```bash
node scripts/meta/test-all.js          # M3 meta-model
node scripts/domain/test-all-domain.js # M2 domain structural smoke
node scripts/domain/run-all-cq-probes.cjs # CQ honesty probes
```
