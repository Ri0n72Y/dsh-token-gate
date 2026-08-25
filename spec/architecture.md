# Architecture

Status: **structural authority derived from `requirement.md`**

This document defines the intended structure used to satisfy the product Requirement. It is not a diagram of every detail currently present in `src/`.

## Design principles

1. **DSH stays private.** DSH Web remains on loopback; token-gate is the browser-facing boundary.
2. **Proxy, do not invade DSH internals.** Authorized traffic uses DSH's existing HTTP/WebSocket surface instead of modifying agent/session/UI internals.
3. **Persist authorization through the host storage seam.** Browser sessions must survive token-gate/DSH process recreation until expiry.
4. **Use DSH/Cordis services before inventing parallel infrastructure.** Lifecycle comes from Cordis, upstream discovery from `webServer`, and durable state from DSH `storageDomain`.
5. **Keep the product smaller than a general auth platform.** Network allowlists, user accounts, and provider-specific proxy logic are outside the current architecture.

## C4 Level 1 — System context

```mermaid
flowchart LR
    U["Person: DSH user\nUses DSH through a browser"]
    RP["Optional deployment proxy\nTLS termination / local forwarding"]
    TG["Software system: dsh-token-gate\nBootstrap secret -> durable browser session\nHTTP/WebSocket access gate"]
    DSH["External software system: DSH Web\nLoopback-only application server"]
    STORE["DSH durable storage capability\nHost-managed local persistence"]

    U -->|HTTPS/HTTP + WebSocket| RP
    U -. local development .->|HTTP + WebSocket| TG
    RP -->|HTTP/WS| TG
    TG -->|authorized, sanitized HTTP/WS| DSH
    TG -->|session records| STORE
```

The optional deployment proxy is infrastructure, not part of the authentication model. Token-gate owns the authorization decision regardless of whether the browser reaches it directly or through a local reverse proxy.

## C4 Level 2 — Runtime containers

```mermaid
flowchart LR
    B["Browser"]
    RP["Optional Caddy / cloudflared"]

    subgraph PROC[DSH process / Cordis application]
        C["Cordis runtime\nplugin lifecycle"]
        TG["token-gate plugin\ncomposition root"]
        G["Gateway HTTP server\nseparate listener"]
        W["DSH webServer\n127.0.0.1:<port>"]
        SD["ctx.storageDomain\ntyped durable state facility"]

        C -->|effect lifecycle| TG
        TG -->|create / listen / dispose| G
        TG -->|resolve upstream| W
        TG -->|open token-gate session domain| SD
        G -->|HTTP / WebSocket proxy| W
    end

    MEDIUM[("Host-selected local storage backend\nWeb profile currently routes storageDomain to JSON")]

    B --> RP
    B -. direct local .-> G
    RP --> G
    SD -->|durable writes / reload on next process| MEDIUM
```

Token-gate does **not** own a standalone database process. It consumes the DSH storage-domain capability and therefore follows the storage backend selected by the host profile. The Web profile already provides storage and a local backend; another profile may route the same domain differently.

## Main component boundaries

```mermaid
flowchart LR
    IDX["Plugin composition\nCordis apply / dependency wiring"]
    CFG["Configuration\nbootstrap secret, cookie/session lifetime, listener"]
    GW["Gateway transport\nNode HTTP listener + connection lifecycle"]
    ACCESS["Access gate\nbootstrap vs session vs deny"]
    AUTH["Session service\nsecret verification + session semantics"]
    REPO["Session repository\ndurable session records"]
    PROXY["Proxy transport\nHTTP + WebSocket forwarding"]
    DSH["Injected DSH webServer"]
    STORAGE["Injected storageDomain"]

    IDX --> CFG
    IDX --> GW
    IDX --> REPO
    GW --> ACCESS
    ACCESS --> AUTH
    AUTH --> REPO
    GW --> PROXY
    PROXY --> DSH
    REPO --> STORAGE
```

