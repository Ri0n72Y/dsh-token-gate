# dsh-token-gate

DeepSeek Harness 的轻量浏览器访问门。它让 DSH Web 保持在 loopback，通过独立 gateway 对远端浏览器提供设备配对、持久 session 与透明 HTTP/WebSocket 转发。

> 当前 `main` 已实现 token bootstrap、进程内 session 与代理边界；`spec/` 描述的是下一步目标：**token 只发起设备授权申请，主机批准后才建立持久 session；session 随使用滑动续期，并可由主机撤销。**

## 目标模型

```text
remote browser
    │
    │ /?token=<secret>
    ▼
┌─ dsh-token-gate ───────────────────────────────┐
│ valid token          → pending device request  │
│ host approved device → durable sliding session│
│ valid device session → allow HTTP / WS         │
│ otherwise            → pending/opaque deny     │
└───────────────────┬────────────────────────────┘
                    ▼
              127.0.0.1:<DSH>
                    ▲
                    │ local host browser
                    │ device management card
```

核心约束：

- DSH Web 必须监听 `127.0.0.1`；远端浏览器不能绕过 gateway。
- 根路径 `/?token=...` 只证明浏览器持有 bootstrap secret，并创建待批准设备申请；默认情况下不会立即获得 DSH 访问权。
- token 被接受后应立即从可见 URL 中移除，之后浏览器只保留短期配对状态等待主机决定。
- 主机通过本地 DSH Web 中的 token-gate 管理卡片查看 pending/authorized devices，并批准、拒绝或撤销设备。
- 获批设备获得 HttpOnly session。session 持久化到 DSH/Cordis 的 storage-domain，进程重启不会自动失效。
- session 使用滑动 inactivity TTL：正常使用会续期，但持久写入默认合并为约每天第一次有效请求一次，而不是每个请求都写盘。
- 撤销设备后，旧 cookie 在后续请求中失效；该设备若要重新访问，需要再次携带 token 发起申请并重新获得主机批准。
- HTTP 与 WebSocket 共用同一设备授权边界，授权后尽可能透明地使用原有 DSH Web。
- gateway credential cookie 不会透传给 DSH，DSH 也不能覆盖 gateway 自己的 session cookie。
- TLS 终止属于部署层；Caddy/cloudflared 等可以把 HTTPS 转发给 loopback gateway。
- IP allowlist 不属于当前核心需求或当前发布验收条件。

## 设备授权流程

Windows PowerShell 示例：

```powershell
$env:DSH_AUTH_TOKEN = 'replace-with-a-long-random-secret'
```

远端设备打开：

```text
https://dsh.example.com/?token=replace-with-a-long-random-secret
```

目标流程：

1. token-gate 验证 bootstrap secret；
2. 创建一个短期 pending device request，并从 URL 中移除 secret；
3. 浏览器停留在最小的“等待主机批准”状态，不能访问 DSH；
4. 主机在本地 DSH Web 的 token-gate 管理卡片中批准或拒绝；
5. 获批后浏览器取得持久 HttpOnly session，跳转进入 DSH；
6. 之后无需再次携带 token，直到设备被撤销或长期不活动导致 session 到期。

只有根路径的 `token` query 属于 gateway；应用路径上的 `token` 参数继续属于 DSH。

## 持久与滑动 session

目标架构通过 DSH Web profile 已有的 `storageDomain` capability 保存 pending requests 与 authorized devices。物理 backend 由宿主 profile 决定，token-gate 只拥有自己的授权 domain 与数据语义。

获批 session 必须在发出 authorizing cookie 之前完成持久写入。之后 DSH/token-gate 即使重启，只要设备仍获授权且 session 未到期，原 cookie 继续有效。

session 使用滑动过期。每个请求都会校验当前 durable expiry，但不需要每次都写存储；默认在距离上次续期约 24 小时后的第一个成功请求中更新 `expiresAt`/last-seen 信息并刷新 cookie lifetime。

当前 `main` 仍使用进程内固定 TTL session Map，因此持久化、滑动续期和设备授权流程都属于已知实现差距。

## 主机设备管理

管理面板属于主机本地 DSH Web，而不是一个独立公开管理站点。目标上它作为 token-gate 自己的 `dsh.client`/settings 卡片加载，显示：

- 待批准设备；
- 已授权设备；
- 用于区分设备的简单浏览器/标签信息；
- 创建时间、最近使用/续期时间、到期时间。

主机可以批准、拒绝和撤销。撤销只终止当前授权，不形成永久封禁。

## 请求转发

授权后的 HTTP 请求保持流式转发；WebSocket 使用同一设备授权判断。gateway 清理自身凭证和 hop-by-hop transport headers，并把内部 Host/Origin 改写为 loopback DSH authority。

DSH 如果拒绝 WebSocket upgrade 并返回普通 HTTP，gateway 正常转回该响应；early client bytes 只会在 upstream 接受 upgrade 后转发。

## 生命周期

Cordis activation 会等待授权 domain 打开和 gateway listener 真正监听。dispose/HMR 会关闭 listener、当前连接和 domain runtime handle，但不会仅因为进程停止而删除仍有效的 pending/device records。

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
