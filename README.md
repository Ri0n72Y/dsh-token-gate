# dsh-token-gate

DeepSeek Harness 的轻量 sidecar 认证网关。它把 DSH 保持在 loopback，只在独立端口提供 token bootstrap、HttpOnly session、可选 IP allowlist 与 HTTP/WebSocket 反向代理。未授权 HTTP 请求保持同一份最小纯文本 404。

## 安全模型

```text
browser
   │ HTTPS
   ▼
caddy / cloudflared / reverse proxy
   │ trusted local/private hop
   ▼
┌─ dsh-token-gate :3081 ─────────────────────────────┐
│ /?token=<secret>                  → session + 303   │
│ authority-bound session + browser fence → allow    │
│ allowlisted IP + Host fence             → allow    │
│ everything else                         → 404      │
└──────────────────────┬──────────────────────────────┘
                       ▼
                 127.0.0.1:<DSH>
```

关键约束：

- 插件启动时检查 `webServer.host`；DSH 如果监听 `0.0.0.0` 会直接拒绝启动，避免绕过 gateway 直连 DSH。
- gateway 默认监听 `127.0.0.1`。生产环境应由 HTTPS reverse proxy 暴露 gateway；只有明确的私网部署才应主动改为 `0.0.0.0`。
- session 绑定首次成功 bootstrap 的外部 authority；同一 cookie 换 Host 后不会继续生效。
- bootstrap 与普通 HTTP/WebSocket 请求都在内部改写前检查 `Host`、`Origin` 与 Fetch Metadata。普通请求显式 `Sec-Fetch-Site: cross-site` 一律拒绝；bootstrap 仅额外允许用户触发的顶层 document navigation，以保留可点击分享链接。
- `allowIps` 仍经过 browser/Host fence；IP literal/loopback authority 可直接使用，命名 authority 需要列入 `trustedHosts`。
- forwarded headers 默认全部不可信。只有 TCP peer 明确列入 `trustedProxies` 后，XFF 与 `X-Forwarded-Proto` 才参与客户端身份和外部 scheme 判断。
- `X-Forwarded-For` 从最右侧开始跳过可信代理链；缺失或含非法 IP 时 fail closed，不回退成可信代理自身地址。
- `CF-Connecting-IP` 永远不参与授权和 rate-limit identity。Cloudflare 部署应在 reverse proxy 层整理可信 XFF 链后再交给 token-gate。
- session cookie 默认带 `Secure`；只有显式本地 HTTP 开发场景才应配置 `secureCookie: false`。
- gateway session cookie、外部 proxy identity headers 和 hop-by-hop headers 不会透传给 DSH；upstream 也不能用同名 `Set-Cookie` 覆盖 gateway session。
- rate-limit identity 与 session store 都有硬上限；达到容量时淘汰最久未使用项，保持内存上限而不造成全局新登录锁死。
- malformed request-target、Node HTTP parser error 和普通未认证请求在能够返回 HTTP 响应时保持同一最小 404 surface。
- Cordis activation 会等待端口真正监听；`EADDRINUSE` 等失败会让 effect/fiber 失败。dispose/HMR 会等待监听以及 owned HTTP/WebSocket socket 关闭。

完整威胁模型见 [`SECURITY.md`](./SECURITY.md)。

### Token 权限语义

`dsh-token-gate` 把 token 视为 **DSH 管理员凭据**。认证通过后，请求会改写为 DSH loopback authority，因此 DSH 中原本只依赖 loopback/browser-trust fence 的管理操作也可能通过已认证的远程 session 使用。

这意味着 token 应按主机控制级 secret 管理。当前插件不提供按 API method 划分的角色或 scope；需要“远程只读/受限能力”的部署应在外部再增加授权层。

404 响应固定为：

```text
404 page not found
```

## 首次登录

推荐在 DSH 进程环境中设置：

```sh
export DSH_AUTH_TOKEN='replace-with-a-long-random-secret'
```

访问：

```text
https://dsh.example.com/?token=replace-with-a-long-random-secret
```

只有字面根路径 `/?token=...` 属于 gateway bootstrap。`/%2e%2e/?token=...`、absolute-form request-target、`/chat?token=...`、`/api/...?...token=...` 等不会被当作 bootstrap。

分享链接可以从其他站点由用户点击打开：当浏览器明确标记为 `navigate + document + Sec-Fetch-User: ?1` 的顶层导航时，gateway 允许请求继续进入 token 校验。cross-site fetch/XHR、iframe、无用户触发的导航以及带异源 `Origin` 的 bootstrap 仍会得到 404。无论 Fetch Metadata 如何，只有正确 token 才能创建 session。

成功后返回 `303`、写入 HttpOnly session，并跳转到去掉 `token` 的干净 URL。

远程部署必须使用 HTTPS。首次 `?token=` 会进入 HTTP request line，因此 reverse proxy/CDN access log 应关闭 query-string 记录或对 `token` 参数脱敏。响应带 `Referrer-Policy: no-referrer`。

