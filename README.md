# dsh-token-gate

DeepSeek Harness 的轻量浏览器访问门。它让 DSH Web 保持在 loopback，只通过独立 gateway 端口对外提供一次 token bootstrap、持久浏览器 session，以及透明的 HTTP/WebSocket 转发。

> 当前 `main` 已实现 token bootstrap、进程内 session 与代理边界；`spec/` 已将目标行为修正为 **session 在 cookie 到期前应跨 DSH/token-gate 重启继续有效**。持久 session 仍需后续实现对齐。

## 目标模型

```text
browser / optional local reverse proxy
              │
              ▼
┌─ dsh-token-gate ───────────────────────────────┐
│ /?token=<secret>          → durable session    │
│ valid browser session     → allow HTTP / WS    │
│ everything else           → opaque deny        │
└───────────────────┬────────────────────────────┘
                    ▼
              127.0.0.1:<DSH>
```

核心约束：

- DSH Web 必须保持监听 `127.0.0.1`；gateway 是浏览器访问边界。
- 首次根路径 `/?token=...` 成功后返回 `303`，写入 HttpOnly session，并从 URL 中移除 gateway token。
- session 的目标生命周期与 cookie 过期时间一致：只要 session 未到期，DSH/token-gate 进程重启不应要求重新 bootstrap。
- 持久 session 使用 DSH/Cordis 已有的 storage-domain 能力；token-gate 不自建独立数据库服务。
- HTTP 与 WebSocket 共享同一授权边界，授权后尽可能透明地使用原有 DSH Web。
- gateway session cookie 不会透传给 DSH，DSH 也不能覆盖 gateway 自己的 cookie 名称。
- TLS 终止属于部署层；本地 Caddy/cloudflared 等可把 HTTPS 流量转发给 loopback gateway。
- IP allowlist 不属于当前核心需求，也不作为当前发布验收条件；如果未来确有使用场景，再提升为 Requirement。

## 首次登录

Windows PowerShell 示例：

```powershell
$env:DSH_AUTH_TOKEN = 'replace-with-a-long-random-secret'
```

本机访问：

```text
http://127.0.0.1:3081/?token=replace-with-a-long-random-secret
```

远程部署通常通过 HTTPS 反向代理访问：

```text
https://dsh.example.com/?token=replace-with-a-long-random-secret
```

只有根路径的 `token` query 属于 gateway。成功后浏览器跳转到去掉 gateway token 的干净 URL；`/chat?token=...` 等应用路径参数继续属于 DSH。

session cookie 使用 `HttpOnly; SameSite=Lax; Path=/`，并在可信 HTTPS 入口下附加 `Secure`。

## 持久 session

目标架构通过 DSH Web profile 已有的 `storageDomain` capability 保存 token-gate session。物理 backend 由宿主 profile 决定，token-gate 只拥有自己的 session domain 与数据语义。

一次成功 bootstrap 必须在返回 `303` 前完成 session 的持久写入。之后即使 DSH/token-gate 进程重启，只要 cookie 与服务端 session 都没有过期，该浏览器仍应继续被授权。

当前 `main` 仍使用进程内 session Map，因此这一点是已知的实现差距，而不是目标设计。

## 请求转发

授权后的 HTTP 请求保持流式转发；WebSocket 使用同一访问判断。gateway 会清理自身凭证和 hop-by-hop transport headers，并把内部 Host/Origin 改写为 loopback DSH authority。

DSH 如果拒绝 WebSocket upgrade 并返回普通 HTTP，gateway 将正常转回该响应；已经到达的 early client bytes 只会在 upstream 接受 upgrade 后转发。

如果 upstream 在响应过程中异常中断，下游连接应同步终止，而不是无限等待。

## 生命周期

Cordis activation 会等待 session domain 打开和 gateway listener 真正监听。dispose/HMR 会关闭 listener、当前连接和 domain runtime handle，但不会删除仍有效的持久 session 记录。

## 安装、测试与开发

```sh
pnpm install
pnpm run check
npm pack --dry-run --ignore-scripts
dsh plugin --profile web add .
```

开发期：

```sh
dsh web --patch /ABSOLUTE/PATH/TO/dsh-token-gate/cordis.dev.patch.yml
```

完整的 Requirement、Architecture、agent-facing Spec 与真实 DSH 验收流程见 [`spec/`](./spec/)。

当前验证目标为 Windows + Node 22。测试按真实影响面增加，coverage 百分比不是发布门禁。

## License

MIT
