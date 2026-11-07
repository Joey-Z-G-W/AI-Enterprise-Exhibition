<a id="exhibition-ai-guide"></a>

# 展厅 AI 导览

本页是辅助中文译文，以[英文原文](../../README.md)为准。

展厅访客可以就审核过的展品资料提问，听数字导览员讲解相关内容，图片则跟随所说的句子展示。

应用帮助访客无需等待人工导览即可找到可靠信息，也帮助展厅工作人员避免没有依据的回答。

原有 GPU 界面使用中文；CPU 样例界面和权威评审文档使用英文。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

| 入口 | 内容 |
| --- | --- |
| [E1 产品规格](product-spec.md) | 用户、可观察验收标准、已实现范围和路线图 |
| [E2 架构](architecture.md) | React、FastAPI、OpenTalking、配置和数据边界 |
| [E3 代理指引](agent-guide.md) | 仓内流程、角色和测试规则 |
| [E4 公开任务跟踪](tracker.md) | 当前工作、真实角色活动和历史基线 |
| [E5 课程证据](rubric.md) | 全部 12 项评分标准、缺口和目标 |
| [E6 验证记录](verification.md) | 本次文档工作执行的检查 |

<a id="functionality-and-expected-behavior"></a>

## 功能与预期行为

已实现的 GPU 体验结合了语音采集、基于检索的回答、整段播报、WebRTC 数字人、逐句同步图片、案例记忆、打断和动态展示舞台。

回答应引用有依据的资料，需要时请求澄清，并承认缺少证据，而不是编造展品事实。

新访客或打断发生后，旧语音和图片不得再次出现。

这些能力已存在于公开源码中；新检出的仓库仍需运行配置、模型和审核资料才能提供完整体验。

<a id="current-limits-and-demo-status"></a>

## 当前限制与演示状态

