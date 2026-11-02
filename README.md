# dsh-openviking

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 [OpenViking](https://github.com/volcengine/OpenViking) 长期记忆插件。每一轮对话按会话日志里记录的调用者，映射成一个独立的 OpenViking 用户；召回、捕获和记忆工具都只以这个用户的身份访问 OpenViking，不同用户的记忆互不可见。

## 项目状态

测试版：提供召回、捕获、记忆工具和按调用者隔离。接口仍可能调整。

## 安装

```bash
# 在 deepseek-harness 仓库内
pnpm build   # 本地 checkout 需要先构建
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh-openviking
```

包内的 `cordis.patch.yml` 把 `dsh-openviking` 加入 profile 的 bundle 列表，Loader 行的稳定 id 是 `dsh-openviking`，默认服务地址是 `http://openviking:1933`（与 [deploy/](deploy/) 示例一致）。插件需要宿主提供 `tools` 和 `credentials` 服务。

OpenViking 需要以 trusted 模式运行（`server.auth_mode: trusted`）：插件用根密钥（`X-API-Key`）认证自己，再用 `X-OpenViking-Account` 和 `X-OpenViking-User` 声明每个请求代表的用户。根密钥放在 DSH 凭据库里（默认名称 `OPENVIKING_API_KEY`，也可以是同名环境变量），不要写进 cordis.yml。trusted 模式信任持有根密钥的任何调用方，所以 OpenViking 端口只应对 DSH 容器开放。

## 身份

DSH 在每条用户消息的来源里记录调用者：Host 所有者从浏览器发的消息是 `{ kind: 'user', rpcId }`，其他调用者的消息额外带 `principal: { kind, ... }`。插件在每轮对话认领消息时确定这一轮代表谁：

| 认领的消息 | 这一轮代表 |
|---|---|
| `user` 消息，带 `principal` | 该 principal |
| `user` 消息，带 `rpcId`、不带 `principal` | Host 所有者（kind `owner`） |
| `user` 消息，两者都没有（终端、SDK，或不记录调用者的接入方） | 按 `unattributedPrompts`：`skip` 没有身份，`owner` 视为所有者 |
| 其他消息（子代理结果、后台任务、定时任务） | 沿用上一轮的调用者 |

调用者通过 `identities` 模板映射成 OpenViking 用户，例如 `feishu-user: 'feishu-{userId}'` 把 `{ kind: 'feishu-user', userId: 'ou_x' }` 映射成 `feishu-ou_x`。没有模板的 kind、缺字段或结果含非法字符时，这一轮没有身份：不召回、不捕获、不提供记忆工具（失败即关闭）。子代理会话使用根会话当前的调用者。

希望自己在 Web 和其他接入方用同一份记忆时，把 `identities.owner` 设成与另一个接入方相同的用户名，例如 `owner: 'feishu-ou_你的user_id'`。

**接入方要求：** 多用户接入方必须在它代发的每条消息上记录 `principal`。不记录的接入方，其消息按 `unattributedPrompts` 处理；默认 `skip` 时这些对话没有记忆，不会误写进所有者的空间。

## 召回、捕获和工具

**召回**：在接纳用户消息的那一步，用消息文本检索调用者的空间，把命中条目作为一条上下文消息（来源 `{ kind: 'openviking', form: 'recall' }`）追加到这一步，DSH 会像其他模型输入一样写进会话日志。只读取 `user` 消息的文本，其他插件注入的上下文不会成为检索词。超时（`recall.timeoutMs`）或失败时这一步不召回。

**捕获**：把每一轮的用户消息和助手回复写进调用者自己的 OpenViking 会话（每个 DSH 根会话、用户、peer 一个），累计 `capture.commitAfterChars` 字后提交（OpenViking 在提交时提取记忆）；DSH 开始压缩会话时和插件停止时也会提交。同一个 DSH 会话里多个用户轮流发言时，每个人的轮次只进自己的会话。

**工具**：

| 工具 | 作用 | 范围 |
|---|---|---|
| `memory_search` | 语义检索 | 非共享读者只检索自己的空间 |
| `memory_read` | 读取全文 | 非共享读者只能读 `viking://user/<自己>/` |
| `memory_list` | 列目录，默认自己的记忆目录 | 同上 |
| `memory_remember` | 新建一条记忆 | 只写 `viking://user/<自己>/memories/notes/` |
| `memory_forget` | 删除一个记忆文件 | 只删 `viking://user/<自己>/memories/` 下的文件 |

URI 含 `.`、`..`、百分号转义或反斜杠时直接拒绝。工具只在这一轮有身份时提供。

## 保护受限资料

账号下的共享资源（`viking://resources`）只对 `sharedReaders` 中的 kind（默认只有 `owner`）开放：其他调用者的召回和检索只限自己的用户空间，读取共享资源的工具调用会被拒绝。

捕获从不写入工具结果。读取受限资料的工具（例如需要单独授权的知识库工具）应列入 `capture.toolDeny`：这一轮调用过这些工具后，直到这一轮结束都不再捕获助手回复，因为回复可能引用了受限内容。这样受限资料不会经由记忆提取流到没有读权限的地方。

## 配置

```yaml
- id: dsh-openviking
  config:
    endpoint: http://openviking:1933     # 必填
    account: dsh                         # OpenViking 账号，所有 DSH 用户都在这个账号下
    apiKeyRef: OPENVIKING_API_KEY        # 根密钥在 DSH 凭据库中的名称；不是密钥本身
    identities:                          # principal kind → OpenViking 用户名模板
      owner: owner
      feishu-user: 'feishu-{userId}'
    sharedReaders: [owner]               # 可以检索和读取账号共享资源的 kind
    unattributedPrompts: skip            # skip | owner
    # peer:                              # 可选：按会话创建目录再细分到 OpenViking actor peer
    #   cwdPattern: '/chats/(?<peer>[^/]+)$'
    #   prefix: 'chat-'
    subagents: false                     # 子代理会话是否也召回和捕获（工具总是可用）
    recall:
      enabled: true
      limit: 6
      scoreThreshold: 0.3
      minQueryLength: 4
      maxChars: 4000
      timeoutMs: 3000
    capture:
      enabled: true
      assistant: true
      toolDeny: []                       # 例如 ['kb_*']，支持 * 通配
      commitAfterChars: 20000
      maxMessageChars: 8000
      pendingMax: 500
    tools:
      enabled: true
    requestTimeoutMs: 10000
```

配置在加载时校验：缺少 `endpoint`、`apiKeyRef` 看起来像密钥本身、身份模板含非法字符、`peer.cwdPattern` 没有 `(?<peer>...)` 分组时，插件加载失败。

## 已知限制

- 调用者记录在内存里：DSH 重启后，一个会话在下一条用户消息被认领之前没有身份。
- 捕获的重试队列在内存里：OpenViking 不可达时，失败的写入最多保留 `capture.pendingMax` 条、每分钟重试一次，重启后丢失。
- 每个会话的 OpenViking 会话 id 是 `dsh-<会话 id>-<用户>[-<peer>]`。

## 部署

[deploy/](deploy/) 里有内网 Docker 示例：`docker-compose.yml` 只在内部网络暴露 1933 端口，`ov.conf.example` 打开 trusted 模式，并为内网 Embedding、VLM 和 rerank 服务留了占位地址（OpenAI 兼容接口）。

## 开发

```bash
pnpm install
pnpm check   # typecheck + test + build + 产物加载检查
```

插件只用 `fetch` 调用 OpenViking HTTP API，不依赖 OpenViking SDK。
