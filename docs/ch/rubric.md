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
| 产品规格（Product Specification） | 2 | [规格](product-spec.md)、公开 [#10](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10) 的验收标准与[历史 PM/Engineer/QA 记录](tracker.md#historical-documentation-activity)。 | 历史发布回执见 #10，语言迁移评审见 #11；等待评审判断。 |
| 代理团队规格（Agent Team Specification） | 2 | [团队角色](team.md)与[流程](process.md)。 | 历史 QA 记录在 #10/#11，当前应用/交付 QA 归 #12。 |
| 上下文管理（Context Management） | 2 | [根 AGENTS 的中文译文](agent-guide.md)对应链接模块化仓内文档的英文权威指引。 | 在推送后的分支验证每个链接。 |
| 应用（Application） | 2 | [React](../../frontend/src/App.tsx)、[FastAPI](../../src/exhibition_guide/main.py)和历史 [#8](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8)。 | CPU SQLite 样例流程及 [HTTP/浏览器测试](testing.md#cpu-and-deployment-acceptance)已在 #12 实现；最终执行证据见[验证](verification.md)。 |
| 测试（Testing） | 2 | [测试命令与历史结果](testing.md)。 | 新的可复现结果及历史边界审计待完成，保守按 1 分规划。 |
| 容器化（Containerization） | 2 | [Dockerfile](../../Dockerfile) 与 [Compose](../../compose.yaml) 启动 CPU UI/API/SQLite。 | 真实镜像、重启和浏览器验收记录在 #12。 |
| 部署（Deployment） | 2 | [本机部署命令](README.md#local-deployment-and-rollback)，dev 8090/prod 8091。 | 本机 Docker 演示，并非公网托管 URL；执行证据见 #12。 |
| CI/CD | 3 | [托管 CI](../../.github/workflows/ci.yml)、可信 main 控制器、人工 prod 和回滚。 | #12 必须提供真实 CI/deployment 链接和失败证据。 |
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
