const cheerio = require("cheerio");
const { isBlockedUrl, getCosmeticsForUrl } = require("./adblock");

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

// Returns null when the resolved URL is a known ad/tracker resource,
// signalling callers to drop the reference instead of proxying it.
function rewriteUrl(rawValue, baseUrl, resourceType = "other") {
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
  if (isBlockedUrl(absolute, { sourceUrl: baseUrl, type: resourceType })) return null;
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
      const rewritten = rewriteUrl(parts[0], baseUrl, "image");
      if (rewritten === null) return null;
      parts[0] = rewritten;
      return parts.join(" ");
    })
    .filter((entry) => entry !== null)
    .join(", ");
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function rewriteCssText(css, baseUrl) {
  return css.replace(CSS_URL_RE, (match, quote, url) => {
    const rewritten = rewriteUrl(url, baseUrl, "image");
    if (rewritten === null) return "url()";
    return `url(${quote}${rewritten}${quote})`;
  });
}

// Tags whose element should be dropped entirely when blocked (they carry
// no meaningful content of their own), plus the resource type used for
// filter matching. "a"/"form" are handled separately: blocking there
// clears the link/action instead of removing surrounding text content.
const URL_ATTRS = [
  ["link", "href", "stylesheet"],
  ["script", "src", "script"],
  ["img", "src", "image"],
  ["source", "src", "media"],
  ["video", "src", "media"],
  ["video", "poster", "image"],
  ["audio", "src", "media"],
  ["iframe", "src", "sub_frame"],
  ["embed", "src", "object"],
];

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  for (const [tag, attr, resourceType] of URL_ATTRS) {
    $(tag).each((_, el) => {
      const current = $(el).attr(attr);
      if (!current) return;
      const rewritten = rewriteUrl(current, baseUrl, resourceType);
      if (rewritten === null) {
        $(el).remove();
      } else {
        $(el).attr(attr, rewritten);
      }
    });
  }

  for (const [tag, attr] of [
    ["a", "href"],
    ["form", "action"],
  ]) {
    $(tag).each((_, el) => {
      const current = $(el).attr(attr);
      if (!current) return;
      const rewritten = rewriteUrl(current, baseUrl, "other");
      if (rewritten === null) {
        $(el).removeAttr(attr);
      } else {
        $(el).attr(attr, rewritten);
      }
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
      const rewritten = rewriteUrl(match[2].trim(), baseUrl, "other");
      if (rewritten === null) {
        $(el).remove();
      } else {
        $(el).attr("content", `${match[1]};url=${rewritten}`);
      }
    }
  });

  const cosmetics = getCosmeticsForUrl(baseUrl);
  if (cosmetics) {
    $("head").append(`<style>${cosmetics}</style>`);
  }

  return $.html();
}

module.exports = { toProxyUrl, rewriteHtml, rewriteCssText, resolveAbsolute };
