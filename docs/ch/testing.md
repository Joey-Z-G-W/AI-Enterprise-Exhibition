<a id="testing-policy-and-execution"></a>

# 测试政策与执行

本页是辅助中文译文，以[英文原文](../en/testing.md)为准。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

新增或修改的测试必须覆盖接口、集成或完整系统边界；仓库政策禁止新增单元测试。

[E1 统一启动脚本](../../tools/linux.sh)、[E2 前端脚本](../../frontend/package.json)、[E3 Python 配置](../../pyproject.toml)和 [E4 当前验证](verification.md)区分可运行命令与本次实际执行的检查。

<a id="test-boundaries"></a>

## 测试边界

| 层级 | 入口与断言 | 允许替身 |
| --- | --- | --- |
| 接口 | 公开 HTTP/RPC/CLI/消息契约，断言响应或外部可观察状态。 | 被测模块边界之外的依赖。 |
| 集成 | 组装多个真实模块，断言跨模块契约。 | 所组装应用边界之外的系统。 |
| 系统 | 完整部署或仿真应用，断言用户可见流程。 | 不替换内部应用模块。 |

直接调用私有 helper 或孤立业务函数、替换内部对象/函数、只断言内部调用次数/状态，都属于单元测试，不得引入。

本次改动触及的单元测试应重写或删除；无关历史测试保持不变，不把任务扩展成全仓清理。

<a id="commands-and-prerequisites"></a>

## 命令与前提

完成 [README 安装](README.md#linux-setup-and-development)后，在已安装 Google Chrome 的环境运行现有统一入口。

```bash
./tools/linux.sh test
```

它依次运行 Python pytest、前端类型检查/构建、浏览器语音集成、横屏浏览器集成和横屏系统集成。

这条命令不代表仓库内所有可选脚本都已包含；专门的 RTC/GPU 检查需要自己的依赖和已配置运行环境。

浏览器测试使用 `playwright-core` 和已安装浏览器；可选 embedding 检查需要已下载权重和本地配置，显式启用的 GPU 取消检查需要 `TOUR_LIVE_ORIGIN`。

历史 helper 与测试仍需做边界审计，不宣称所有现有文件都已符合当前政策。

<a id="historical-evidence-and-score-limit"></a>

## 历史证据与评分限制

公开的[独立迁移 QA 记录](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707409190)报告了基线 `4e81d9d` 上 366 项 Python 测试通过、5 项可选跳过、前端构建和舞台浏览器检查通过。

这些是之前迁移的历史结果，不是本次文档改动重新执行的结果。

官方课程满分 Testing 要求同时存在单元与集成测试；本仓库禁止新增单元测试，因此在如实审计未触及的历史测试之前，保守按 1 分规划。