### Ownership

- **Composition** owns Cordis integration and service acquisition.
- **Gateway transport** owns the public listener and accepted client sockets.
- **Access gate** decides only `bootstrap`, `allow`, or `deny` from request metadata and session state.
- **Session service** owns bootstrap verification, cookie/session semantics, expiry, and authority binding.
- **Session repository** owns durable storage of session records through `ctx.storageDomain`.
- **Proxy transport** owns protocol forwarding and HTTP/WebSocket sanitization; it does not decide authentication.

No IP allowlist component belongs to the current core design.

## Persistent session design

### Storage seam

Token-gate opens one dedicated DSH storage domain through `ctx.storageDomain` during plugin activation.

The domain contains a `sessions` table. Conceptually:

```text
SessionRecord {
  authority: string
  expiresAt: number
}
```

The session cookie carries an opaque random bearer value. The durable table key should be a stable one-way digest derived from that bearer value so the raw cookie credential does not need to be stored as durable data.

### Durability rule

A successful bootstrap must persist the new session record **before** returning the `303` response and cookie. Once the browser receives a successful bootstrap response, immediate process restart must not invalidate that newly issued session.

### Read path

The storage-domain facility loads durable records when the domain opens and serves reads from its authoritative in-memory view. Normal request authorization therefore does not require opening a database/file per HTTP request.

For each request:

1. read the cookie bearer value;
2. derive the repository key;
3. resolve the persisted session record;
4. reject absent or expired records;
5. require the recorded external authority to match the current request authority.

Expired-record cleanup may be lazy. Expiry enforcement is part of the authorization contract; the exact cleanup schedule is not.

### Lifecycle

The token-gate consumer owns its opened domain handle and closes it during Cordis disposal. Closing the domain releases runtime resources but **does not delete persisted session records**. On the next plugin/process instance, reopening the same domain restores still-valid sessions.

The persistence backend and its physical location remain host concerns rather than token-gate configuration.

## Data-flow diagram

```mermaid
flowchart LR
    B["External entity\nBrowser"]
    RP["External entity\nOptional deployment proxy"]
    PARSE["1. Parse external authority / trusted scheme"]
    ACCESS["2. Access decision"]
    BOOT["3. Bootstrap verification"]
    SESS["4. Session lookup / creation"]
    PX["5. Sanitize + proxy HTTP/WS"]
    DS[("Durable token-gate session domain")]
    DSH["External entity\nDSH Web on loopback"]

    B --> RP
    B -. local .-> PARSE
    RP --> PARSE
    PARSE --> ACCESS
    ACCESS -->|root bootstrap| BOOT
    BOOT -->|valid secret| SESS
    SESS -->|durable put before success| DS
    DS -->|lookup persisted session| SESS
    SESS -->|valid authority + expiry| ACCESS
    ACCESS -->|allow| PX
    ACCESS -->|deny| B
    SESS -->|303 + HttpOnly cookie| B
    PX -->|sanitized HTTP/WS| DSH
    DSH -->|response / upgrade| PX
    PX -->|transparent response / stream| B
```

### Sensitive-data flow

The bootstrap secret is used only to authorize bootstrap and must not be proxied to DSH. The session cookie is consumed by token-gate and removed before forwarding. Persisted session state contains the authorization metadata required to validate a cookie across restarts; the raw session bearer need not be persisted.

## UML class/dependency view

