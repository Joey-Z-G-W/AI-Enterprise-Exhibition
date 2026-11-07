<a id="verification-and-release-evidence"></a>

# 验证与发布证据

本页是辅助中文译文，以[英文原文](../en/verification.md)为准。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

[#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) 覆盖持久化 CPU 样例和路线图阶段 2–4，在独立 worktree 从 main `f9943c9` 开始。

[E1 验收标准](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12)、[E2 角色活动](tracker.md#current-role-activity)、[E3 测试命令](testing.md)和 [E4 CI workflow](../../.github/workflows/ci.yml)是审计入口。

源码实现与已执行证据分开；只有记录独立 QA 和最终远端发布验收后，才可认为任务完成。

<a id="current-delivery-checks"></a>

## 当前交付检查

部署 CLI 的四个接口测试先因命令不存在而失败，实现后通过；可选的双 release 系统测试在未提供真实 main CI run ID 时报告 skip。

本机 Docker Compose 配置校验通过；首次本机镜像构建在编译前被主机 Docker daemon 的镜像仓库请求 EOF 阻塞。

这个网络失败不是容器测试通过；仍需托管镜像构建和实际本机容器/浏览器验收。

新增交付脚本的 shell 语法与 Python 编译检查通过。

| 关卡 | 状态与所需证据 |
| --- | --- |
| 完整 Python 与真实浏览器回归 | 待最终统一结果与独立 QA。 |
| CPU Compose 启动/重启及浏览器流程 | 待真实镜像和 SQLite 记录保留证据。 |
| PR/main CI 成功 | 待公开 run URL 和精确提交。 |
| 受控验证失败 | 待失败 run 或坏候选记录，证明交付保持阻断。 |
| 自动 dev 部署 | 待成功 GitHub Deployment，包含精确 CI run/镜像/提交。 |
| 人工 prod 晋级和回滚 | 待两个真实 release、记录保留和坏候选拒绝。 |
| 发布 | 待最终审核后的 main 提交、公开链接和独立验收。 |

PM 在 #12 的最终发布回执必须用真实 run/deployment 链接替换待完成的运行声明；仅有配置文件不能满足这些关卡。

<a id="current-localization-checks"></a>

## 当前双语检查

英文 README/AGENTS 和八份 `docs/en/` 页面保持权威，`docs/ch/` 保留完整对应中文版本。

交付更新必须保持双向链接、相同命令块、英文原始 Markdown 无中文字符或 CJK 标点，并继续忽略任务证据。

独立 QA 必须检查最终 diff 和两套语言内容，不能只引用历史语言迁移基线。

<a id="historical-evidence"></a>

## 历史证据

[#8 迁移 QA](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707409190)在基线 `4e81d9d` 报告 366 个 Python 通过和五个可选 skip；这些仍是历史结果。

历史 [#10 本地 QA](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707585830)检查十份文档、65 个链接/锚点、20 个忽略探针和产品文件未变；其[最终发布验收](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/10#issuecomment-6707633096)与本次运行任务分开。

[#11](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/11)确立英文主文档和完整中文译文，没有执行新的 CPU/Docker 交付路径。

<a id="recheck-commands"></a>

## 复查命令

```bash
git diff --check
bash -n tools/course_verify.sh tools/course_runner.sh
python3 -m py_compile tools/course_deploy.py tools/course_proxy.py
./tools/course_verify.sh
```

完整验证命令需要已安装的 Python/Node 依赖和 Google Chrome；主机专用发布验收还需要两个真实 main CI artifact、GitHub 权限和 Docker 访问，见[测试](testing.md#cpu-and-deployment-acceptance)。
