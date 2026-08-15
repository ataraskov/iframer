const cheerio = require("cheerio");

// Builds the local proxy URL that stands in for an absolute upstream URL.
function toProxyUrl(absoluteUrl) {
  return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

function resolveAbsolute(maybeRelative, baseUrl) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return null;
  }
}

function rewriteUrl(rawValue, baseUrl) {
  if (!rawValue) return rawValue;
  const trimmed = rawValue.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("javascript:")
  ) {
    return rawValue;
  }
  const absolute = resolveAbsolute(trimmed, baseUrl);
  if (!absolute) return rawValue;
  return toProxyUrl(absolute);
}

// srcset is a comma-separated list of "<url> <descriptor>" pairs.
function rewriteSrcset(value, baseUrl) {
  if (!value) return value;
  return value
    .split(",")
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length === 0 || !parts[0]) return entry.trim();
      parts[0] = rewriteUrl(parts[0], baseUrl);
      return parts.join(" ");
    })
    .join(", ");
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function rewriteCssText(css, baseUrl) {
  return css.replace(CSS_URL_RE, (match, quote, url) => {
    const rewritten = rewriteUrl(url, baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  });
}

const URL_ATTRS = [
  ["a", "href"],
  ["link", "href"],
  ["script", "src"],
  ["img", "src"],
  ["source", "src"],
  ["video", "src"],
  ["video", "poster"],
  ["audio", "src"],
  ["iframe", "src"],
  ["embed", "src"],
  ["form", "action"],
];

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  for (const [tag, attr] of URL_ATTRS) {
    $(tag).each((_, el) => {
      const current = $(el).attr(attr);
      if (current) $(el).attr(attr, rewriteUrl(current, baseUrl));
    });
  }

  $("img, source").each((_, el) => {
    const current = $(el).attr("srcset");
    if (current) $(el).attr("srcset", rewriteSrcset(current, baseUrl));
  });

  $("[style]").each((_, el) => {
    const current = $(el).attr("style");
    if (current && current.includes("url(")) {
      $(el).attr("style", rewriteCssText(current, baseUrl));
    }
  });

  $("style").each((_, el) => {
    const current = $(el).html();
    if (current) $(el).html(rewriteCssText(current, baseUrl));
  });

  // Neutralize base tags so relative-URL resolution above stays correct,
  // and rewrite meta refresh redirects to go back through the proxy.
  $("base").remove();
  $('meta[http-equiv="refresh" i]').each((_, el) => {
    const content = $(el).attr("content");
    if (!content) return;
    const match = content.match(/^(\d+)\s*;\s*url=(.+)$/i);
    if (match) {
      const rewritten = rewriteUrl(match[2].trim(), baseUrl);
      $(el).attr("content", `${match[1]};url=${rewritten}`);
    }
  });

  return $.html();
}

module.exports = { toProxyUrl, rewriteHtml, rewriteCssText, resolveAbsolute };
