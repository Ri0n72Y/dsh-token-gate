# Architecture

This document visualizes the implemented architecture described by [`system.md`](./system.md). Diagrams intentionally model the current small plugin rather than a future identity platform.

## C4 Level 1 — System context

```mermaid
flowchart LR
    U["Person: DSH user\nUses a browser to access DSH"]
    OP["External system: deployment proxy\nOptional Caddy / cloudflared\nTLS termination and normalized forwarded headers"]
    TG["Software system: dsh-token-gate\nBootstrap token, session boundary, IP allowlist, HTTP/WS proxy"]
    DSH["External software system: DeepSeek Harness Web\nLoopback-only application server"]
    ENV["External configuration\nCordis config + DSH_AUTH_TOKEN"]

    U -->|HTTPS/HTTP + WebSocket| OP
    U -. local development .->|HTTP + WebSocket| TG
    OP -->|HTTP/WS to configured gateway port| TG
    ENV -->|startup configuration / secret| TG
    TG -->|sanitized HTTP/WS| DSH
```

The trust boundary is the gateway listener. The deployment proxy is optional and is not automatically trusted: its address must be present in `trustedProxies` before forwarded identity/protocol headers affect decisions.

## C4 Level 2 — Containers / runtime boundary

```mermaid
flowchart LR
    subgraph EXT[Outside the DSH process]
        B["Browser/client"]
        RP["Optional reverse proxy"]
    end

    subgraph PROC[DSH process / Cordis application]
        C["Cordis runtime\nloads plugin and owns effect lifecycle"]
        P["dsh-token-gate plugin\nconfig + composition root"]
        G["Gateway HTTP server\n127.0.0.1:3081 by default"]
        W["DSH webServer service\n127.0.0.1:<port>"]

        C -->|injects webServer + effect lifecycle| P
        P -->|creates/listens/disposes| G
        P -->|resolves loopback target from| W
        G -->|HTTP / WebSocket proxy| W
    end

    B -->|direct local access| G
    B --> RP
    RP -->|remote deployment access| G
```

`dsh-token-gate` and DSH run in the same Node/Cordis process, but the gateway uses a separate Node HTTP listener and proxies over loopback to the DSH Web listener. No external session store exists.

## Component view

```mermaid
flowchart LR
    IDX["index.ts\nCordis composition root"]
    CFG["config.ts\nSchema + token resolution"]
    UP["upstream.ts\nDSH loopback invariant"]
    GW["gateway.ts\nHTTP listener + lifecycle"]
    AC["access.ts\nrequest authority / browser fence / allowlist"]
    AU["auth.ts\nsession + token comparison + rate state"]
    NET["net.ts\nIP normalization / CIDR sets"]
    PX["proxy.ts\nHTTP + WebSocket forwarding"]
    DSH["Injected DSH webServer"]

    IDX --> CFG
    IDX --> UP
    IDX --> GW
    UP --> DSH
    GW --> AC
    GW --> AU
    GW --> PX
    AC --> AU
    AC --> NET
    PX --> AU
    PX --> DSH
```

The dependency direction keeps policy/state separate from transport forwarding. `gateway.ts` composes decisions but does not own IP parsing or token/session internals.

## Data-flow diagram

```mermaid
flowchart LR
    B["External entity\nBrowser / client"]
    RP["External entity\nTrusted or untrusted deployment proxy"]
    P1["Process 1\nParse request + determine authority/client IP"]
    P2["Process 2\nAccess decision"]
    P3["Process 3\nBootstrap authorization / session creation"]
    P4["Process 4\nSanitize + proxy HTTP/WS"]
    D1[("Data store\nIn-memory sessions")]
    D2[("Data store\nIn-memory rate buckets")]
    C1["Configuration / token source"]
    DSH["External entity\nDSH Web on loopback"]

    B --> RP
    B -. direct local .-> P1
    RP --> P1
    C1 --> P1
    C1 --> P3
    P1 -->|authority, client IP, browser metadata| P2
    P2 -->|bootstrap candidate| P3
    P3 <--> D2
    P3 -->|new session| D1
    D1 -->|session lookup| P2
    P2 -->|allow| P4
    P2 -->|deny| B
    P3 -->|303 + session cookie| B
    P4 -->|sanitized request| DSH
    DSH -->|HTTP/upgrade response| P4
    P4 -->|sanitized/streamed response| B
```

### Sensitive-data flow

The bootstrap token is accepted only on the root bootstrap request and is used only for comparison. It is never forwarded to DSH as gateway authentication data. The gateway session cookie is consumed at the access boundary and stripped before upstream forwarding. Session IDs and rate buckets exist only in process memory.

## UML class/dependency view

