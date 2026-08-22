# Security model

`dsh-token-gate` is an authentication boundary in front of a loopback-only DeepSeek Harness Web Server. It is intended to sit behind an HTTPS reverse proxy and to make possession of the configured bootstrap token equivalent to administrative access to the DSH Web surface.

## Trust boundary

```text
Internet browser
      |
      | HTTPS
      v
reverse proxy
      |
      | HTTP on a trusted local/private hop
      v
dsh-token-gate
      |
      | rewritten loopback Host / Origin
      v
DSH 127.0.0.1:<port>
```

The DSH upstream must remain bound to `127.0.0.1`. The gateway defaults to `127.0.0.1` as well; expose it through a reverse proxy unless a private-network deployment explicitly requires another bind address.

## Credential authority

A valid token is an administrator credential. After token bootstrap, the gateway authenticates the browser and rewrites the accepted request to the loopback DSH authority. Consequently, DSH operations that are normally protected only by its loopback/browser-trust fence can be reachable through an authenticated token-gate session.

This is deliberate: token-gate supplies the authentication layer that the bare DSH server does not provide. Deployments that need a reduced remote capability set must add a separate authorization policy; token-gate currently does not provide per-method roles or scopes.

Treat the token like a host-control secret:

- generate a high-entropy random value;
- provide it through `DSH_AUTH_TOKEN` or another private configuration layer;
- never commit it to the repository;
- distribute bootstrap links only to administrators;
- rotate it after suspected disclosure.

## Browser boundary

Before any internal Host/Origin rewrite, the gateway validates the external authority, `Origin`, and Fetch Metadata. Sessions are bound to the external authority used during bootstrap. IP allowlist access passes the same browser/Host fence.

Ordinary authenticated HTTP and WebSocket requests reject explicit `Sec-Fetch-Site: cross-site` traffic. Bootstrap is accepted only on the literal root request target `/?token=...`. To preserve clickable share links, bootstrap has one narrow Fetch-Metadata exception: a cross-site request may proceed to token verification only when it is a user-activated top-level document navigation (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, `Sec-Fetch-User: ?1`) and carries no conflicting `Origin`.

Cross-site fetch/XHR, iframe navigation, non-user-activated navigation, cross-origin `Origin`, malformed request targets, absolute-form targets, and scheme-relative targets fail closed. The exception does not grant access by itself; the bootstrap token must still validate before a session is created.

## HTTPS and cookies

The gateway itself is plain HTTP. Production traffic must terminate HTTPS at the reverse proxy. Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` by default. Set `secureCookie: false` only for explicit local-development HTTP use.

For HTTPS deployments, configure the direct reverse proxy in `trustedProxies` so the gateway can validate `X-Forwarded-Proto` and resolve the X-Forwarded-For chain. Forwarded metadata from an untrusted socket peer is ignored.

`CF-Connecting-IP` is never used for authorization or rate-limit identity. Cloudflare deployments should normalize the client chain at the reverse proxy and pass a trustworthy `X-Forwarded-For` chain to token-gate.

## Availability bounds

Session and rate-limit maps have fixed cardinality limits. At capacity they evict the least-recently-used entry, preserving the memory bound without turning capacity into a global authentication lockout. Existing sessions can therefore be evicted under extreme churn; this is an availability tradeoff, not an authorization grant.

Gateway shutdown destroys and awaits owned HTTP and upgraded sockets. Upstream response aborts terminate the downstream connection rather than leaving a partial response hanging.

## Opaque unauthenticated surface

Ordinary unauthenticated requests, invalid bootstrap attempts, malformed request targets, Node HTTP parser errors, unsupported `Expect` requests, and `CONNECT` requests are kept on the same minimal response shape where an HTTP response is possible:

```text
404 page not found
```

The gateway explicitly owns `Expect: 100-continue`: it sends `100 Continue` only after an ordinary request has passed access control, then removes `Expect` before forwarding upstream. This prevents Node's automatic pre-authentication `100 Continue` or `417 Expectation Failed` behavior from creating a distinguishable unauthenticated surface.

WebSocket requests that fail authorization are closed without proxying.

## Deployment assumptions

The security model assumes all of the following:

- DSH remains bound to `127.0.0.1`;
- public traffic reaches token-gate, never the DSH port directly;
- external traffic uses HTTPS;
- the reverse proxy overwrites/manages forwarded metadata before token-gate trusts it;
- reverse-proxy/CDN logs redact or omit the `token` query parameter;
- anyone who knows the bootstrap token is authorized for administrative DSH access.

A deployment that violates one of these assumptions is outside the supported security boundary.
