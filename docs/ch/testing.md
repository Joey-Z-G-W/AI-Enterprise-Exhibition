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
./tools/course_verify.sh
```

它依次运行 Python pytest、前端类型检查/构建、浏览器语音集成、横屏浏览器集成、横屏系统集成、VAD 开发资源集成、CPU 前端构建和 CPU 样例真实浏览器系统流程。

这条命令不代表仓库内所有可选脚本都已包含；专门的 RTC/GPU 检查需要自己的依赖和已配置运行环境。

浏览器测试使用 `playwright-core` 和已安装浏览器；可选 embedding 检查需要已下载权重和本地配置，显式启用的 GPU 取消检查需要 `TOUR_LIVE_ORIGIN`。

历史 helper 与测试仍需做边界审计，不宣称所有现有文件都已符合当前政策。

<a id="historical-evidence-and-score-limit"></a>

## 历史证据与评分限制

公开的[独立迁移 QA 记录](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8#issuecomment-6707409190)报告了基线 `4e81d9d` 上 366 项 Python 测试通过、5 项可选跳过、前端构建和舞台浏览器检查通过。

这些是之前迁移的历史结果，不是本次文档改动重新执行的结果。

官方课程满分 Testing 要求同时存在单元与集成测试；本仓库禁止新增单元测试，因此在如实审计未触及的历史测试之前，保守按 1 分规划。

<a id="cpu-and-deployment-acceptance"></a>

## CPU 与部署验收

[HTTP 集成](../../tests/test_demo_http.py)使用真实 SQLite 和公开应用 API；[浏览器系统覆盖](../../tests/frontend/demo-system.cjs)运行实际 React/FastAPI 样例。

[CLI 契约](../../tests/test_deploy_cli.py)通过子进程执行命令，不导入部署内部函数。

[发布系统测试](../../tests/deployment/test_release_system.py)需要显式启用，因为它会修改授权的本机 dev/prod 环境，并需要两个不同提交的成功 main CI release；它不替换应用/数据库，也不删除数据卷。

```bash
COURSE_RELEASE_RUN_A=FIRST_SUCCESSFUL_MAIN_RUN_ID \
COURSE_RELEASE_RUN_B=SECOND_SUCCESSFUL_MAIN_RUN_ID \
.venv/bin/python -m pytest tests/deployment/test_release_system.py -q
```

执行这个受控流程时先停止轮询控制器，避免自动 dev 晋级与测试竞争；完成后重新启动。

流程部署并晋级 A，写入真实问题/评分，部署并晋级 B，重启 B，将 prod 回滚至 A，然后注入不健康 B 容器，再次尝试回滚。

断言覆盖精确 release 身份、历史保留、坏候选拒绝以及健康路由不变；所有操作都创建 GitHub Deployment 状态。

缺少任一 run ID 时明确报告 skip；普通 CI 不得声称已经执行这项主机专用验收。

托管 workflow 执行全部既有 Python 回归、五组浏览器测试、文档中的 `docker compose up --build --wait`、针对完整环境的浏览器流程以及[真实 Compose 重建/持久化验收](../../tests/deployment/compose_persistence.py)；只有成功的 push/main run 上传可部署 artifact。

验证步骤失败会阻止镜像发布，控制器忽略失败的 CI run；PR 验证不会在本机 Docker 主机运行。

<a id="local-controller-lifecycle"></a>

## 本机控制器生命周期

`tools/course_runner.sh install` 只复制已审核的独立控制器；`start` 检查 GitHub 登录与 Docker 后启动后台进程，`stop` 先核对 PID 命令再停止。

状态/artifact 目录应在临时 worktree 之外；如需重启后恢复，配置用户服务，并明确审核、重新安装控制器更新。

主机必须在线并保持 Docker 权限与 GitHub 登录；停止控制器不会停止应用容器，只会暂停后续部署处理。
