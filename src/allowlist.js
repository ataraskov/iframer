// Restricts which upstream hosts the proxy will fetch, so this can't be
// abused as an open proxy / SSRF pivot. Configure via ALLOWED_HOSTS.
const net = require("net");

function parseAllowedHosts(raw) {
  return (raw || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(hostname, allowed) {
  const h = hostname.toLowerCase();
  return h === allowed || h.endsWith(`.${allowed}`);
}

function isAllowedHost(hostname, allowedHosts) {
  if (allowedHosts.includes("*")) return true;
  return allowedHosts.some((allowed) => hostMatches(hostname, allowed));
}

// Blocks obviously-private/loopback/link-local targets even if somehow
// listed, and blocks non-http(s) schemes and credentials-in-URL tricks.
function isSafeTargetUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (hostname === "0.0.0.0" || hostname === "::1") return false;

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return false;
  }

  return true;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  // Conservative IPv6 checks: loopback, link-local, unique-local.
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

module.exports = { parseAllowedHosts, isAllowedHost, isSafeTargetUrl };
