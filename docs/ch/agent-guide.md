<a id="repository-agent-instructions"></a>

# 仓库代理指引

本页是辅助中文译文，以[英文原文](../../AGENTS.md)为准。

使用 React、FastAPI 和 OpenTalking 构建一个展厅导览应用，明确区分已实现行为与计划工作。

先阅读[产品规格](product-spec.md)与[架构及上下文](architecture.md)。

<a id="required-context"></a>

## 必读上下文

- 按[开发流程](process.md)，一次处理一个梳理完成的任务。
- 按[团队职责](team.md)执行：PM → Engineer → 独立 QA。
- 遵守[测试边界](testing.md)，只新增接口、集成或系统测试。
- 宣称完成前，查看[公开任务跟踪](tracker.md)和[证据映射](rubric.md)。

<a id="work-boundaries"></a>

## 工作边界

修改前阅读任务的验收标准及允许文件范围；发现冲突应向 PM 提出，不得默默扩大范围。

产品改动先通过接口、集成或系统测试复现预期差异，再实施并验证。

不新增单元测试；重写或删除本次触及的单元测试，不动无关历史测试。

独立 QA 代理必须核对每项验收标准和发布范围，Engineer 不能批准自己的工作。

每个需求使用一个 `docs/dev/YYYYMMDD-module-detailed-requirement/` 任务目录，每个故障使用一个 `docs/problem/YYYYMMDD-version-module-detailed-symptom/` 目录。

复用已有任务目录，将证据、临时脚本和中间 JSON 报告分别保存在 `evidence/`、`scripts/` 和 `tmp/` 子目录。

权威项目文档使用英文：根目录的 `README.md`、`AGENTS.md`，以及 `docs/en/` 下的八份模块文档。

仅在 `docs/ch/` 保留一套完整的辅助中文译文，代理指引译文使用 `agent-guide.md`；以英文为准。

英文 Markdown 的任何位置都不得包含中文字符或 CJK 标点，包括路径、链接目标和代码块；文件名和路径使用 ASCII，不通过编码隐藏非 ASCII 路径。

每份英文页面用英文标签链接其中文译文，每份译文链接回英文原文；两套文档同步更新，保留事实、命令、限制和待办状态。

仅发布精确允许列表内的文档；任务私有证据保持忽略，任务目录内不保留公开副本。

不得提交凭据、客户语料、私有配置、下载模型、vendor 工作树修改或无关用户改动。

当另一分支正在运行本机体验时，使用独立 worktree；不得停止其服务或覆盖其 README。

在任务中记录真实角色活动和实际检查，标注历史结果，未完成的验收项保持待办。

当前语言迁移为 [#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11)，基于 `main` 的 `f30f180`；之前的文档任务是 [#10](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10)，后续运行与运维工作属于 [#9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9)。
