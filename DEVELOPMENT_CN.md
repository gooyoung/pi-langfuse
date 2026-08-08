# 开发文档

[**English**](./DEVELOPMENT.md) | [**简体中文**](./DEVELOPMENT_CN.md)

本文档面向贡献者和维护者。安装插件并在 Pi 中使用时，优先阅读 [README_CN.md](./README_CN.md)。

## 本地开发环境

克隆仓库并安装依赖：

```bash
git clone <你的仓库地址>
cd pi-langfuse
npm install
```

本仓库仅支持 npm。请保留 `package-lock.json` 作为唯一依赖锁文件，不要提交其他包管理器生成的 lockfile。

开发阶段可将本地源码链接到 Pi：

```bash
pi link /path/to/pi-langfuse
```

如果直接在当前仓库目录运行 Pi，Pi 也可以通过本地 `package.json` 自动发现该扩展。

## 开发流程

推荐的本地检查命令：

```bash
npm run typecheck
npm test
```

基础手动验证：

```bash
pi "test prompt"
```

随后在 Langfuse 中确认：

1. 每个提示词都会创建一个 trace。
2. 根 `agent` 观察节点包含提示词输入和最终输出。
3. `generation` 与 `tool` 观察节点的父子关系正确。
4. 工具失败时会标记为 `ERROR`。
5. trace 级别分数已附加到本次运行。

## 从源码安装

如果不是通过 npm 包测试，而是直接使用本地源码，可执行：

```bash
pi link /path/to/pi-langfuse
```

## 项目结构

```text
pi-langfuse/
├── index.ts                     # 扩展入口与事件注册
├── src/
│   ├── handlers/
│   │   ├── agent.ts            # 根 agent 观察节点与 trace I/O
│   │   ├── generation.ts       # 提供商请求与 generation 生命周期
│   │   ├── tool.ts             # 工具观察节点生命周期与工具分数
│   │   └── turn.ts             # turn span，用于挂载 generation 和 tool
│   ├── capture-policy.ts       # 隐私采集开关与预设
│   ├── config.ts               # 配置加载、首次设置与持久化
│   ├── constants.ts            # 负载上限与截断阈值
│   ├── langfuse.ts             # Langfuse 运行时、flush 与 REST 兜底
│   ├── redaction.ts            # 密钥脱敏与路径掩码
│   ├── state.ts                # 按会话隔离的运行时状态
│   ├── types.ts                # 共享类型定义
│   └── utils.ts                # 负载整形与提取工具
├── test/                       # state、config、capture 与 payload shaping 测试
├── types/                      # Pi 与运行时依赖的类型 shim
├── .agents/skills/langfuse/    # 本地 Langfuse 技能文档与参考资料
├── AGENTS.md                   # 面向代理协作的维护说明
├── DEPLOY.md                   # 发布与部署说明
├── README.md                   # 英文用户文档
└── README_CN.md                # 中文用户文档
```

## 运行时架构

扩展会将一次 Pi 运行映射为一棵 Langfuse trace 树：

- 一个用户提示词对应一个 `pi-agent` trace。
- 根 `agent` 观察节点与 trace 的输入、输出保持同步。
- 每次提供商请求对应一个 `generation` 观察节点。
- 每次工具调用对应一个 `tool` 观察节点。
- 每个助手 turn 可选创建一个 `span`，用于挂载该轮中的 generation 和 tool。

运行时状态按会话隔离。实现基于 `AsyncLocalStorage`，用于避免并发 Pi 会话之间串用活动观察节点、计数器和首次设置状态。

## 事件流程

主要生命周期如下：

1. `session_start`：加载配置并重置会话状态。
2. `before_agent_start` / `agent_start`：创建根 agent 观察节点。
3. `turn_start`：打开 turn span。
4. `before_provider_request`：开始记录 generation。
5. `after_provider_response`：补充提供商元数据和早期错误状态。
6. `message_update`：记录首字节时间和最新助手输出。
7. `message_end`：结束当前 generation。
8. `tool_execution_start` / `tool_call`：开始记录工具观察节点。
9. `tool_result` / `tool_execution_end`：结束匹配的工具观察节点。
10. `turn_end`：结束 turn；如果常规 generation 事件缺失，则补一个兜底 generation。
11. `agent_end`：结束根观察节点、同步 trace I/O，并发送分数。
12. `session_shutdown`：结束悬空观察节点并 flush 待发送遥测数据。

## 追踪模型

```text
Trace (name: "pi-agent")
├── Session ID: <pi-session-id>
├── input:  用户提示词，存在时包含图片或上下文摘要
├── output: 最终助手响应
└── Agent observation (name: "pi-agent", type: agent)
    ├── input:  当前用户提示词
    ├── output: 最终助手响应
    ├── Generation observation (name: "llm-generation", type: generation)
    │   ├── input: 提供商请求负载或消息历史
    │   ├── output: 已定型的助手消息或工具调用消息
    │   ├── model, usageDetails, costDetails
    │   └── metadata: 提供商或请求细节
    └── Tool observation (name: "<tool-name>", type: tool)
        ├── input: 工具参数
        ├── output: 工具结果
        └── metadata: toolCallId, isError
```

