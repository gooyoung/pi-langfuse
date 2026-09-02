# pi-langfuse

[![npm version](https://img.shields.io/npm/v/pi-langfuse)](https://www.npmjs.com/package/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**English**](./README.md) | [**简体中文**](./README_CN.md)

[Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 的 Langfuse 可观测性扩展。它会将完整的 Pi 运行发送到 [Langfuse](https://langfuse.com)，在一个 trace 中展示提示词、代理工作流、LLM 生成、工具调用、最终回复、用量、成本和健康分数。

## 这个插件提供什么

- 每个用户提示词对应一个 Langfuse trace，并按 Pi 会话分组。
- 为根代理创建 `agent` 观察节点，为每次模型请求创建 `generation`，为每次工具调用创建 `tool`。
- 记录最终助手输出、工具错误状态和追踪级别分数。
- 提供输入、输出、工具 I/O、system prompt 和 cwd 的隐私采集开关。
- 上传前脱敏常见密钥，并对本地绝对路径做 hash。
- 对仍提供旧版 trace API 的自托管 Langfuse 启用能力检测后的 REST 兜底，覆盖 OTel span 已到达但 trace 未可见的场景；Langfuse v4 `events_only` 部署仅使用 OTel，不执行旧版 REST 兜底写入。

## 前提条件

- **Node.js** >= 22
- **Pi Coding Agent** 已安装并完成基础配置
- **Langfuse** 账户，支持 [云服务](https://cloud.langfuse.com) 和自托管

## 快速开始

1. 安装扩展：

   ```bash
   pi install npm:pi-langfuse
   ```

2. 首次运行 Pi 时，如果尚未配置凭据，Pi 会提示输入：
   - Langfuse 公钥，以 `pk-lf-...` 开头
   - Langfuse 密钥，以 `sk-lf-...` 开头
   - Langfuse 主机地址，默认 `https://cloud.langfuse.com`

3. 正常运行 Pi：

   ```bash
   pi "解释 Redis 的架构"
   ```

4. 打开 Langfuse，查看新生成的 trace。

## 配置

Langfuse API 密钥可在 **Langfuse Cloud** -> **Settings** -> **API Keys** 中获取。

### 方式 1：交互式设置

加载扩展后运行任意 `pi` 命令。首次运行且未配置时，Pi 会在 CLI 或 TUI 中提示输入，并将结果保存到 `~/.pi/agent/pi-langfuse/config.json`。

如需重新执行设置：

```text
/langfuse-setup
```

如需查看当前配置状态且不泄漏密钥：

```text
/langfuse-status
```

状态命令会显示配置来源、主机地址、脱敏后的公钥、采集策略、是否有活跃运行、配置文件路径，以及最近一次运行时错误。

### 方式 2：环境变量

在启动 Pi 前设置：

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-xxxx"
export LANGFUSE_SECRET_KEY="sk-lf-xxxx"
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # 可选；也支持 LANGFUSE_HOST
```

保存的配置优先级更高。只有当 `~/.pi/agent/pi-langfuse/config.json` 缺失或不完整时，扩展才会使用环境变量。

对于短生命周期的 SDK 宿主，可设置关闭时最终分数发送尝试的上限：

```bash
export PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT=2  # 单位为秒；默认 2 秒
```

扩展会在其他关闭遥测工作之前尝试发送已排队的 trace 级分数。该值不会延长总关闭超时。

隐私采集策略也可以通过环境变量设置：

```bash
export LANGFUSE_PRIVACY_PRESET="full-debug"
```

可用预设：

| 预设 | 采集内容 |
|------|----------|
| `metadata-only` | 仅采集元数据；不采集输入、输出、工具 I/O、system prompt 和 cwd |
| `prompts-only` | 采集提示词或提供商输入，以及元数据 |
| `conversations` | 采集输入和助手输出，但不采集工具 I/O、system prompt 和 cwd |
| `full-debug` | 完整追踪细节；默认值 |

细粒度开关会覆盖预设：

```bash
export LANGFUSE_CAPTURE_INPUTS=true
export LANGFUSE_CAPTURE_OUTPUTS=true
export LANGFUSE_CAPTURE_TOOL_IO=false
export LANGFUSE_CAPTURE_SYSTEM_PROMPT=false
export LANGFUSE_CAPTURE_CWD=false
export LANGFUSE_CAPTURE_SOURCE_METADATA=false
export LANGFUSE_CAPTURE_PATHS=false
```

所有隐私预设默认都关闭源码元数据；只有显式设置 `LANGFUSE_CAPTURE_SOURCE_METADATA=true` 才会启用。
绝对路径与 `LANGFUSE_CAPTURE_PATHS` 同理。

所有被采集的负载在上传前仍会脱敏。扩展会隐藏常见 API key、Bearer token、密码、Cookie、私钥、Langfuse key、GitHub/npm/AWS 风格 token，并对本地绝对路径做 hash。

### 绝对路径

默认情况下，本地绝对路径（`/Users/...`、`/home/...`、`/tmp/...`、`C:\Users\...`）会在所有位置被替换为
稳定的 `[PATH_HASH:<12 位十六进制>]` 摘要，因此用户名和仓库名不会进入 Langfuse。该规则作用于输入、输出、
工具 I/O、工具错误信息以及 `cwd` 元数据字段。若希望在 trace 中看到真实路径，需要显式开启：

```bash
export LANGFUSE_CAPTURE_PATHS=true
```

也可以持久化到 `config.json`：

```json
{ "capture": { "LANGFUSE_CAPTURE_PATHS": "true" } }
```

与 `LANGFUSE_CAPTURE_SOURCE_METADATA` 一样，它在所有隐私预设中默认关闭，且只影响路径；密钥脱敏（token、key、
Cookie、密码）始终生效。注意 `LANGFUSE_CAPTURE_CWD=false` 是另一个控制项——它会直接丢弃 `cwd` 元数据字段，
而不是改变路径的呈现方式。

`/langfuse-status` 会在 `Capture: absolute paths` 下显示当前设置。

### 负载上限

上传前会对负载做整形：字符串会被截断，过深或过宽的结构会被裁剪。这些上限让 trace 保持精简，同时保护
Langfuse 摄取管线。任何一项都可以覆盖（无需重新构建）：

```bash
export PI_LANGFUSE_MAX_STRING_LENGTH=12000       # 单字符串字符数（system prompt、输入）
export PI_LANGFUSE_MAX_TOOL_PAYLOAD_LENGTH=24000 # 工具输入/输出字符数
export PI_LANGFUSE_MAX_DEPTH=6                    # 最大嵌套深度
export PI_LANGFUSE_MAX_ARRAY_ITEMS=50            # 数组保留的最大元素数
export PI_LANGFUSE_MAX_OBJECT_KEYS=80            # 对象保留的最大键数
export PI_LANGFUSE_MAX_PAYLOAD_NODES=2000        # 单个负载的最大总节点数
```

任意上限设置为 `0`、`off`、`none` 或 `unlimited` 即表示关闭该限制（采集完整值）；未设置或非法值回退到上方默认值。
若想完整采集很大的 system prompt 或工具负载，可以调高或关闭相关限制（例如 `PI_LANGFUSE_MAX_STRING_LENGTH=off`）。

REST 回退摄取会按字节切分，保证每个请求体都远低于 Langfuse 网关的负载限制（约 4.5MB）。以下变量控制切分预算
与整个回退负载的硬上限：

```bash
export PI_LANGFUSE_MAX_INGESTION_BATCH_BYTES=4194304  # 单次请求体预算，默认 4MB

export PI_LANGFUSE_MAX_FALLBACK_TOTAL_BYTES=33554432  # 整体负载上限，默认 32MB
```

当累积的回退负载超过 32MB 上限时，会跳过摄取并给出告警，而不是尝试一次注定失败的超大上传。

### 推理（reasoning）token

Pi 会为 Anthropic、OpenAI Codex、OpenRouter、opencode-go 和 Qwen 上报推理（thinking）token。提供商将其计入
`output`，扩展默认也原样上报整个 `output`，因此在 Langfuse 中看不到推理部分的占比。可显式开启，将其作为独立用量桶上报：

```bash
export PI_LANGFUSE_SPLIT_REASONING_TOKENS=true
```

也可以持久化到 `config.json`：

```json
{ "capture": { "PI_LANGFUSE_SPLIT_REASONING_TOKENS": "true" } }
```

开启后，一次消耗 37 个输出 token（其中 10 个为推理）的生成会上报为 `output: 27` 加
`output_reasoning_tokens: 10`。两个键都包含 `output`，所以 Langfuse 的 Output 行仍显示 37，只是其下的明细多出推理占比。
推理数会被限制在上报的 `output` 范围内，因此各桶之和始终等于总量。

> **开启前请先检查模型价格。** Langfuse 按键名精确匹配用量与价格，且你在项目中自定义的模型定义优先于 Langfuse 维护的
> 默认值。若自定义模型只定义了 `input` 和 `output` 价格，`output_reasoning_tokens` 会按零计价，推理密集的生成会显得比实际便宜。
> 请先在 **Settings → Models** 中为每个自定义推理模型补上 `output_reasoning_tokens` 的价格，再开启拆分。Langfuse 内置的
> 推理模型价格已包含该键。自行上报成本的提供商不受影响：Langfuse 会直接使用上报的成本，不会再根据用量重新计算。

该拆分默认关闭，升级后在你显式开启之前不会有任何变化。取消设置 `PI_LANGFUSE_SPLIT_REASONING_TOKENS`（或设为 `false`）即可回退；
已摄取的 trace 保留其原有用量桶。

### 方式 3：持久化 `config.json`

创建或更新 `~/.pi/agent/pi-langfuse/config.json`：

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com",
  "privacyPreset": "conversations"
}
```

也可以持久化细粒度采集开关：

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com",
  "capture": {
    "LANGFUSE_PRIVACY_PRESET": "metadata-only",
    "LANGFUSE_CAPTURE_INPUTS": "true"
  }
}
```

> **安全提醒**：`~/.pi/agent/pi-langfuse/config.json` 包含敏感信息，不应提交到版本控制。
> 扩展自行写入该文件时，会在支持 POSIX 权限的文件系统上使用 `0700` 创建配置目录，并使用 `0600` 写入配置文件。

## 验证扩展是否已加载

执行：

```bash
pi list
```

已安装包列表中应出现 `pi-langfuse`。

如需在 Pi 内验证 Langfuse 主机地址和 API key：

```text
/langfuse-test
```

该命令会先发起一次带超时的认证请求；认证通过后，再发送一条小的测试 trace。

## 在 Langfuse 中会看到什么

- 每个 Pi 会话对应一个独立的 Langfuse session ID。
- 该会话中的每个用户提示词都会生成一个独立 trace。
- trace 中会包含 Pi 实际显示的最终助手回复。
- 工具执行会以工具观察节点展示参数、结果和错误状态。
- 模型请求会以生成观察节点展示；如果提供商暴露相关信息，还会包含用量和成本。
  开启 `PI_LANGFUSE_SPLIT_REASONING_TOKENS` 后，推理 token 会作为独立用量桶上报。
- trace 级别会记录工具调用次数、工具成功率和是否出现错误。

此包还包含一个内置 Langfuse 技能，可直接在 Pi 中查询 Langfuse 数据：

```text
/pi-langfuse-langfuse <查询内容>
```

## 源码元数据

仓库源码采集独立于隐私预设，默认关闭。只有在确认提交标识适合写入当前 Langfuse 项目后才启用：

```bash
export LANGFUSE_CAPTURE_SOURCE_METADATA=true
```

对于 Git 工作树，扩展只记录修订状态：

```json
{
  "source_type": "git-repo",
  "vcs.ref.head.revision": "0123456789abcdef...",
  "git_detached": "false",
  "git_dirty": "false",
  "metadata_source": "git-detection"
}
```

修订值为完整的 `HEAD` 提交。dirty 状态包含已跟踪变更和未跟踪文件，但绝不包含路径或内容。detached 状态不会附带分支名或标签名。此采集器不会检查或上传 Git remote、URL、凭据、用户名、分支、绝对路径或仓库名。

关闭采集时，扩展不会调用 Git，并报告 `source_type: "disabled"`。非 Git 目录报告 `non-git`；Git 不可用或仓库状态不完整时报告 `unavailable`。

部署标识和显式覆盖应使用 Langfuse 与 OpenTelemetry 原生配置，而不是仓库文件：

```bash
export LANGFUSE_RELEASE="1.2.3"
export LANGFUSE_TRACING_ENVIRONMENT="production"
export OTEL_SERVICE_NAME="pi-agent"
export OTEL_RESOURCE_ATTRIBUTES="service.version=1.2.3,vcs.repository.name=public-repo"
```

`LANGFUSE_RELEASE` 与 `LANGFUSE_TRACING_ENVIRONMENT` 保持 Langfuse 原生语义。`OTEL_SERVICE_NAME` 和 `OTEL_RESOURCE_ATTRIBUTES` 会作为进程级 OpenTelemetry resource attributes 加载；`vcs.repository.name` 等值会应用到共享同一 runtime 的所有会话，可能暴露私有源码身份，而且修改后需要重启 runtime。

### 兼容与回滚

旧版本默认发送 `git_commit`、分支、remote、owner、仓库名及 `.pi-langfuse.metadata.json` 中的值。新 trace 改用 `vcs.ref.head.revision`，并停止读取该文件。启用源码采集前应更新 dashboard；历史 trace 不受影响。

取消设置 `LANGFUSE_CAPTURE_SOURCE_METADATA` 可立即停止采集。迁移期间只有在必须保留旧 schema 时才固定到 `pi-langfuse@1.5.12`；这样也会恢复旧版本更宽泛的默认源码披露。

## 故障排除

### 没有看到 trace

- 先检查 API 密钥是否正确，必要时重新执行 `/langfuse-setup`。
- 执行 `/langfuse-status`，确认当前加载的主机、配置来源、隐私模式和最近一次运行时错误。
- 确认 Langfuse 项目处于可写状态。
- 确认密钥具备写权限。
- 在 Pi 输出中查找 `📊 Langfuse:` 日志。

### 扩展未加载

```bash
pi list
pi install npm:pi-langfuse
```

### 启动时显示 `Missing config`

- 执行 `/langfuse-setup`。
- 或在启动 Pi 前设置 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY`。

### 模型或成本未显示

- 并非所有提供商都会返回成本信息。
- 可在 Langfuse trace 中查看原始观察数据。
- `model` 字段可能来自提供商事件、已定型的助手消息、`model_select` 或 `ctx.model`。

### API 密钥错误

- 公钥以 `pk-lf-` 开头。
- 密钥以 `sk-lf-` 开头。
- 使用自托管时，还需要确认主机地址是否正确。

## 开发文档

源码安装、开发流程、运行时架构、追踪模型、字段明细和验证步骤已迁移到 [DEVELOPMENT.md](./DEVELOPMENT.md) 与 [DEVELOPMENT_CN.md](./DEVELOPMENT_CN.md)。

## 许可证

MIT
