# dsh-token-gate

DeepSeek Harness 的轻量 sidecar 网关插件。它把 DSH 保持在 loopback，只在独立端口提供 token bootstrap、HttpOnly session、可选 IP allowlist 与 HTTP/WebSocket 反向代理。未授权 HTTP 请求统一得到同一份纯文本 404。

## 安全模型

```text
browser / cloudflared / caddy
              │
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

- 插件启动时检查 `webServer.host`，DSH 如果监听 `0.0.0.0` 会直接拒绝启动，避免绕过 gateway 直连 DSH。
- session 绑定首次成功 bootstrap 的外部 authority；同一 cookie 换 Host 后不会继续生效。
- 浏览器请求在内部改写前检查 `Origin` 与 `Host` 是否同源，并拒绝 `Sec-Fetch-Site: cross-site`。通过后才把 Host/Origin 改成 DSH loopback authority。
- `allowIps` 仍经过 Host fence：IP literal/loopback authority 可直接使用；命名 authority 需要列入 `trustedHosts`，防 DNS rebinding。
- forwarded headers 默认全部不可信。只有 TCP peer 明确列入 `trustedProxies` 后，`realIpHeader` 才参与客户端 IP 判定。
- 默认 `realIpHeader=x-forwarded-for`，按右向左跳过可信代理链，避免客户端伪造左侧 XFF。`CF-Connecting-IP` 仅在显式配置该模式、且直接代理保证覆盖该头时使用。
- gateway session cookie、外部 proxy identity headers 和 hop-by-hop headers 不会透传给 DSH；upstream response 的 hop-by-hop headers 同样清理。
- rate-limit identity 与 session store 都有硬上限，达到容量后 fail-closed。
- Cordis activation 会等待端口真正监听；`EADDRINUSE` 等失败会让 effect/fiber 失败。dispose/HMR 会等待监听与升级 socket 关闭。

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

只有根路径的 `token` query 属于 gateway。成功后返回 `303`、写入 HttpOnly session，并跳转到去掉 `token` 的干净 URL。`/chat?token=...`、`/api/...?...token=...` 等参数继续由 DSH/插件自己处理。

远程部署必须使用 HTTPS。首次 `?token=` 会进入 HTTP request line，因此反代/CDN access log 应关闭 query-string 记录或对 `token` 参数脱敏。响应带 `Referrer-Policy: no-referrer`。

## 反向代理与真实客户端 IP

`trustedProxies` 默认是 `[]`。普通本地 Caddy 可显式配置：

```yaml
- id: token-gate
  config:
    trustedProxies: ['127.0.0.1/32']
    realIpHeader: x-forwarded-for
```

`X-Forwarded-For` 会从最右侧开始解析：连续跳过 `trustedProxies`，第一个不可信地址才被视为真实客户端。缺失或含非法 IP 的 XFF 在可信代理模式下不会退回代理自身地址。

Cloudflare 专用头需要显式选择：

```yaml
realIpHeader: cf-connecting-ip
```

只有在 gateway 的直接 TCP peer 确实保证覆盖 `CF-Connecting-IP` 时使用该模式。通用 Caddy 不应仅因为运行在 localhost 就自动信任客户端传入的 CF 头。

## IP allowlist 与 trustedHosts

当 `allowIps` 通过命名域名访问时，同时声明实际服务 authority：

```yaml
allowIps: ['192.168.1.0/24']
trustedHosts: ['dsh.example.com']
```

`trustedHosts` 支持 canonical `host` 或 `host:port`；不带 port 表示该 hostname 的任意 port。非 canonical 值会在插件加载时直接报错。通过 IP literal URL 访问时无需额外 trusted host，因为浏览器 Host 无法用 DNS 名称重绑定成该 IP literal。

## 配置

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `token` | unset | bootstrap token；优先于 `DSH_AUTH_TOKEN` |
| `cookieName` | `dsh_session` | HttpOnly session cookie 名，非法 cookie token 会拒绝加载 |
| `sessionTtlDays` | `30` | session 有效期（天） |
| `sessionMax` | `4096` | 内存 session 最大数量 |
| `rateMax` | `10` | 每客户端每窗口最大 bootstrap 尝试次数 |
| `rateWindowMinutes` | `15` | 限流窗口（分钟） |
| `rateMaxKeys` | `2048` | 同一窗口最多追踪的限流 identity 数 |
| `allowIps` | `[]` | 免 session 的客户端 IP/CIDR，支持 IPv4/IPv6 |
| `trustedProxies` | `[]` | 可提供 forwarded headers 的直接/链式代理 CIDR |
| `trustedHosts` | `[]` | IP allowlist 经命名 authority 访问时允许的 host[:port] |
| `realIpHeader` | `x-forwarded-for` | `none` / `x-forwarded-for` / `cf-connecting-ip` |
| `allowGeneratedToken` | `false` | 显式允许生成临时 token，仅建议开发使用 |
| `bind` | `0.0.0.0` | gateway 监听地址 |
| `port` | `3081` | gateway 监听端口 |

## 请求转发

授权后的 HTTP 请求流式转发；WebSocket 使用同一访问策略。浏览器边界检查完成后，gateway 将 `Host` 改成 `127.0.0.1:<DSH port>`；如果原请求有 `Origin`，会改成对应 loopback Origin，使 DSH 自身 trust fence 继续看到一致的内部 authority。外部 forwarded identity headers 会被删除。

WebSocket upstream 如果拒绝升级并返回普通 HTTP（例如 426），gateway 会把该响应完整转回客户端；客户端在 upgrade header 后提前到达的 `head` 数据会等 upstream 101 后再写入升级 socket。

## 安装、测试与开发

```sh
pnpm install
pnpm run check
pnpm run test:coverage
npm pack --dry-run
dsh plugin --profile web add .
```

开发期：

```sh
dsh web --patch /ABSOLUTE/PATH/TO/dsh-token-gate/cordis.dev.patch.yml
```

CI 在 Linux 和 Windows 上执行 typecheck、覆盖率、build 与 tarball 检查；覆盖率门禁保持 lines 90%、branches 80%、functions 85%。

## License

MIT
