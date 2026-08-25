# Token Gate System Specification

Status: **baseline of implemented behavior**

## 1. Purpose

`dsh-token-gate` provides a small authenticated entry point in front of the DeepSeek Harness Web server. DSH remains bound to loopback. The gateway exposes a separate listener, converts one bootstrap token into a browser session, optionally allows configured client IP ranges, and proxies authorized HTTP/WebSocket traffic to DSH.

The design prefers a narrow, explicit boundary over a general authentication platform.

## 2. Actors and dependencies

- **Browser/client** — reaches the gateway and may hold a gateway session cookie.
- **Deployment proxy** — optional Caddy/cloudflared/other reverse proxy. It may terminate TLS and may provide normalized forwarding headers when explicitly trusted.
- **dsh-token-gate** — this plugin and its Node HTTP listener.
- **Cordis** — supplies plugin lifecycle and the injected DSH `webServer` service.
- **DSH Web server** — authenticated upstream application, required to remain on `127.0.0.1`.

## 3. Functional requirements

### Bootstrap and token resolution

**TG-AUTH-001 — Token source precedence**  
The bootstrap token MUST resolve in this order: non-empty `config.token`, non-empty `DSH_AUTH_TOKEN`, generated token when `allowGeneratedToken=true`. If none is available, plugin activation MUST fail.

**TG-AUTH-002 — Bootstrap ownership**  
Only the root request containing a non-empty `token` query parameter is a gateway bootstrap request. A `token` query on application paths remains application-owned.

**TG-AUTH-003 — Bootstrap method**  
Bootstrap MUST accept `GET` only. Other methods MUST receive the same unauthorized surface as other denied HTTP requests.

**TG-AUTH-004 — Token verification**  
Bootstrap attempts MUST pass the rate limiter before token comparison. Token comparison MUST use fixed-size digests and timing-safe equality.

**TG-AUTH-005 — Successful bootstrap**  
A successful bootstrap MUST create a session bound to the external request authority, set the gateway cookie, return `303`, and redirect to the same path/query with only the gateway `token` parameter removed.

### Sessions

**TG-SESS-001 — Cookie properties**  
The session cookie MUST be `HttpOnly`, `SameSite=Lax`, `Path=/`, and carry `Max-Age` derived from `sessionTtlDays`. `Secure` MUST be added only when HTTPS is reported through a trusted request boundary.

**TG-SESS-002 — Authority binding**  
A session MUST authorize requests only for the authority recorded when that session was created.

**TG-SESS-003 — Bounded process-local state**  
Sessions MUST be held in bounded process memory. Expired sessions are removed lazily. If `sessionMax` is reached after pruning, new session creation MUST fail closed.

**TG-SESS-004 — Restart semantics**  
Session state is intentionally process-local in the current version. Recreating the plugin instance, including process restart or lifecycle reload, invalidates server-side session state even if a browser still holds an unexpired cookie.

### Access policy

**TG-ACCESS-001 — Uniform denial**  
Denied HTTP requests MUST receive the same opaque plain-text `404` response. Denied WebSocket upgrades MUST be closed without exposing an alternate authentication surface.

**TG-ACCESS-002 — Browser trust fence**  
Before proxy rewriting, browser-oriented requests MUST have a valid authority, MUST reject `Sec-Fetch-Site: cross-site`, and, when `Origin` is present, MUST require HTTP(S) origin authority to match the request authority.

**TG-ACCESS-003 — Session access**  
A request with a valid authority-bound session and a trusted browser boundary MUST be allowed.

**TG-ACCESS-004 — Optional IP bypass**  
A client IP contained in `allowIps` MAY bypass session authentication only when the Host fence also passes.

**TG-ACCESS-005 — Host fence for IP bypass**  
Loopback or IP-literal authorities MAY pass directly. Named authorities MUST match canonical entries in `trustedHosts`.

### Client IP and trusted proxies

**TG-NET-001 — Direct peer default**  
Forwarded identity/protocol headers MUST NOT affect access decisions unless the direct peer is configured in `trustedProxies`.

**TG-NET-002 — Real IP modes**  
`realIpHeader=none` MUST use the direct TCP peer. `realIpHeader=x-forwarded-for` MAY resolve XFF only for a trusted peer.

**TG-NET-003 — XFF chain**  
XFF MUST be parsed as valid IP values and resolved from right to left through configured trusted proxies. The first untrusted address is the client address. Invalid chains MUST NOT be accepted as a client identity.

**TG-NET-004 — Provider neutrality**  
The plugin MUST NOT define CDN/vendor-specific client-IP modes. Deployment infrastructure should normalize such headers before traffic reaches the gateway.

### DSH upstream and proxy behavior

**TG-PROXY-001 — Upstream binding invariant**  
The injected DSH Web server MUST be bound to `127.0.0.1`. Plugin activation MUST fail if DSH exposes `0.0.0.0`.

