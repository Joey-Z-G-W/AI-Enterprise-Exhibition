<a id="documentation-batch-verification"></a>

# 文档批次验证

本页是辅助中文译文，以[英文原文](../en/verification.md)为准。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

任务 #11 只修改文档语言、路径与精确忽略例外，产品代码和运行服务不在范围内。

[E1 当前任务验收标准](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11)、[E2 当前角色记录](tracker.md#current-role-activity)、[E3 启动源码](../../tools/linux.sh)和 [E4 历史测试](testing.md#historical-evidence-and-score-limit)提供审计线索。

<a id="historical-engineer-checks"></a>

## 历史 Engineer 检查

已在 `f30f180` 发布的历史任务 #10 中，Engineer 阅读了完整 #10 任务、当时官方评分标准、Linux 启动脚本源码、前端脚本、示例配置、API 契约及 #8 的历史 QA/发布评论。

本地验证覆盖 Markdown 目标存在性和标题锚点、shell 语法/帮助、预期启动命令分支、配置默认值、精确公开文档允许列表和空白错误。

Engineer 验证中，10 份 Markdown 文档、65 个本地链接/锚点、shell 语法/帮助、预期命令分支和精确忽略行为均通过。

[Engineer 交付](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707553029)记录了 10 份文档、65 个本地链接/锚点及命令和忽略检查通过，没有公开原始私有证据。

该历史文档批次没有声称安装依赖、下载模型、启动 GPU、执行应用测试套件、构建、部署或浏览器验收；当前 #11 采用相同排除范围。

<a id="historical-independent-qa-and-publication"></a>

## 历史独立 QA 与发布

[独立本地 QA 报告](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707585830)记录了 10 份文档、65 个本地链接/锚点、20 个忽略探针、精确 11 文件范围、shell 语法/帮助及产品文件未变均通过。

QA 发现规格错误地把冲突回答描述成人工移交；Engineer 改为实现中的明确无法确认响应，QA 再次核查修复。

[最终发布验收](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707633096)记录历史 #10 的审核提交、远端发布回执和已推送分支读取结果。

本地审核覆盖发布前可核对的 AC1–AC7、源码/命令准确性与排除项，包括被忽略的 evidence/tmp 目录和未变的 vendor 指针；最终远端验收是单独记录的关卡。

历史发布关卡要求从已推送分支读取 README、AGENTS 及八份关联公开任务文档，并确认分支头与审核提交一致。

<a id="current-localization-checks"></a>

## 当前语言迁移检查

#11 的 Engineer 验证检查全部十份英文原始 Markdown 中的中文字符和 CJK 标点、十份完整中文对应页、双向链接、本地目标/锚点、相同命令代码块、表格/章节覆盖和精确发布范围。

八份旧公开任务文档已删除；公开 docs 中仅允许八份 `docs/en/` 模块和十份 `docs/ch/` 译文，任务证据继续被忽略。

基线是 `main` 的 `f30f180`；之前 #10 文档检查和 #8 产品测试仍是历史证据，不是新执行结果。

独立 QA 必须核对语言纯度、忠实翻译、导航和产品文件未变；实际 QA 结果、最终审核提交、远端发布回执和读取检查见 [#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11)。

发布后，PM 必须从远端 main 读取根目录两份英文文档、八份英文模块和十份中文译文，并确认分支头等于审核提交。

<a id="recheck-commands"></a>

## 复查命令

检查当前差异的空白错误。

```bash
git diff --check
```

检查 shell 解析，不安装或启动任何内容。

```bash
bash -n tools/linux.sh tools/opentalking.sh
```

读取 Linux 入口支持的命令，不启动服务。

```bash
./tools/linux.sh --help
```
