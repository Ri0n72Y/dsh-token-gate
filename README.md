# dsh-token-gate

DeepSeek Harness 的 sidecar 网关插件：在 dsh 前面立一道 token 门禁，未授权的外部访问统一得到 **404 伪装页**，dsh 本身不暴露给外部。

## 为什么需要它

DSH 的 web 服务默认只绑 loopback；社区里把它开放出去的办法无非三条：改源码绑 `0.0.0.0`、本地反代 + Cloudflare Tunnel、SSH 隧道。这些方案把 dsh 整个裸在网络上，`/api` 和 WebSocket 谁都能摸。本插件在流量到达 dsh 之前加一道认证层：

```text
浏览器 / cloudflared / caddy
        │  指向网关端口（默认 0.0.0.0:3081）
        ▼
┌─ dsh-token-gate（独立 node:http 服务器）──────────────┐
│  本机 Host（127.0.0.1 / localhost）   → 放行          │
│  白名单 IP / CIDR                    → 放行          │
│  HttpOnly session cookie 有效        → 放行          │
│  /api/auth/bootstrap|status|logout  → 网关自持       │
│  其余（无 token 非白名单）            → 404 伪装页     │
│  放行请求 → 反向代理 → 127.0.0.1:<dsh端口>           │
│  WebSocket upgrade → 判定后转发（双向管道）            │
└──────────────────────────────────────────────────────┘
```

## 使用方式

### 安装

```sh
cd dsh-token-gate
pnpm install
pnpm run build
dsh plugin --profile web add .
```

或开发期直接加载源码：

```sh
dsh web --patch /ABSOLUTE/PATH/TO/dsh-token-gate/cordis.dev.patch.yml
```

### 配置 token

优先级：`config.token` → 环境变量 `DSH_AUTH_TOKEN` → 启动时随机生成并打印到日志（搜 `generated access token`）。

### 配置项（Config）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `token` | string | 无 | 预共享 bootstrap token；未设置时读 `DSH_AUTH_TOKEN`，再未设置则随机生成并打印 |
| `cookieName` | string | `dsh_session` | HttpOnly session cookie 名 |
| `sessionTtlDays` | number | `30` | 会话有效期（天） |
| `rateMax` | number | `10` | 每客户端在窗口内的最大 bootstrap 尝试次数 |
| `rateWindowMinutes` | number | `15` | 限流窗口（分钟） |
| `allowIps` | string[] | `[]` | 免 token 放行的来源 IP 或 CIDR（如 `192.168.1.0/24`、`100.64.0.0/10`） |
| `bind` | string | `0.0.0.0` | 网关绑定地址；只想本机代理访问时改 `127.0.0.1` |
| `port` | number | `3081` | 网关监听端口 |

示例：

```yaml
- id: token-gate
  config:
    allowIps: ['192.168.1.0/24']
    bind: '127.0.0.1'
```

## 工作原理

### 判定顺序

1. Host 头是 loopback（`127.0.0.1` / `localhost`）→ 放行。本地用户走网关端口也不受影响。
2. 路径是 `/api/auth/*` → 网关自持（bootstrap 发 token、logout 撤销、status 查状态）。auth 路径永远优先于 cookie/IP 判定。
3. session cookie 有效 → 放行。
4. 来源 IP 在白名单 → 放行。
5. 其余 → 404 伪装页。

来源 IP 的判定：当对端 socket 是 loopback 但 Host 不是（流量经本机 cloudflared 之类的可信代理），取 `CF-Connecting-IP`，其次 `X-Forwarded-For` 第一跳；直连场景只用 socket 地址，防止伪造头冒充白名单。

### 转发细节

- Host 头改写为 `127.0.0.1:<dsh端口>`，Origin 头剥离：dsh 自己的浏览器信任栅栏（DNS-rebinding 防御）把它当 loopback 放行，因此**不需要 `--trusted-host`**。认证责任整体转移到网关，dsh 侧零配置。
- 请求体与响应体全程流式管道，SSE / 大文件不受影响。
- WebSocket：网关判定后把 upgrade 请求转发给 dsh，101 握手回写，双向字节流管道；任一端断开都会拆掉对端，不留半开连接。

### 安全边界

- 未授权请求在网关就被截停，dsh 一个字节都不会发出，不存在"先加载内容再遇到门禁"的问题。
- 404 页面是纯静态伪装页（nginx 风格），不含 dsh 任何指纹；只有 URL 带 `#token=` 时隐藏脚本才会工作。
- 网关是插件进程的一部分：插件停止 → 网关端口关闭 → 外部直接连不上（fail-closed），不会回退成裸奔。
- 会话在内存中，进程重启全员下线（符合预期；多实例/持久化需换 SQLite/Redis，协议不变）。
- **外部入口必须指向网关端口**。如果把 cloudflared/caddy 指回 dsh 原端口，门禁即被绕过——这是部署配置责任，不是插件职责。

## License

MIT