```mermaid
classDiagram
    class TokenGatePlugin {
      +apply(ctx, config) Promise~void~
    }

    class Gateway {
      +server Server
      +listen() Promise~void~
      +close() Promise~void~
    }

    class AccessGate {
      +decide(request) Decision
    }

    class SessionService {
      +authorizeBootstrap(secret) boolean
      +createSession(authority) Promise~Cookie~
      +hasSession(request, authority) boolean
    }

    class SessionRepository {
      +open() Promise~void~
      +get(sessionKey) SessionRecord?
      +put(sessionKey, record) Promise~void~
      +delete(sessionKey) Promise~void~
      +close() Promise~void~
    }

    class SessionRecord {
      +authority string
      +expiresAt number
    }

    class StorageDomain {
      +open(spec) Promise~Domain~
    }

    class ProxyTransport {
      +proxyHttp(...)
      +proxyUpgrade(...)
    }

    TokenGatePlugin --> Gateway
    TokenGatePlugin --> SessionRepository
    Gateway --> AccessGate
    AccessGate --> SessionService
    SessionService --> SessionRepository
    SessionRepository --> SessionRecord
    SessionRepository --> StorageDomain
    Gateway --> ProxyTransport
```

## UML sequence — first bootstrap

```mermaid
sequenceDiagram
    actor B as Browser
    participant G as Gateway
    participant A as AccessGate
    participant S as SessionService
    participant R as SessionRepository

    B->>G: GET /?token=<secret>
    G->>A: classify request
    A-->>G: bootstrap
    G->>S: authorizeBootstrap(secret)
    alt invalid
        S-->>G: denied
        G-->>B: opaque 404
    else valid
        S->>S: generate opaque session bearer
        S->>R: put(digest(bearer), authority + expiresAt)
        R-->>S: durable write complete
        S-->>G: session cookie
        G-->>B: 303 + HttpOnly cookie + clean Location
    end
```

## UML sequence — authorized request after restart

```mermaid
sequenceDiagram
    actor B as Browser
    participant G as New Gateway Process
    participant S as SessionService
    participant R as Reopened SessionRepository
    participant P as ProxyTransport
    participant D as DSH Web

    Note over G,R: plugin/process was restarted; persistent domain has been reopened
    B->>G: request + existing cookie
    G->>S: validate session(cookie, authority)
    S->>R: get(digest(cookie))
    R-->>S: authority + expiresAt
    S-->>G: valid
    G->>P: proxy authorized request
    P->>D: sanitized request
    D-->>P: HTTP/WS response
    P-->>B: transparent response
```

## UML sequence — WebSocket and disposal

```mermaid
sequenceDiagram
    actor B as Browser
    participant G as Gateway
    participant P as ProxyTransport
    participant D as DSH Web
    participant R as SessionRepository
    participant C as Cordis

    B->>G: authorized Upgrade request
    G->>P: proxyUpgrade(...)
    P->>D: sanitized Upgrade request
    D-->>P: 101 or ordinary HTTP rejection
    P-->>B: relay accepted/rejected result

    C->>G: dispose plugin
    G->>G: close listener + tracked client sockets
    C->>R: close opened token-gate domain
    R-->>C: runtime handle closed; durable records retained
```

## UML authorization state

```mermaid
stateDiagram-v2
    [*] --> Parsed
    Parsed --> Bootstrap: root request has bootstrap token
    Parsed --> SessionCheck: ordinary request
    Parsed --> Denied: malformed / invalid browser boundary

    Bootstrap --> Denied: secret invalid
    Bootstrap --> Persisting: secret valid
    Persisting --> SessionIssued: durable session write succeeds
    Persisting --> Denied: persistence fails
    SessionIssued --> [*]: 303 + cookie

    SessionCheck --> Allowed: persisted session exists + not expired + authority matches
    SessionCheck --> Denied: missing / expired / authority mismatch

    Allowed --> [*]: proxy HTTP/WS
    Denied --> [*]: opaque denial
```

## Current implementation delta

The code merged through PR #3 predates this Requirement/Architecture correction. Two known mismatches are intentionally visible rather than normalized into the design:

- session records are currently process-local instead of using `ctx.storageDomain`, so restart persistence required by R-003 is not yet implemented;
- the current code still contains IP allowlist/client-IP machinery, but IP allowlist authentication is not part of the current Requirement and should not shape core Spec or verification.

These are implementation gaps to be corrected downstream. They are not reasons to weaken Requirement or Architecture to match existing code.