## Reverse proxy 与真实客户端 IP

`trustedProxies` 默认是 `[]`。本机 Caddy 典型配置：

```yaml
- id: token-gate
  config:
    trustedProxies: ['127.0.0.1/32']
    realIpHeader: x-forwarded-for
```

对于 HTTPS 请求，reverse proxy 还必须覆盖正确的 `X-Forwarded-Proto: https`。gateway 只有在 socket peer 属于 `trustedProxies` 时才相信这个 header；这样 `Origin: https://...` 与外部 Host 的 same-origin 判断才成立。

`X-Forwarded-For` 从最右侧开始解析：连续跳过 `trustedProxies`，第一个不可信地址才视为真实客户端。缺失或含非法 IP 的 XFF 不会退回为可信代理自身地址。

Cloudflare 场景不要切换到 `CF-Connecting-IP`。应让 Caddy/cloudflared 自己保证上游来源可信、清洗 forwarded headers，并给 token-gate 一个规范 XFF 链。这样不会因为普通客户端伪造 CF header 而重新引入 allowlist bypass。

## IP allowlist 与 trustedHosts

当 `allowIps` 通过命名域名访问时，同时声明实际服务 authority：

```yaml
allowIps: ['192.168.1.0/24']
trustedHosts: ['dsh.example.com']
```

`trustedHosts` 支持 canonical `host` 或 `host:port`：

- 不带 port：该 hostname 的任意 port；
- 带 port：按实际外部 scheme 的有效端口精确匹配；例如 HTTPS 的无显式端口 Host 等价于 `:443`，不会误匹配 `:80`。

非 canonical 值会在插件加载时直接报错。通过 IP literal URL 访问时无需额外 trusted host，因为浏览器 Host 无法用 DNS 名称重绑定成该 IP literal。

## 配置

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `token` | unset | bootstrap token；优先于 `DSH_AUTH_TOKEN` |
| `cookieName` | `dsh_session` | HttpOnly session cookie 名，非法 cookie token 会拒绝加载 |
| `secureCookie` | `true` | session cookie 是否强制 `Secure`；仅本地 HTTP 开发建议关闭 |
| `sessionTtlDays` | `30` | session 有效期（天） |
| `sessionMax` | `4096` | 内存 session 最大数量；满时淘汰最久未使用 session |
| `rateMax` | `10` | 每客户端每窗口最大 bootstrap 尝试次数 |
| `rateWindowMinutes` | `15` | 限流窗口（分钟） |
| `rateMaxKeys` | `2048` | 同时追踪的 rate-limit identity 上限；满时 LRU 淘汰 |
| `allowIps` | `[]` | 免 session 的客户端 IP/CIDR，支持 IPv4/IPv6 |
| `trustedProxies` | `[]` | 可提供 XFF / X-Forwarded-Proto 的代理 CIDR |
| `trustedHosts` | `[]` | IP allowlist 经命名 authority 访问时允许的 host[:port] |
| `realIpHeader` | `x-forwarded-for` | `none` / `x-forwarded-for` |
| `allowGeneratedToken` | `false` | 显式允许生成临时 token，仅建议开发使用 |
| `bind` | `127.0.0.1` | gateway 监听地址；公网应通过 reverse proxy 暴露 |
| `port` | `3081` | gateway 监听端口 |

## 请求转发

授权后的 HTTP 请求流式转发；WebSocket 使用同一访问策略。browser boundary 检查完成后，gateway 将 `Host` 改成 `127.0.0.1:<DSH port>`；如果原请求有 `Origin`，会改成对应 loopback Origin，使 DSH 自己看到一致的内部 authority。外部 forwarded identity headers 会被删除。

HTTP upstream 如果在响应 body 中途异常断开，gateway 会终止 downstream connection，避免客户端与 socket 长时间悬挂。

WebSocket request 的 hop-by-hop headers 会重新构造成 canonical `Connection: Upgrade` / `Upgrade: websocket`。upstream 如果拒绝升级并返回普通 HTTP（例如 426），gateway 会把该响应转回客户端；客户端在 upgrade header 后提前到达的 `head` 数据会等 upstream 101 后再写入 upgraded socket。

## 安装、测试与开发

```sh
pnpm install
pnpm run check
pnpm run test:coverage
npm pack --dry-run
dsh plugin --profile web add .
```

开发期如果需要直接通过 HTTP 访问 gateway：

```yaml
- id: token-gate
  config:
    bind: 127.0.0.1
    secureCookie: false
```

然后：

```sh
dsh web --patch /ABSOLUTE/PATH/TO/dsh-token-gate/cordis.dev.patch.yml
```

CI 在 Linux 和 Windows 上执行 typecheck、覆盖率、build 与 tarball 检查；覆盖率门禁保持 lines 90%、branches 80%、functions 85%。测试包含真实 Cordis `Context/Fiber` lifecycle、malformed raw HTTP、proxy abort、share-link bootstrap 和 WebSocket regression。

## License

MIT
