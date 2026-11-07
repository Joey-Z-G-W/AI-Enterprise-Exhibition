<a id="public-tracker-and-delivery-record"></a>

# 公开任务跟踪与交付记录

本页是辅助中文译文，以[英文原文](../en/tracker.md)为准。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

任务 #11 确立英文权威，并把完整中文译文限定在 `docs/ch/`，不实施后续路线图批次。

[E1 当前任务 #11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11)、[E2 路线图 #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9)和 [E3 验证记录](verification.md)提供当前范围与证据。

<a id="existing-tasks"></a>

## 既有任务

| 任务 | 交付作用 | 当前解释 |
| --- | --- | --- |
| [#1 邮件回访](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/1) | 同意、专家审核和真实邮件投递。 | 后续工作，本批次未实现。 |
| [#6 内容扩充](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/6) | 审核更多归档企业案例/图片。 | 独立内容工作，此处不发布企业归档。 |
| [#7 动态舞台](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/7) | 数字人/资料布局与无图平滑状态。 | 历史已实现功能，任务保持开启供用户反馈。 |
| [#8 同步到 main](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8) | 从 `ruika` 迁移已验收的通用功能。 | `4e81d9d` 上的历史同步与独立 QA。 |
| [#9 课程路线图](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9) | 持久化、可复现交付、部署与运维。 | 后续批次待完成，目标分数不是已得分。 |
| [#10 英文文档与工作流](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10) | 包含 AC1–AC7 的历史文档批次。 | 已在 `f30f180` 发布，之前的 Engineer/QA 证据保留在下文。 |
| [#11 英文主文与中文译文](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11) | 包含 AC1–AC6 的当前语言/路径迁移。 | 完整翻译、英文原文检查与独立发布审核。 |

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

<a id="current-role-activity"></a>

## 当前角色活动

任务 [#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11)从 `main` 的 `f30f180` 开始，复用既有任务目录存放被忽略的证据。

| 角色 | 真实活动 | 证据/状态 |
| --- | --- | --- |
| PM | 在 #11 梳理英文优先政策、完整中文译文集和精确文件范围。 | [PM 交付](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11#issuecomment-6707689086)与 #11 验收标准。 |
| Engineer | 阅读 #11，将八份英文模块迁到 ASCII 路径，翻译全部十页，更新双向导航和发布规则。 | 当前差异与[语言迁移验证](verification.md#current-localization-checks)。 |
| 独立 QA | 语言纯度、翻译完整性、导航与范围需要独立验收。 | 实际 QA 结果见 #11。 |
| PM 发布 | 发布通过审核的文档，并验证远端 main 与公开文件内容。 | 最终审核提交、发布回执和远端读取结果见 #11。 |

本次语言迁移不声称重新执行应用、GPU 或浏览器测试。
