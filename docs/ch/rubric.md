<a id="course-evidence-and-gaps"></a>

# 课程证据与缺口

本页是辅助中文译文，以[英文原文](../en/rubric.md)为准。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

2026-11-07 核对的[官方项目评分标准](https://github.com/DataTalksClub/ai-dev-tools-zoomcamp/blob/main/project/README.md)共有 12 项，总分 24 分，10 分为通过门槛。

英文文档和三份互评是强制要求；截止日期与提交/评审流程以[课程平台](https://courses.datatalks.club/ai-dev-tools-2026/)为准。

[E1 README](README.md)、[E2 产品规格](product-spec.md)、[E3 任务跟踪](tracker.md)和 [E4 验证记录](verification.md)是评审入口。

<a id="evidence-map"></a>

## 证据映射

这里的证据用于支持评审，不代表已授予分数，也不能替代可运行演示。

| 评分项 | 满分 | 当前可访问证据 | 缺少证据 / 下一步 |
| --- | ---: | --- | --- |
| 问题描述（Problem Description） | 2 | [README 用户、问题与预期行为](README.md#functionality-and-expected-behavior)。 | 等待评审判断。 |
| 产品规格（Product Specification） | 2 | [规格](product-spec.md)、公开 [#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) 验收标准与[真实角色活动](tracker.md#current-role-activity)。 | 之前的文档/语言迁移回执保留在 #10/#11；等待评审判断。 |
| 代理团队规格（Agent Team Specification） | 2 | [团队角色](team.md)、[流程](process.md)和[独立实现 QA](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12#issuecomment-6708934862)。 | 最终运行验收记录在 #12。 |
| 上下文管理（Context Management） | 2 | [根 AGENTS 的中文译文](agent-guide.md)对应链接模块化仓内文档的英文权威指引。 | 在推送后的分支验证每个链接。 |
| 应用（Application） | 2 | [CPU React 界面](../../frontend/src/DemoApp.tsx)、[FastAPI/SQLite](../../src/exhibition_guide/demo.py)及[已执行的持久化/隔离检查](verification.md#current-delivery-checks)。 | 原 GPU 模式仍可使用；CPU 样例明确采用本地检索，不是实时 LLM。 |
| 测试（Testing） | 2 | [统一命令](testing.md)及[实际 402 项通过的 CI/浏览器证据](verification.md#current-delivery-checks)，六项可选跳过均已归因。 | 保守按 1 分规划；政策禁止新增单元测试，历史边界审计仍待完成。 |
| 容器化（Containerization） | 2 | [Dockerfile](../../Dockerfile)、[Compose](../../compose.yaml)及[已执行的干净构建/重建](verification.md#current-delivery-checks)。 | 真实命名卷持久化已独立验证，不需要开发环境或 GPU。 |
| 部署（Deployment） | 2 | [本机部署命令](README.md#local-deployment-and-rollback)与[真实本机 Docker 演示与验收](verification.md#local-sample-demonstration)。 | 仅回环地址演示，并非公网托管 URL；托管发布身份见 #12。 |
| CI/CD | 3 | [成功 main CI](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/actions/runs/42385984934)、[真实自动 dev/人工 prod 部署](verification.md#current-delivery-checks)及验证失败拒绝交付。 | 最终部署版本与双发布回滚验收持续记录在 [#12 发布回执](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12)。 |
| 可观测性（Observability） | 2 | 不宣称已有遥测关联/UI 证据。 | 共享请求身份的日志、指标、追踪与隐私检查待完成。 |
| 用户影响告警（Alerting on User Impact） | 1 | 不宣称已有告警证据。 | 触发用户影响告警并展示恢复。 |
| 值班代理（On-Call Agent） | 2 | 不宣称已有响应代理证据。 | 进阶目标：告警触发诊断、受限修复和验证。 |
| **总计可得** | **24** | **不宣称当前已获总分。** | **分数需要评审判断与实际执行证据。** |

<a id="delivery-targets"></a>

## 交付目标

[路线图 #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9)在完成其余应用、交付及运维工作后，先争取 20–21/24，再通过值班响应代理争取约 23/24。

这是规划目标，不是当前分数或保证；Testing 保守预算为 1 分，因为仓库禁止新增单元测试，而评分满分要求单元与集成测试。

初始目标取决于展示出的 CI/CD 层级；#12 实现持久化与交付，阶段 5–6 的可观测性、告警和值班响应仍待完成。

任何本地历史报告、运行数据库文件或计划架构，都不计作本次新演示的课程交付物。
