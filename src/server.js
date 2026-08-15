const express = require("express");
const path = require("path");
const { parseAllowedHosts, isAllowedHost, isSafeTargetUrl } = require("./allowlist");
const { rewriteHtml, rewriteCssText } = require("./rewrite");
const { initAdblock, isBlockedUrl } = require("./adblock");

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS || "glosbe.com");
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const MAX_REDIRECTS = 5;
const UPSTREAM_USER_AGENT =
  process.env.UPSTREAM_USER_AGENT ||
  "Mozilla/5.0 (compatible; iframer-proxy/1.0; +https://github.com/)";

// Response headers that would otherwise re-block framing, or that don't
// make sense to forward once we've rewritten/decoded the body ourselves.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "set-cookie",
  "strict-transport-security",
]);

const SEC_FETCH_DEST_TO_TYPE = {
  document: "other",
  iframe: "sub_frame",
  image: "image",
  script: "script",
  style: "stylesheet",
  audio: "media",
  video: "media",
  font: "font",
  empty: "xmlhttprequest",
};

function guessResourceType(req) {
  return SEC_FETCH_DEST_TO_TYPE[req.headers["sec-fetch-dest"]] || "other";
}

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/proxy", async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string") {
    return res.status(400).send("Missing required 'url' query parameter.");
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return res.status(400).send("Invalid URL.");
  }

  if (!isSafeTargetUrl(target)) {
    return res.status(400).send("Refusing to proxy that target.");
  }
  if (!isAllowedHost(target.hostname, ALLOWED_HOSTS)) {
    return res
      .status(403)
      .send(
        `Host '${target.hostname}' is not in ALLOWED_HOSTS. ` +
          `Allowed: ${ALLOWED_HOSTS.join(", ") || "(none configured)"}`
      );
  }

  // Defense in depth: catches requests that reach /proxy directly (e.g. an
  // already-proxied ad URL a page's own script re-requested) even though
  // rewriteHtml already strips known ad/tracker references from the HTML.
  let sourceUrl;
  try {
    sourceUrl = req.headers.referer
      ? new URL(req.headers.referer).searchParams.get("url") || undefined
      : undefined;
  } catch {
    sourceUrl = undefined;
  }
  if (isBlockedUrl(target.toString(), { sourceUrl, type: guessResourceType(req) })) {
    return res.status(204).end();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": UPSTREAM_USER_AGENT,
        Accept: req.headers.accept || "text/html,*/*",
        "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
      },
    });

    const finalUrl = upstreamResponse.url || target.toString();
    const contentType = upstreamResponse.headers.get("content-type") || "";

    for (const [key, value] of upstreamResponse.headers.entries()) {
      if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    res.status(upstreamResponse.status);

    if (contentType.includes("text/html")) {
      const body = await upstreamResponse.text();
      const rewritten = rewriteHtml(body, finalUrl);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(rewritten);
    }

    if (contentType.includes("text/css")) {
      const body = await upstreamResponse.text();
      const rewritten = rewriteCssText(body, finalUrl);
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      return res.send(rewritten);
    }

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).send("Upstream request timed out.");
    }
    console.error("Proxy error for", target.toString(), err);
    return res.status(502).send("Failed to fetch upstream resource.");
  } finally {
    clearTimeout(timeout);
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

initAdblock().finally(() => {
  app.listen(PORT, () => {
    console.log(`iframer proxy listening on :${PORT}`);
    console.log(`Allowed hosts: ${ALLOWED_HOSTS.join(", ") || "(none configured)"}`);
  });
});