公开产品基线 `main` 的 `4e81d9d` 通过[任务 #8](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/8)，包含了从 `ruika` 的 `a523fa1` 同步的通用功能。

其中明确不包含企业语料、私有配置和本地修改的 vendor 工作树。

CPU 样例模式在 [#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12) 中增加原创虚构展品、确定性证据检索、SQLite 访客历史和反馈，以及 Docker 交付。

它不调用实时 LLM，也不渲染数字人；原有 GPU 模式仍可按下文使用。

本次选择本机 Docker 部署，dev/prod URL 仅监听回环地址，并非公网托管服务；见[已执行验证和剩余关卡](verification.md)。

<a id="cpu-sample-quick-start"></a>

## CPU 样例快速启动

安装 Docker Engine 与 Docker Compose，从全新检出目录运行；不需要 Python 环境、GPU、API key 或私有配置。

```bash
docker compose up --build --wait
```

打开[样例导览](http://127.0.0.1:8090)，选择虚构展品，提出其中一个示例问题，提交反馈，然后刷新查看保留的历史。

使用清空历史删除自己的记录，或使用新访客操作开始隔离会话。

应用在同一源提供构建后的 React 界面和 FastAPI；命名卷 `course-demo_guide-data` 在重启/重建后保留 SQLite 数据。

```bash
docker compose restart
docker compose up --build --force-recreate --wait
```

需要保留访客数据时，不要给 `docker compose down` 加 `--volumes`。

如果受管 dev 已占用 8090，用 `GUIDE_PORT=8092 docker compose up --build --wait` 启动独立样例，并打开 8092。

[sample_data](../../src/exhibition_guide/sample_data/) 包含样例作者记录、许可、稳定 ID 和校验值，不需要企业语料。

<a id="local-deployment-and-rollback"></a>

## 本机部署与回滚

[Course CI](../../.github/workflows/ci.yml) 在 GitHub 托管 runner 上运行 PR 和 main 的测试、镜像构建；只有本仓 main push 成功才发布可部署镜像 artifact。

固定的本机控制器下载该次运行的精确 artifact，核对提交、校验值和镜像身份，启动候选，仅在就绪成功后切换稳定网关路由。

dev 使用 8090 和卷 `course-dev-data`，prod 使用 8091 和卷 `course-prod-data`，访客 cookie 也分开。

在同端口启动受管 dev 前，先停止独立 Compose 样例。

```bash
./tools/course_runner.sh install
./tools/course_runner.sh start
./tools/course_runner.sh status
python3 tools/course_deploy.py promote
python3 tools/course_deploy.py rollback --environment prod
./tools/course_runner.sh stop
```

控制器需要 Docker 权限、具备 Actions 读取与 Deployments 写入权限的 GitHub CLI 登录，以及在线主机；不注册 self-hosted Actions runner，PR 代码不会分配给这台主机执行。

`install` 把审核后的控制器复制到检出目录之外；改动需明确审核、重新安装，主机重启后需再次启动或配置用户服务。

可通过 `COURSE_CONTROLLER_DIR` 和 `COURSE_STATE_DIR` 指定持久目录；CLI 子命令之前通过 `--state-dir` 传入同一状态路径。

每次部署在本机状态和 [GitHub Deployments](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/deployments) 记录 CI run、精确提交与镜像 ID；环境 URL 只能在选定主机访问。

回滚使用上一个健康验证镜像，保留数据库卷；候选必须兼容现有 SQLite schema，破坏性 schema 迁移需要另行设计备份与迁移方案。

镜像 artifact 保存 14 天；回滚保留本机已验证镜像，新晋级则需要仍保留的 CI artifact。

包含两个真实 release 和坏候选恢复的详细验收见[测试](testing.md)。

<a id="linux-setup-and-development"></a>

## Linux 安装与开发

所有命令均从仓库根目录执行；Linux 环境需具备 Git、Bash、带 pip 的 Python 3、curl、tar、xz 和 sha256sum，并能访问配置的包与模型仓库。

安装脚本准备 Python 3.11、安装锁定的依赖，并在没有 Node 时下载 Node.js 22；已有 Node 必须为 22 或更高版本。

安装前后端依赖，并从示例生成已被 Git 忽略的 `config/local.toml`。

```bash
./tools/linux.sh setup
./tools/linux.sh doctor
```

仅启动前端与业务后端，然后打开[本机界面](http://127.0.0.1:5290)。

```bash
./tools/linux.sh dev
```

业务后端默认监听 `127.0.0.1:8010`；Vite 将 `/guide` 代理到该后端，将 `/opentalking` 代理到 `8210` 端口。

默认配置未启用业务服务，健康检查和 UI 配置可以访问，但提问返回 HTTP 503 与 `service_not_configured`，完整数字人体验不可用。

在第二个终端检查进程健康；此操作不验证问答能力或 GPU 就绪状态。

```bash
curl --fail http://127.0.0.1:5290/guide/health
```

<a id="full-gpu-experience"></a>

## 完整 GPU 体验

安装原生运行依赖所需的 C/C++ 构建工具，并使用兼容的本机 NVIDIA/CUDA 环境；提供的配置面向 8 GB 显存的 RTX 4060，本次文档工作没有验证其他硬件。

完成基础安装后，初始化固定版本的 OpenTalking 子模块及其独立运行环境，再下载数字人、语音和 embedding 模型。

```bash
./tools/linux.sh opentalking setup
./tools/linux.sh opentalking download
```

配置被忽略的 `config/local.toml`：启用并填写 LLM 地址、模型和密钥；启用本地 embedding 地址、模型、维度和密钥；在 `knowledge.kb_id` 中填写已导入的知识库 ID。

按硬件检查被忽略的 `config/opentalking.env`；模板见[公开 GPU 配置](../../config/opentalking.example.env)。

使用可公开且已审核的资料在 OpenTalking 中准备知识库，需要配图讲解时配置审核后的媒体清单；公开样例准备说明仍待完成。

本地 embedding 服务需要非空令牌和已下载的权重；默认完整运行环境还依赖外部 LLM 和 Edge TTS 服务。

先用 Ctrl+C 停止之前的 `dev` 进程，再一起启动前端、业务后端、embedding 服务和 OpenTalking。

```bash
./tools/linux.sh start
```

启动器等待 `5290`、`8210` 和 `8220` 端口的健康响应；启动成功本身不能证明知识库、模型凭据或媒体可用。

<a id="build-and-test"></a>

## 构建与测试

安装完成后构建前端。

```bash
./tools/linux.sh build
```

安装 Google Chrome 后运行现有的统一验证入口；依赖、范围及历史限制见 [E7 测试说明](testing.md)。

```bash
./tools/course_verify.sh
```

该命令运行 Python、既有语音/横屏/浏览器系统回归和 CPU 样例浏览器流程；实际结果及待完成的运行检查记录在[验证](verification.md)。
