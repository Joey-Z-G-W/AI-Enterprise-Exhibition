<a id="public-tracker-and-delivery-record"></a>

# 公开任务跟踪与交付记录

本页是辅助中文译文，以[英文原文](../en/tracker.md)为准。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

任务 #12 交付路线图阶段 2–4：持久化 CPU 样例、可复现 Docker 交付和可信 main 本机 CI/CD。

历史任务 #11 确立英文权威版本，并将完整译文限定在 `docs/ch/`。

[E1 当前任务 #12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12)、[E2 路线图 #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9)和 [E3 验证记录](verification.md)提供当前范围与证据。

<a id="existing-tasks"></a>

## 既有任务

| 任务 | 交付作用 | 当前解释 |
| --- | --- | --- |
| [#1 邮件回访](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/1) | 同意、专家审核和真实邮件投递。 | 后续工作，本批次未实现。 |
| [#6 内容扩充](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/6) | 审核更多归档企业案例/图片。 | 独立内容工作，此处不发布企业归档。 |
| [#7 动态舞台](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/7) | 数字人/资料布局与无图平滑状态。 | 历史已实现功能，任务保持开启供用户反馈。 |
| [#8 同步到 main](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8) | 从 `ruika` 迁移已验收的通用功能。 | `4e81d9d` 上的历史同步与独立 QA。 |
| [#9 课程路线图](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9) | 持久化、可复现交付、部署与运维。 | 阶段 2–4 归 #12，阶段 5–6 仍待完成；目标不是已获分数。 |
| [#10 英文文档与工作流](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10) | 包含 AC1–AC7 的历史文档批次。 | 已在 `f30f180` 发布，之前的 Engineer/QA 证据保留在下文。 |
| [#11 英文权威与中文译文](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11) | 历史语言/路径迁移，AC1–AC6。 | 已发布于基线 f9943c9，继续维护译文。 |
| [#12 CPU 样例与 Docker CI/CD](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) | 当前运行/交付任务，AC1–AC12。 | 分别跟踪实现与实际验证。 |

<a id="baseline-record"></a>

## 基线记录

原始产品基线为 [4e81d9d](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/commit/4e81d9d09b99002e254d9965b5f1ca37c415f9ad)，源功能分支为 `ruika` 的 `a523fa1`。

[#8 发布记录](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707410043)确认通用 main 同步，其中包括此前的 Linux 支持。

该迁移保留通用配置，排除了企业内容和私有配置；当前文档分支不修改产品源码、vendor gitlink 或原运行工作区。

<a id="historical-documentation-activity"></a>

## 历史文档活动

此历史记录描述 2026-11-07 的 #10 任务，已在 `f30f180` 发布；它不代表新产品测试，也不代表当前 #11 语言迁移 QA。

| 角色 | 真实活动 | 证据/状态 |
| --- | --- | --- |
| PM | 创建路线图 #9，按 AC1–AC7 梳理 #10，指定独立 main 基线 worktree 与明确的纯文档范围。 | [PM 交付](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707504126)、[#9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9)。 |
| Engineer | GPT-6 Astra Engineer 阅读 #10 与评分标准、检查 main 契约、编写英文文档，并修复 QA 发现的冲突证据描述问题。 | [Engineer 交付](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707553029)与[验证记录](verification.md)。 |
| 独立 QA | 独立 GPT-6.1 Sol QA 代理对照源码检查文档，发现不准确的人工移交措辞，并独立验证修正；本地检查通过。 | [初始发现](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707568906)、[本地 QA 结果](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707585830)；最终发布验收记录在 #10。 |
| PM 发布 | QA 后提交/推送并验证公开分支文档。 | 最终审核提交、发布回执与远端读取结果见 [#10](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10)。 |

本地 QA 报告与[最终发布验收](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707633096)明确区分；后者记录历史 #10 的审核提交和远端验收结果。

<a id="historical-localization-activity"></a>

## 历史语言迁移活动

任务 [#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11)从 `main` 的 `f30f180` 开始，复用既有任务目录存放被忽略的证据。

| 角色 | 真实活动 | 证据/状态 |
| --- | --- | --- |
| PM | 在 #11 梳理英文优先政策、完整中文译文集和精确文件范围。 | [PM 交付](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11#issuecomment-6707689086)与 #11 验收标准。 |
| Engineer | 阅读 #11，将八份英文模块迁到 ASCII 路径，翻译全部十页，更新双向导航和发布规则。 | 当前差异与[语言迁移验证](verification.md#current-localization-checks)。 |
| 独立 QA | 语言纯度、翻译完整性、导航与范围需要独立验收。 | 实际 QA 结果见 #11。 |
| PM 发布 | 发布通过审核的文档，并验证远端 main 与公开文件内容。 | 最终审核提交、发布回执和远端读取结果见 #11。 |

本次语言迁移不声称重新执行应用、GPU 或浏览器测试。

<a id="current-role-activity"></a>

## 当前角色活动

[#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) 在独立 worktree 从 main `f9943c9` 开始；原有 GPU 工作区、vendor 修改和无关容器均不在范围内。

| 角色 | 真实活动 | 证据/状态 |
| --- | --- | --- |
| PM | 梳理 AC1–AC12、分离应用/交付范围并确认本机 Docker 部署。 | [PM 交接](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12#issuecomment-6708111741)。 |
| 应用 Engineer | 实现 CPU 样例检索、持久化隔离会话/问题/反馈及 HTTP/浏览器测试。 | 源码 diff，精确检查见[验证](verification.md)。 |
| 交付 Engineer | 实现 Compose/镜像打包、统一验证、托管 CI 与固定可信 main 部署控制器。 | CLI 测试和源码 diff；实际容器/CI/CD 结果单独记录。 |
| 独立 QA | 必须检查 AC1–AC12、发布范围、运行隔离和操作证据。 | 待独立验收，最终结果见 #12。 |
| PM 发布 | 必须发布审核后的代码，验证 main CI 与真实本机部署、晋级和回滚。 | 最终发布回执待记录在 #12。 |

阶段 5–6 继续在 #9 保持待办；不宣称新增可观测性、告警或值班响应代理已完成。