## 追踪字段

### Trace 级别

| 字段 | 说明 |
|------|------|
| `input` | 用户提示词；可用时包含图片或上下文摘要 |
| `output` | Pi 中实际显示的最终助手响应 |
| `sessionId` | Pi 会话标识符 |
| `metadata.model` | 可用时的模型标识符 |
| `metadata.provider` | LLM 提供商名称 |
| `metadata.cwd` | 工作目录，受隐私设置控制 |

### Agent 观察节点

| 字段 | 说明 |
|------|------|
| `type` | `agent` |
| `name` | `pi-agent` |
| `input` | 当前用户提示词负载 |
| `output` | 最终助手响应 |
| `metadata.sessionId` | Pi 会话标识符 |
| `metadata.cwd` | 工作目录 |
| `metadata.model` | 可用时的所选模型 |
| `metadata.provider` | 可用时的提供商 |

### Trace 级别分数

| 分数名称 | 类型 | 说明 |
|----------|------|------|
| `tool_call_count` | number | 本次运行中的工具调用总数 |
| `turn_count` | number | 助手交互轮数 |
| `total_tool_errors` | number | 返回错误的工具数 |
| `tool_success_rate` | float (0-1) | 工具调用成功率 |
| `session_had_errors` | 0 或 1 | 是否出现任何工具错误 |

### Generation 观察节点

| 字段 | 说明 |
|------|------|
| `type` | `generation` |
| `name` | `llm-generation` |
| `input` | 实际提供商请求负载或消息历史 |
| `output` | 已定型的助手消息；在工具调用轮次中包含工具调用负载 |
| `model` | 模型标识符 |
| `usageDetails.input` | 输入 Token 数 |
| `usageDetails.output` | 输出 Token 数 |
| `usageDetails.total` | 总 Token 数 |
| `costDetails.total` | 总成本，单位为 USD |
| `costDetails.input` | 输入成本，单位为 USD |
| `costDetails.output` | 输出成本，单位为 USD |
| `metadata.provider` | 提供商名称 |
| `metadata.requestId` | 可用时的提供商或 Pi 请求标识符 |
| `metadata.status` | 可用时的 HTTP 或提供商状态 |

### Tool 观察节点

| 字段 | 说明 |
|------|------|
| `type` | `tool` |
| `name` | 工具名称，例如 `bash` 或 `read` |
| `input` | 工具参数 |
| `output` | 经整形与截断后的工具结果 |
| `metadata.toolCallId` | 稳定的 Pi 工具调用标识符 |
| `metadata.isError` | 工具是否失败 |
| `metadata.durationMs` | 近似工具执行时长，单位为毫秒 |
| `metadata.inputBytes` | 整形后工具输入负载的 UTF-8 字节数 |
| `metadata.outputBytes` | 整形后工具输出负载的 UTF-8 字节数 |
| `level` | 失败的工具调用为 `ERROR`，否则为 `DEFAULT` |

### 观察节点级别分数

| 分数名称 | 说明 |
|----------|------|
| `tool_is_error` | 出错工具观察节点的分数值，固定为 `1` |

## 验证说明

仓库当前没有完整的端到端测试套件，验证方式以聚焦测试和手动检查为主。

建议在较大改动后执行：

```bash
npm run typecheck
npm test
```

如果改动涉及集成行为，还需要启用扩展运行 Pi，并额外确认：

- Langfuse 中可以看到 trace
- 根 trace 的输入和输出已正确填充
- generation 与 tool 的父子关系正确
- 分数被写入正确的 trace 或 observation
- 关机和中断场景仍会 flush 遥测数据

## 依赖

- [@langfuse/tracing](https://www.npmjs.com/package/@langfuse/tracing)：`agent`、`generation` 和 `tool` 的观察 API
- [@langfuse/otel](https://www.npmjs.com/package/@langfuse/otel)：OpenTelemetry 导出路径
- [@langfuse/client](https://www.npmjs.com/package/@langfuse/client)：用于写入分数的 Langfuse API 客户端
- [@opentelemetry/sdk-node](https://www.npmjs.com/package/@opentelemetry/sdk-node)：Node OpenTelemetry 运行时
- [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)：Pi 扩展 API 对等依赖

## 相关文档

- [README.md](./README.md)：英文用户文档
- [README_CN.md](./README_CN.md)：中文用户文档
- [AGENTS.md](./AGENTS.md)：代码修改时的维护说明
- [DEPLOY.md](./DEPLOY.md)：发布流程
