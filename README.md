# dsh-token-gate

DeepSeek Harness 的轻量 sidecar 网关插件。它在 DSH Web Server 前提供一个很窄的访问边界：首次使用预共享 token 换取 HttpOnly session，之后才允许 HTTP / WebSocket 流量进入 DSH。任何未授权访问都得到完全一致的纯文本 404。

## 安全模型

```text
browser / cloudflared / caddy
              │
              ▼
┌─ dsh-token-gate :3081 ───────────────────────┐
│ valid session cookie                          │ → allow
│ explicitly allowlisted client IP              │ → allow
│ ?token=<valid bootstrap token>                │ → session + 303
│ everything else                               │ → identical 404
└───────────────────┬───────────────────────────┘
                    ▼
             127.0.0.1:<DSH port>
```

安全边界有几个明确约束：

- `Host` 不参与授权决策；网关没有隐式 loopback 免鉴权，因此本机反代也无法借 `Host: localhost` 获得旁路权限。
- 本机可直接访问 DSH 原本的 loopback 端口；如果需要从网关免鉴权访问，显式把 `127.0.0.0/8` / `::1/128` 加入 `allowIps`。
- `CF-Connecting-IP` / `X-Forwarded-For` / `X-Forwarded-Proto` 只在 TCP 对端属于 `trustedProxies` 时才可信。
- 网关自己的 session cookie 在转发前会从 `Cookie` 中删除，DSH upstream 看不到它。
- `Host` 会改写为 DSH loopback 地址，`Origin` 会移除；外部入口必须始终指向网关端口。
- 未授权的 `/`、`/api/*`、旧 `/api/auth/*`、错误 token 和达到限流后的请求都返回同一份 404，不暴露鉴权状态或插件指纹。
- 插件停止时会关闭监听端口和已升级的连接；不会回退成直连 DSH。

404 响应只有：

```text
404 page not found
```

## 首次登录

生产环境推荐把 token 放在 DSH 进程环境变量中：

```sh
export DSH_AUTH_TOKEN='replace-with-a-long-random-secret'
```

然后访问：

```text
https://dsh.example.com/?token=replace-with-a-long-random-secret
```

有效 token 会得到 `303`，网关设置 HttpOnly session cookie，并跳转到删除了 `token` 参数的干净 URL。之后访问只依赖 session cookie。

> 远程部署必须使用 HTTPS。`?token=` 会出现在首次 HTTP 请求中，因此反向代理/CDN 的 access log 应关闭 query-string 记录或对 `token` 参数脱敏。网关响应会设置 `Referrer-Policy: no-referrer`，避免后续导航继续携带来源 URL。

生产配置在没有 `config.token` 和 `DSH_AUTH_TOKEN` 时会直接拒绝启动鉴权逻辑。只有显式设置 `allowGeneratedToken: true` 才会生成临时 token；仓库内的 `cordis.dev.patch.yml` 仅在 loopback 开发模式下这样做。

## 安装与开发

```sh
pnpm install
pnpm run check
dsh plugin --profile web add .
```

开发期可直接加载源码：

```sh
dsh web --patch /ABSOLUTE/PATH/TO/dsh-token-gate/cordis.dev.patch.yml
```

## 配置

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `token` | unset | bootstrap token；优先于 `DSH_AUTH_TOKEN` |
| `cookieName` | `dsh_session` | HttpOnly session cookie 名 |
| `sessionTtlDays` | `30` | session 有效期（天） |
| `rateMax` | `10` | 每客户端每个窗口允许的 token 尝试次数 |
| `rateWindowMinutes` | `15` | 限流窗口（分钟） |
| `allowIps` | `[]` | 免 session 的客户端 IP/CIDR，支持 IPv4/IPv6 |
| `trustedProxies` | `127.0.0.0/8`, `::1/128` | 可以提供 forwarded headers 的 TCP 对端 |
| `allowGeneratedToken` | `false` | 显式允许启动时生成临时 token；仅建议开发使用 |
| `bind` | `0.0.0.0` | 网关监听地址 |
| `port` | `3081` | 网关监听端口 |

当 cloudflared/caddy 与 DSH 在同一主机运行时，默认 `trustedProxies` 足够。`trustedProxies` 只决定 forwarded headers 是否可信，不会自动放行代理自身。如果反代位于容器网络或另一台机器，必须只加入实际代理地址/CIDR，避免把整个不可信网络设为 trusted proxy。

## 请求转发

授权后的 HTTP 请求以流方式转发。网关会：

- 重写 `Host` 为 `127.0.0.1:<DSH port>`；
- 删除 `Origin`；
- 删除 RFC hop-by-hop headers，以及 `Connection` 中声明的扩展 hop header；
- 删除 token-gate 自己的 session cookie，同时保留应用的其他 cookie；
- 对 WebSocket upgrade 进行同一套访问判定并建立双向管道。

## 测试与质量门禁

```sh
pnpm test
pnpm run test:coverage
pnpm run typecheck
pnpm run build
```

CI 在 Linux 和 Windows 上执行 typecheck、覆盖率、build 与 `npm pack --dry-run`。覆盖率门禁为 lines 90%、branches 80%、functions 85%。核心回归覆盖 Host spoof、trusted proxy、IPv4/IPv6 CIDR、统一 404、token 清 URL、cookie 隔离、hop-by-hop header、WebSocket 与 dispose。

## License

MIT