**TG-PROXY-002 — Gateway binding default**  
The gateway MUST default to `127.0.0.1`. Binding `0.0.0.0` MUST be an explicit configuration choice.

**TG-PROXY-003 — Request sanitization**  
Authorized HTTP requests MUST strip gateway session cookies, external proxy-identity headers, standard hop-by-hop headers, and headers named by the incoming `Connection` header before forwarding.

**TG-PROXY-004 — Internal authority rewriting**  
Forwarded requests MUST use the loopback DSH authority as `Host`. When an incoming request has `Origin`, the forwarded origin MUST be rewritten to the corresponding loopback DSH origin.

**TG-PROXY-005 — Response sanitization**  
Upstream hop-by-hop response headers MUST be removed. Upstream `Set-Cookie` entries using the gateway-owned cookie name MUST be filtered while unrelated cookies remain intact.

**TG-PROXY-006 — HTTP failure containment**  
An upstream connection failure before response headers SHOULD produce `502`. If an upstream response aborts or errors after response start, the corresponding downstream response MUST be terminated rather than left hanging.

### WebSocket behavior

**TG-WS-001 — Shared access policy**  
WebSocket upgrades MUST use the same access decision as ordinary HTTP traffic.

**TG-WS-002 — Canonical upgrade forwarding**  
The gateway MUST rebuild only the required `Connection: Upgrade` and `Upgrade` pair rather than forwarding arbitrary client hop-by-hop declarations.

**TG-WS-003 — Non-101 response relay**  
If DSH rejects the upgrade with an ordinary HTTP response, that response MUST be sanitized and relayed to the client as ordinary HTTP.

**TG-WS-004 — Early client data**  
Client bytes already received after the upgrade request MUST be forwarded to the upstream socket only after DSH accepts the upgrade.

**TG-WS-005 — Coupled teardown**  
After upgrade, closure/error on either side MUST tear down the paired side.

### Cordis lifecycle

**TG-LIFE-001 — Activation**  
Plugin activation MUST wait until the gateway listener is actually listening. Listener errors such as `EADDRINUSE` MUST fail acquisition rather than reporting successful activation.

**TG-LIFE-002 — Disposal**  
The Cordis disposer MUST wait until the gateway listener and all gateway-tracked client sockets, including upgraded sockets, are closed.

**TG-LIFE-003 — Failure scope**  
Unexpected request-handler errors MUST be contained to the affected response/socket when possible and MUST NOT intentionally terminate the entire DSH process.

### Bounded bootstrap attempts

**TG-RATE-001 — Per-identity window**  
Bootstrap attempts MUST be counted per resolved client identity within a configured time window and denied after `rateMax` attempts.

**TG-RATE-002 — Global cardinality bound**  
The rate-limit map MUST NOT exceed `rateMaxKeys`. When the map is full and cannot be swept, new identities MUST fail closed.

## 4. Configuration contract

| Field | Default | Contract |
|---|---:|---|
| `token` | unset | Explicit bootstrap token; takes precedence over environment. |
| `cookieName` | `dsh_session` | Valid HTTP cookie token used only by the gateway. |
| `sessionTtlDays` | `30` | Server-side session TTL and browser cookie `Max-Age`. |
| `sessionMax` | `4096` | Maximum in-memory active session records. |
| `rateMax` | `10` | Bootstrap attempts per identity/window. |
| `rateWindowMinutes` | `15` | Rate-limit window. |
| `rateMaxKeys` | `2048` | Maximum tracked rate-limit identities. |
| `allowIps` | `[]` | Client IP/CIDR values allowed to bypass session auth subject to Host fence. |
| `trustedProxies` | `[]` | Peers allowed to supply XFF / X-Forwarded-Proto. |
| `trustedHosts` | `[]` | Canonical named authorities accepted by the IP-bypass Host fence. |
| `realIpHeader` | `x-forwarded-for` | `none` or trusted-chain `x-forwarded-for`. |
| `allowGeneratedToken` | `false` | Development-only fallback that permits a generated bootstrap token. |
| `bind` | `127.0.0.1` | Gateway listener; `0.0.0.0` requires explicit choice. |
| `port` | `3081` | Gateway listener port. |

## 5. Non-functional requirements

- The access boundary SHOULD remain small enough to audit directly.
- Failure paths SHOULD prefer fail-closed behavior.
- HTTP/WebSocket proxying SHOULD remain streaming and request-scoped.
- Platform claims MUST follow environments actually validated by the project; the present target is Windows + Node 22.
- Tests MUST be selected by independent regression value rather than coverage percentage.

## 6. Non-goals

The current version does not provide:

- TLS termination;
- username/password login or external identity providers;
- multiple users, roles, or permissions;
- persistent device/session storage across process recreation;
- logout/session-management UI;
- provider-specific CDN security adapters;
- a firewall, WAF, or general reverse-proxy configuration system;
- persistence databases or external session stores.

These features require an explicit product decision and spec update before implementation.