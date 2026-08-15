# iframer

A small Dockerized reverse proxy that lets you embed sites in an `<iframe>`
even when they send `X-Frame-Options` / `Content-Security-Policy:
frame-ancestors` headers that would normally block framing.

Example use case: embedding `https://glosbe.com/sr/ru/{word}` as an
in-page dictionary lookup, even though Glosbe blocks framing.

## How it works

Browsers enforce `X-Frame-Options` and CSP `frame-ancestors` client-side,
based on the headers the *target site* sends back. There is no way to
override that from the embedding page. The workaround is a server-side
proxy:

1. Your page puts the proxy's URL in the iframe, e.g.
   `/proxy?url=https://glosbe.com/sr/ru/dog` — never the target site's URL
   directly.
2. The proxy (`src/server.js`) fetches that URL itself (server-to-server,
   no browser involved) and gets the real HTML/CSS/JS/images back.
3. It strips `X-Frame-Options` and `Content-Security-Policy` from the
   response before returning it, so the browser has nothing telling it to
   refuse the iframe.
4. It rewrites every link, script, stylesheet, image, form action, etc.
   (`src/rewrite.js`) in the HTML/CSS so they also point back through
   `/proxy?url=...` instead of straight at the target site. This keeps
   navigation, styling, and assets working while everything continues to
   flow through the proxy.

The browser only ever talks to your own origin — the target site is never
loaded directly by the browser, so its anti-framing headers never apply.

## Running it

```bash
docker compose up --build
```

Then open `http://localhost:8080` — the bundled demo page
(`public/index.html`) lets you type a word and embeds
`https://glosbe.com/{from}/{to}/{word}` via the proxy.

To embed it in your own app, just point an iframe at:

```html
<iframe src="http://localhost:8080/proxy?url=https://glosbe.com/sr/ru/dog"></iframe>
```

## Ad filtering

DNS-level ad blocking (Pi-hole, AdGuard Home, NextDNS, etc.) doesn't work
against a proxied iframe: ad/tracker domains are resolved and fetched by
*this container*, not by the browser or the user's own DNS, and
`rewriteUrl` in `src/rewrite.js` collapses every third-party URL —
including ad domains — down to `/proxy?url=...` before the browser ever
sees it. A DNS blackhole never gets a hostname to block.

So filtering runs inside the proxy instead, via `src/adblock.js`, using
[`@ghostery/adblocker`](https://github.com/ghostery/adblocker) loaded with
the same EasyList + EasyPrivacy filter lists uBlock Origin uses:

- **Network filtering**: `rewriteHtml` drops `<script>`/`<img>`/`<iframe>`/
  etc. tags (and clears `<a href>`/`<form action>`) whose resolved URL
  matches a known ad/tracker filter, instead of proxying them.
- A second check in the `/proxy` route itself blocks matching requests
  even if they reach the proxy some other way (defense in depth).
- **Cosmetic filtering**: a `<style>` block of EasyList's hide-selectors
  for the page's domain is injected into `<head>`, to hide leftover ad
  containers that weren't a blockable network request.

The compiled filter engine is cached to disk (`ADBLOCK_CACHE_PATH`, a
Docker volume by default — see `docker-compose.yml`) so lists aren't
re-fetched on every restart.

**Known gap**: JavaScript on the proxied page that dynamically builds and
calls `fetch()`/`XHR` against a third-party URL at runtime (rather than a
static `src`/`href` in the HTML) never goes through `/proxy` at all — the
browser would attempt to hit that URL directly. This is a limitation of
any rewrite-based proxy, not specific to the filtering above; most ad
delivery still goes through the static tags this proxy already rewrites.

## Configuration

Set via environment variables (see `docker-compose.yml`):

| Variable              | Default        | Purpose                                                            |
|-----------------------|----------------|---------------------------------------------------------------------|
| `PORT`                | `8080`         | Port the server listens on.                                        |
| `ALLOWED_HOSTS`       | `glosbe.com`   | Comma-separated host allowlist. Subdomains match automatically.    |
| `REQUEST_TIMEOUT_MS`  | `15000`        | Upstream fetch timeout.                                            |
| `UPSTREAM_USER_AGENT` | a default UA   | User-Agent sent to the upstream site.                              |
| `ADBLOCK_ENABLED`     | `true`         | Set to `false` to disable ad/tracker filtering entirely.           |
| `ADBLOCK_CACHE_PATH`  | `.cache/adblock-engine.bin` | Where the compiled EasyList/EasyPrivacy engine is cached. |

To also proxy other sites, add them to `ALLOWED_HOSTS`, e.g.
`ALLOWED_HOSTS=glosbe.com,en.wiktionary.org`.

**`ALLOWED_HOSTS` is a security control, not just config** — without it
this would be an open proxy that anyone on your network could point at
arbitrary internal or external URLs (SSRF). Only add hosts you actually
intend to embed. `src/allowlist.js` also rejects loopback/private-IP and
non-http(s) targets outright, even if a hostname resolves there.

## Known limitations (MVP scope)

- Only `GET` requests are proxied — fine for read-only content like a
  dictionary, not for sites requiring form POSTs or login.
- `Set-Cookie` from upstream is dropped, so session/login-dependent sites
  won't work. Anonymous/public pages (like Glosbe lookups) are unaffected.
- Inline JavaScript that constructs URLs at runtime (rather than via
  static `src`/`href` attributes) isn't rewritten, so some highly dynamic
  sites may still break even once framing is unblocked.
- No response caching; every request re-fetches from upstream.

## Project layout

```
src/server.js     Express app: /proxy route, header handling, allowlist enforcement
src/rewrite.js     HTML/CSS URL rewriting so navigation stays inside the proxy
src/allowlist.js   Host allowlist + SSRF guardrails
src/adblock.js     EasyList/EasyPrivacy-based ad/tracker filtering
public/index.html  Demo page embedding the Glosbe dictionary
Dockerfile
docker-compose.yml
```
