<a id="exhibition-ai-guide"></a>

# 展厅 AI 导览

本页是辅助中文译文，以[英文原文](../../README.md)为准。

展厅访客可以就审核过的展品资料提问，听数字导览员讲解相关内容，图片则跟随所说的句子展示。

应用帮助访客无需等待人工导览即可找到可靠信息，也帮助展厅工作人员避免没有依据的回答。

当前界面使用中文，评审文档以英文为主。

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

目前没有已发布且可供评审使用的公开演示或部署；公开样例语料和可复现操作说明仍待完成。

对话与导览状态保存在内存中；面向访客的业务数据库和可独立运行的 CPU 核心模式列在[路线图 #9](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/9)中，尚未实现。

现有 CPU embedding 组件和仅健康检查可用的开发模式，不等于计划中的 CPU 应用。

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
./tools/linux.sh test
```

本次文档工作只检查链接、语法和命令定义，不声称重新运行了产品测试。
