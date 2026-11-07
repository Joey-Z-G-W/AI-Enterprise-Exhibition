<a id="exhibition-guide-product-specification"></a>

# 展厅导览产品规格

本页是辅助中文译文，以[英文原文](../en/product-spec.md)为准。

<a id="overview-and-evidence-index"></a>

## 总览与证据索引

访客需要清晰、有依据的展品讲解；工作人员需要一个承认知识不足、不会混淆不同访客会话的导览助手。

产品同时提供原有本机 GPU 数字人体验，以及具备业务持久化和可复现 Docker 交付的独立 CPU 样例导览。

[E1 架构](architecture.md)、[E2 任务跟踪](tracker.md)、[E3 测试](testing.md)和 [E4 评分证据](rubric.md)区分源码证据与后续验收工作。

<a id="implemented-scope"></a>

## 已实现范围

公开基线 `4e81d9d` 包含 React 界面、FastAPI 提问与会话接口、OpenTalking 检索/语音/数字人集成、可选的审核媒体目录、播放回执、取消及动态舞台。

完整体验需要本地模型、GPU 运行环境、已配置知识库和外部服务凭据，这些不随公开样例数据提供。

原有 GPU 服务在内存中保存访客上下文；新增 CPU 样例应用在 SQLite 中持久化访客会话、问题和评分，支持重启/重建恢复。

样例 UI 提供展品浏览、有依据的问答、反馈、历史、清空历史和新访客；明确标注确定性样例检索，不冒充实时 LLM 或数字人。

包括隔离、校验、重试幂等、Docker 交付、可信 main CI/CD 与回滚的 CPU 验收 AC1–AC12 定义在 [#12](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/12)。

<a id="observable-acceptance-criteria"></a>

## 可观察验收标准

这些标准描述已实现范围的预期契约，必须在配置好的运行环境上验证；本次文档工作不声称重新执行了验收。

| 编号 | 场景与可观察结果 | 当前源码证据 |
| --- | --- | --- |
| S1 | 有依据的有效问题返回 HTTP 200，包含匹配的访客/轮次身份、回答文本和验证过的来源摘录；证据有歧义时请求澄清。 | [提问契约](../../src/exhibition_guide/answer.py) |
| S2 | 缺少证据时明确表示不知道；证据冲突时返回 `status=answer`，并明确说明资料冲突、无法确认正确答案。 | [回答决策](../../src/exhibition_guide/answer.py) |
| S3 | 已配置的 GPU 会话在整段播报中保持同一个 RTC 会话，审核图片跟随句子边界；图片缺失或失败时显示统一舞台背景。 | [展示协调](../../frontend/src/lib/presentationCoordinator.ts)、[舞台](../../frontend/src/App.tsx) |
| S4 | 停止、打断或新访客使旧回调不能恢复语音/图片；后续访客不得继承之前的导览状态。 | [会话上下文](../../src/exhibition_guide/context.py)、[浏览器集成](../../tests/frontend/stage-browser-integration.cjs) |
| E1 | 未启用问答配置时返回 HTTP 503 和 `service_not_configured`；无效请求体返回 HTTP 422。 | [HTTP 应用](../../src/exhibition_guide/main.py) |
| E2 | 检索/模型超时返回 HTTP 504 和稳定错误码；其他上游故障返回安全错误响应，不包含原始异常细节。 | [HTTP 应用](../../src/exhibition_guide/main.py)、[回答错误](../../src/exhibition_guide/answer.py) |
| E3 | 过期、冲突或取消的轮次返回 HTTP 409；访客容量超限返回 HTTP 429。 | [HTTP 应用](../../src/exhibition_guide/main.py) |
| P1 | 公开 UI 配置只暴露数字人 ID 和声音，不暴露服务凭据；响应与错误检查必须发现泄漏的密钥或私有地址。 | [UI 配置契约](../../tests/test_ui_config.py) |
| P2 | 发布的语料、截图、日志或遥测样例不得包含企业专有数据、访客个人数据或凭据。 | [流程](process.md)中的发布审核；持续遥测控制仍为计划。 |

问题和检索资料可能发送给配置的外部 LLM，播报文本可能发送给配置的 TTS 提供方；这不是一个仅离线运行的产品。

生产使用前需要审核提供方及数据政策；本批次不宣称已通过生产隐私认证。

<a id="public-sample-data-requirements"></a>

## 公开样例数据要求

公开 CPU 操作流程在 [sample_data](../../src/exhibition_guide/sample_data/) 提供原创虚构资料，包含创作记录、许可、日期、稳定 ID 和校验值。

无需导入私有资料，CPU 应用自动加载打包内容。

每份样例必须准确区分历史、计划与已建展品，保留来源到事实的映射，避免客户名称（包括个人与企业）、邮箱地址、内部引用内容及受限归档。

包含有依据、有歧义、未知和冲突问题、对应的可观察预期响应，以及至少一个图片失败场景；发布从全新检出开始可用的导入/配置说明。

打包示例覆盖有依据、未知、有歧义和冲突结果；CPU 浏览器流程验证真实应用状态，既有 GPU 浏览器回归覆盖图片降级。

<a id="planned-scope"></a>

## 计划范围

| 批次 | 验收方向 | 状态 |
| --- | --- | --- |
| 2 | 持久化 CPU 样例问答、反馈与隔离历史。 | #12 已实现，见[验证](verification.md)。 |
| 3 | 一条 Compose 启动命令和一条完整验证命令。 | #12 已实现，见[验证](verification.md)。 |
| 4 | 托管 CI、自动本机 dev、人工 prod 与已验证回滚。 | #12 已实现，运行证据见[验证](verification.md)。 |
| 5 | 在 UI 中关联请求日志、指标和追踪；展示用户影响告警及恢复，不包含私有内容。 | 待完成 |
| 6 | 告警唤醒代理，完成诊断、受限修复和恢复验证。 | 后续进阶目标 |

邮件同意、专家审核和真实邮件投递仍在 [#1](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/1)；新增企业内容仍在 [#6](https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition/issues/6)。
