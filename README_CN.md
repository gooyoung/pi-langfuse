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
```

所有隐私预设默认都关闭源码元数据；只有显式设置 `LANGFUSE_CAPTURE_SOURCE_METADATA=true` 才会启用。

所有被采集的负载在上传前仍会脱敏。扩展会隐藏常见 API key、Bearer token、密码、Cookie、私钥、Langfuse key、GitHub/npm/AWS 风格 token，并对本地绝对路径做 hash。

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
