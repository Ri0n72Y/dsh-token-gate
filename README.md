# dsh-token-gate

DeepSeek Harness 的轻量浏览器访问门。它让 DSH Web 保持在 loopback，通过独立 gateway 对远端浏览器提供**主机批准的设备配对、持久滑动 session 与透明 HTTP/WebSocket 转发**。

## 访问模型

```text
remote browser
    │
    │ /?token=<secret>
    ▼
┌─ dsh-token-gate ───────────────────────────────┐
│ valid token          → pending device request  │
│ host approved device → durable sliding session│
│ valid device session → allow HTTP / WS         │
│ otherwise            → pairing wait / deny     │
└───────────────────┬────────────────────────────┘
                    ▼
              127.0.0.1:<DSH>
                    ▲
                    │ local host browser
                    │ Token Gate settings tab
```

核心约束：

- DSH Web 必须监听 `127.0.0.1`；远端浏览器不能绕过 gateway。
- 根路径 `/?token=...` 只发起设备授权申请，**不会立即取得 DSH 访问权**。
- token 被接受后会立即从可见 URL 中移除；浏览器持有短期 pairing cookie，并进入最小等待页面。
- 主机通过本地 DSH Web 的 **Token Gate** settings tab 查看 pending/authorized devices，并批准、拒绝或撤销设备。
- 已批准但浏览器尚未完成 session exchange 的申请会明确显示为 **Approved — waiting for device**；主机仍可在 exchange 前取消该次批准。
- 管理 API 只注册在 loopback DSH Web 的 `/__token-gate/*`；gateway 明确拒绝代理该路径，因此远端已授权设备也不能借 gateway 管理主机。
- 获批设备取得 HttpOnly session。授权状态通过 DSH `storageDomain` 持久化，DSH/token-gate 重启不会自动登出。
- session 使用 sliding inactivity TTL。每个请求都校验 durable expiry，但默认只在约 24 小时后的第一次有效请求做一次持久续期，而不是每个请求写盘。
- 撤销设备后旧 session 在下一次请求立即失效；设备若要重新访问，需要再次携带 token 发起申请并重新获得主机批准。
- HTTP 与 WebSocket 共用同一设备授权边界，授权后透明使用原有 DSH Web。
- pairing/session cookies 不会透传给 DSH，DSH 也不能覆盖 token-gate 自己的 cookie 名称。
- TLS 终止属于部署层；Caddy/cloudflared 等可以把 HTTPS 转发给 loopback gateway。
- IP allowlist 不属于当前授权模型。

## 设备授权流程

Windows PowerShell 示例：

```powershell
$env:DSH_AUTH_TOKEN = 'replace-with-a-long-random-secret'
```

远端设备打开：

```text
https://dsh.example.com/?token=replace-with-a-long-random-secret
```

流程：

1. token-gate 验证 bootstrap secret；
2. 将 pending device request 持久化，并从 URL 中移除 secret；
3. 浏览器进入 `/_token-gate/wait`，此时不能访问 DSH；
4. 主机在本地 DSH Web 的 **Token Gate** tab 中批准或拒绝；
5. 获批浏览器轮询到批准状态后，token-gate 先持久化 authorized-device record，再写入长期 HttpOnly session cookie；
6. 浏览器跳回原本的干净 DSH 路径；之后无需再次携带 token，直到设备被撤销或长期不活动导致 session 到期。

只有根路径的 `token` query 属于 gateway；例如 `/chat?token=...` 仍然属于 DSH 应用自身。

## 持久与滑动 session

pending requests 与 authorized devices 保存在 token-gate 自己的 DSH storage domain 中。物理 backend 由宿主 profile 决定；插件不要求单独运行数据库服务。

原始 pairing/session bearer 不需要写入 durable storage。存储层使用 bearer 的单向派生 key；审批后的 session bearer 由 pairing credential 确定性派生，因此审批完成后的网络重试不会额外产生第二个设备 session。

获批 session 必须在发出 authorizing cookie 前完成 durable write。session 到期时间随有效使用向后滑动；默认 `renewalIntervalHours=24`，且该间隔必须短于 `sessionTtlDays`。

如果续期写入失败但旧 durable deadline 仍有效，本次请求仍可使用旧授权期限完成，但不会向浏览器声称更长的新期限。

## 主机设备管理

主机本地 DSH Web 会加载 token-gate 的 `dsh.client` contribution，在 Plugins settings 中提供 **Token Gate** tab。它显示：

- 待批准设备；
- 已批准、等待浏览器完成 exchange 的设备；
- 已授权设备；
- authority 与浏览器描述；
- 请求/批准/授权时间；
- 最近一次持久续期活动；
- session 到期时间。

主机可以执行 **Approve / Reject / Revoke**；已批准但尚未 exchange 的申请可以取消批准。Revoke 只终止当前授权，不形成永久封禁。

## 请求转发

授权后的 HTTP 请求保持流式转发；WebSocket 使用同一设备 session 判断。gateway 清理自身 cookies、外部 proxy identity headers 与 hop-by-hop transport headers，并把内部 Host/Origin 改写为 loopback DSH authority。

DSH 如果拒绝 WebSocket upgrade 并返回普通 HTTP，gateway 会正常转回该响应；early client bytes 只在 upstream 接受 upgrade 后转发。HTTP upstream 在响应中途异常中断时，下游也会及时终止。

## 生命周期

Cordis activation 会等待 authorization domain 打开和 gateway listener 真正监听；同时在 DSH loopback webServer 注册主机管理 routes。dispose/HMR 会关闭 gateway listener、当前连接、management routes 和 domain handle，但不会因为进程停止而删除仍有效的 durable authorization records。

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

完整 Requirement、Architecture、agent-facing Spec 与真实 DSH 验收流程见 [`spec/`](./spec/)。

当前验证目标为 Windows + Node 22。测试按真实影响面增加，coverage 百分比不是发布门禁。

## License

MIT
