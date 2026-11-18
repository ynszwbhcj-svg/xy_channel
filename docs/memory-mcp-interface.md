# XY Channel 记忆管理 MCP 接入

架构、模块及完整业务流程见[方案设计](memory-mcp-design.md)。

本适配将小艺 Work 客户端的 `AgentEvent.MemoryQuery` 转为同一沙箱中的 GaussPD MCP HTTP 请求。OpenClaw、Taichu 与 XY 共用既有 MCP 进程和 Core；XY 不启动第二个 Core，不读取数据库，不接受客户端指定账号或数据目录。

## 部署与模块

运行要求保持仓库现有的 OpenClaw `>=2026.6.6` 和 Node 环境要求。先启动 `integration-celiaworks_cloud/mcp`，再启动频道进程。频道配置增加：

```json
{
  "channels": {
    "xiaoyi-channel": {
      "memory": { "backend": "mcp-http" }
    }
  }
}
```

上例只展示新增字段，原来的 `apiKey/agentId/uid/apiId/pushId` 等必填配置仍需保留。环境变量必须传入 **XY 频道所在进程**：

```sh
export CELIA_MEMORY_HTTP_URL=http://127.0.0.1:8675/mcp
export CELIA_MEMORY_HTTP_TOKEN_FILE=/absolute/private/path/mcp-http.token
```

token 文件使用部署端生成的 MCP token，64 位十六进制文本，可带结尾换行，文件权限仅限所有者（例如 `0600`），不能是符号链接。token 与 MCP 进程的启动凭据一致，账号由 MCP 启动配置绑定；客户端参数不传 token、UID 或路径。环境变量中的 URL 仅接受 HTTP `127.0.0.1` 的 `/mcp`，不接受远程地址、URL 用户名密码或查询参数。

未配置 `memory` 时维持原有文件模式。明确启用 MCP 后，HTTP 失败会返回错误，不退回读取旧的 USER.md/MEMORY.md 或写 `.xiaoyiruntime`。

| 模块 | 职责 |
| --- | --- |
| `src/memory/config.ts` | 显式启用及环境配置校验 |
| `src/memory/mcp-http-client.ts` | 私有 token 文件读取、初始化探测、直连 HTTP、大小及超时限制 |
| `src/memory/service.ts` | action 映射、参数校验、业务结果解释、短期重复写请求合并 |
| `src/memory/view.ts` | 会话内展示快照与分页 |
| `src/memory/command.ts` | 展示字段保真、记忆日志摘要 |
| `src/memory-query-handler.ts` | 既有事件入口、MCP/旧文件模式分发、A2A 回包 |

## 通信协议

外部客户端继续使用既有 A2A WebSocket `AgentEvent.MemoryQuery`，直接 A2A 请求和 `msgDetail` 包装格式都支持。事件位于 `params.message.parts[].data.events[]`：

```json
{
  "header": { "namespace": "AgentEvent", "name": "MemoryQuery" },
  "payload": {
    "action": "MemoryProfileModify",
    "params": { "instruction": "以后记住我不吃香菜", "requestId": "edit-20261118-001" }
  }
}
```

业务参数放在 `payload.params`；兼容唯一的 `params.body` 包装。两种形式不可混用，未声明字段会被拒绝。sessionId、taskId、messageId 从既有 A2A 信封取得，编辑的 sessionId 必须有效。响应保持相同 sessionId/taskId/messageId，通过原 `sendCommand` 回传 `payload: {action, ans}`，`final: true`。

XY 内部使用 `POST /mcp`，`Authorization: Bearer <token>`、`Content-Type: application/json`，JSON-RPC 2.0。首次业务调用之前执行 `initialize`（协议 `2025-03-26`）和只读 `memory.profile.settings.get` 探测。探测遇到重置中的 Busy 仍允许独立查询重置状态。管理方法直接作为 JSON-RPC `method`，不包装成模型 `tools/call`。

```json
{
  "jsonrpc": "2.0",
  "id": "transport-uuid",
  "request_id": "edit-20261118-001",
  "method": "memory.profile.modify",
  "params": { "instruction": "以后记住我不吃香菜", "session_id": "existing-a2a-session" }
}
```

`id` 是单次传输 ID；顶层 `request_id` 是业务关联 ID。响应为 `result: {status, result}`，XY 将原生状态保留为 `ans.nativeStatus`，业务结果保留在 `ans.result`。接口使用当前 C MCP 实现，不要求更换 HTTP 协议或端口。

## action 与参数

| action | `params` | MCP 方法 | 主要 `ans` 字段 |
| --- | --- | --- | --- |
| `MemoryStateGet` | 可选 `requestId` | `memory.profile.settings.get` | `memoryState` 布尔值 |
| `MemoryStateSet` | `memoryState` 布尔值，可选 `requestId` | `memory.profile.settings.set`，映射为 `enabled` | `memoryState`；成功要求值匹配且 `applied/persisted` 均为 true |
| `UserMdQuery` | 可选 `requestId/snapshotId/offset` | `memory.profile.get` | 用户画像 `fileDetail` 及分页字段 |
| `MemoryMdQuery` | 同上，可选 `section` | `memory.profile.get` | 默认 `memoryMd`；`section: "cloudGlobalSummary"` 展示融合摘要 |
| `MemoryProfileModify`（新增） | `instruction`，可选 `requestId` | `memory.profile.modify` | 指令更新结果、十进制字符串 `atomIds`、写入及触发阶段结果 |
| `MemoryReset`（新增） | 可选 `requestId/dryRun`，dryRun 默认 false | `memory.profile.reset` | 当前启动绑定账号的 Core 清理结果及各类行数 |
| `MemoryResetStatus`（新增） | 必填原重置的 `requestId` | `memory.profile.reset.status` | `state`、最终 `response` 和解释后的重置结果 |