```mermaid
classDiagram
    class Config {
      +token? string
      +cookieName string
      +sessionTtlDays number
      +sessionMax number
      +rateMax number
      +rateWindowMinutes number
      +rateMaxKeys number
      +allowIps string[]
      +trustedProxies string[]
      +trustedHosts string[]
      +realIpHeader RealIpHeader
      +allowGeneratedToken boolean
      +bind string
      +port number
    }

    class TokenGatePlugin {
      +apply(ctx, config) Promise~void~
    }

    class Gateway {
      +server Server
      +listen() Promise~void~
      +close() Promise~void~
    }

    class AccessPolicy {
      +decide(req) AccessDecision
      +bootstrapToken(req) string?
      +clientIp(req) string
      +requestAuthority(req) string?
      +isSecure(req) boolean
    }

    class AuthService {
      +hasRequestSession(req, authority) boolean
      +authorizeBootstrap(clientKey, submitted) boolean
      +createSession(authority) string?
      +sessionCookie(id, secure) string
      +stripSessionCookie(raw) string?
      +isSessionSetCookie(raw) boolean
    }

    class IpSet {
      +has(address) boolean
    }

    class Proxy {
      +proxyHttp(req, res, target, auth, logger)
      +proxyUpgrade(req, socket, head, target, auth, logger)
      +forwardHeaders(...)
      +sanitizeResponseHeaders(...)
    }

    class UpstreamTarget {
      +host string
      +port number
    }

    TokenGatePlugin --> Config
    TokenGatePlugin --> Gateway
    TokenGatePlugin --> UpstreamTarget
    Gateway --> AccessPolicy
    Gateway --> AuthService
    Gateway --> Proxy
    AccessPolicy --> AuthService
    AccessPolicy --> IpSet
    Proxy --> AuthService
    Proxy --> UpstreamTarget
```

## UML sequence — first bootstrap

```mermaid
sequenceDiagram
    actor B as Browser
    participant G as Gateway
    participant A as AccessPolicy
    participant S as AuthService

    B->>G: GET /?token=<secret>
    G->>A: decide(request)
    A-->>G: bootstrap
    G->>A: bootstrapToken / authority / clientIp
    G->>S: authorizeBootstrap(clientKey, token)
    S->>S: rate-window check + timing-safe digest compare
    alt invalid or rate denied
        S-->>G: false
        G-->>B: 404 page not found
    else valid
        S-->>G: true
        G->>S: createSession(authority)
        S-->>G: session id
        G-->>B: 303 + Set-Cookie + clean Location
    end
```

## UML sequence — authorized HTTP request

```mermaid
sequenceDiagram
    actor B as Browser
    participant G as Gateway
    participant A as AccessPolicy
    participant S as AuthService
    participant P as Proxy
    participant D as DSH Web

    B->>G: HTTP request + session cookie
    G->>A: decide(request)
    A->>S: hasRequestSession(request, authority)
    S-->>A: valid / invalid
    alt denied
        A-->>G: deny
        G-->>B: opaque 404
    else allowed
        A-->>G: allow
        G->>P: proxyHttp(...)
        P->>P: strip gateway/proxy/hop headers; rewrite Host/Origin
        P->>D: sanitized streaming request
        D-->>P: response stream
        P->>P: sanitize headers / protect gateway cookie namespace
        P-->>B: response stream
    end
```

## UML sequence — WebSocket upgrade and disposal

```mermaid
sequenceDiagram
    actor B as Browser
    participant G as Gateway
    participant P as Proxy
    participant D as DSH Web
    participant C as Cordis

    B->>G: Upgrade request
    G->>G: same access policy as HTTP
    G->>P: proxyUpgrade(request, socket, head)
    P->>D: canonicalized Upgrade request
    alt DSH rejects
        D-->>P: ordinary HTTP response
        P-->>B: sanitized HTTP response
    else DSH accepts
        D-->>P: 101 + upstream socket
        P-->>B: 101
        P->>D: client early head bytes
        B<<->>D: duplex stream through proxy
    end

    C->>G: dispose effect
    G->>G: destroy tracked client sockets
    G->>G: close listener
    G-->>C: resolve only after closures settle
```

## UML state view — request authorization

```mermaid
stateDiagram-v2
    [*] --> Parsed
    Parsed --> Denied: malformed URL / invalid authority / browser fence fails
    Parsed --> Bootstrap: root token query
    Parsed --> SessionCheck: ordinary request

    Bootstrap --> Denied: non-GET / token invalid / rate denied / capacity full
    Bootstrap --> SessionIssued: token valid + session created
    SessionIssued --> [*]: 303 + cookie

    SessionCheck --> Allowed: authority-bound session valid
    SessionCheck --> AllowlistCheck: no valid session
    AllowlistCheck --> Allowed: client IP allowed + Host fence passes
    AllowlistCheck --> Denied: otherwise

    Allowed --> [*]: proxy HTTP/WS
    Denied --> [*]: opaque 404 or close upgrade
```

## Lifecycle notes

The only persistent configuration is external Cordis/process configuration. Sessions and rate-limit records are not durable. This is a current behavior, not an omitted storage component in the diagrams. Adding durable device/session trust would change both the C4/data-flow views and `TG-SESS-004`, so it requires a separate spec change.