编辑是自然语言指令更新，上限 8192 UTF-8 字节；不是把页面 Markdown 整份覆盖到 Core。编辑必须同时确认写入、触发完成，才返回成功。记忆关闭时编辑会明确 `skipped`；展示返回空内容并标识 `skipped`，不代表数据已删除。

开关、编辑、重置应由客户端提供稳定的 `requestId`（1–255 UTF-8 字节，无控制字符），尤其重置需要用它查询状态。未提供时 XY 由可信 A2A 账号/会话/action/messageId 生成并在回包返回；没有 requestId 或 messageId 的写请求会被拒绝。重置预览与正式执行必须使用不同 requestId。

## 成功、异常与重置恢复

客户端必须先检查 `ans.ok`，并使用 `outcome` 区分以下情况，不能仅凭 HTTP 200、nativeStatus=0 或 Core state=succeeded 显示全部完成。

| outcome | 客户端含义 |
| --- | --- |
| `succeeded` | 本次操作所需阶段均完成 |
| `preview` | 重置预览，不执行清理 |
| `running` | 重置仍在执行，继续用原 requestId 查询 |
| `sync_required` | Core 已清理，但 `cloudSummaryResetRequired=true`，融合摘要仍需后续同步；`ok=false` |
| `skipped` | 记忆关闭，未执行编辑；展示可为 `ok=true` 的空视图 |
| `busy` | MCP 或本地写请求容量繁忙 |
| `partial` | 已产生部分写入或清理，保留阶段及计数字段供客户端说明 |
| `unknown` | 写请求可能已执行、回执不完整或重置状态记录不可用；不应自动重发写操作 |
| `rejected/configuration/unavailable/recovery_required/failed` | 依据 `errorCode` 显示校验、配置、探测、恢复或业务失败状态 |

重置返回 `unknown` 后，用原 ID 发送 `MemoryResetStatus`。`not_found/unknown` 表示服务没有可确认的最终状态，不能理解为“从未执行”。MCP 的状态记录是进程内最近 16 条观测，服务重启后不保留。`response` 是 Core 执行结果，`state: succeeded` 仍可能对应融合摘要待同步，XY 此时保持 `sync_required`。

XY 对写请求不进行 HTTP 自动重试、不跟随重定向。相同配置、同一频道进程中，同一 requestId、同一会话和同一内容的写请求合并，完成后缓存 5 分钟，最多保留 64 条；同 ID 不同内容返回 `REQUEST_ID_CONFLICT`，缓存满时返回 Busy。它不是持久化幂等机制，进程重启、配置切换或缓存过期后不保证防重放。

HTTP 默认连接超时 3 秒、探测 5 秒、业务 30 秒。HTTP 请求上限 64 KiB、响应上限 512 KiB；C 业务桥接内部仍有自己的 64 KiB 限制，XY 不绕过服务端限制，也不静默截断原始内容。

## 展示分页

`fileDetail` 保留画像原文。每页含 `snapshotId/section/total/offset/limit/hasMore/nextOffset/contentBytes`。偏移量按 JavaScript UTF-16 字符位置计算，分页不拆分 emoji 的代理对；`contentBytes` 是当前页 UTF-8 字节数。

首请求不传 snapshotId（offset 必须为 0）；后续请求使用原 snapshotId 和上一页 nextOffset。同一个快照可通过另一展示 action 或 section 读取用户画像、本地记忆和融合摘要，从而避免三次读取得到不同版本。

快照绑定当前 A2A 会话，存活 30 秒，最多 16 份、总文本 4 MiB。发生写操作时失效；过期或淘汰返回 `SNAPSHOT_EXPIRED`，客户端应重新从首页读取，不能把新旧页拼接。按 `ans` 双层 JSON 转义后的 60000 字节预算分页，为既有 WebSocket 信封保留空间。

`cloudSummaryAvailable/cloudSummaryFile` 提供融合摘要可用性；空文本本身不能用于判断关闭记忆或清空成功。`fileDetail` 展示字段在既有敏感信息过滤层保真，其他字符串仍按原规则过滤。输入指令和所有 MemoryQuery 回包不记录正文，日志仅保留 action、状态及长度等元数据。

## 本次边界与验证

`MemoryFileRead/MemoryFileWrite` 继续用于原来的受限 Markdown 文件同步，不写入 Core 数据目录，不替代画像编辑；MCP 模式下 `MemoryHistory` 明确返回 `MEMORY_HISTORY_UNSUPPORTED`。本次未扩展 Taichu 模型工具，也未实现客户端页面按钮或融合云端服务的额外重置接口。

标准测试为 `npm test`；新增 MCP 服务契约测试位于 `tests/memory-mcp.test.ts`，A2A 处理及日志测试在相关 handler/WebSocket/formatter/outbound 测试中。可使用测试 Core 编译的真实 C MCP 可执行文件，启用额外联调：

```sh
XY_MEMORY_CONTRACT_SERVER=/absolute/path/to/test-build/mcp/gspd_memory_mcp_server npm test -- tests/memory-mcp.test.ts
```

该联调验证真实 HTTP 服务、MCP 业务契约和 XY 映射，测试 Core 不等同于生产 GaussPD 模型的记忆生成效果。

2026-11-18 本机验证：OpenClaw `2026.6.6 (8c802aa)`、TypeScript 5.9.3、Vitest 2.1.9；`npm run build` 成功，启用上述真实 C MCP 联调后全量测试 41 个文件、379 项全部通过，其中 MCP 契约 18 项。新增记忆模块另通过 strict 类型检查。
