const fs = require("fs/promises");
const path = require("path");
const { FiltersEngine, Request } = require("@ghostery/adblocker");

const ENABLED = (process.env.ADBLOCK_ENABLED ?? "true").toLowerCase() !== "false";
const CACHE_PATH =
  process.env.ADBLOCK_CACHE_PATH || path.join(__dirname, "..", ".cache", "adblock-engine.bin");

const caching = {
  path: CACHE_PATH,
  async read(cachePath) {
    return new Uint8Array(await fs.readFile(cachePath));
  },
  async write(cachePath, buffer) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, buffer);
  },
};

let engine = null;
let initPromise = null;

// Downloads (or loads from cache) Ghostery's pre-built EasyList +
// EasyPrivacy engine. Must be awaited once before the server starts
// accepting requests. Failure disables filtering for this run rather
// than crashing the proxy - ads are a nice-to-have to block, not a
// reason to take the whole site down.
async function initAdblock() {
  if (!ENABLED || engine) return;
  if (!initPromise) {
    initPromise = FiltersEngine.fromPrebuiltAdsAndTracking(fetch, caching)
      .then((loaded) => {
        engine = loaded;
      })
      .catch((err) => {
        console.error("adblock: failed to initialize filter engine, ad filtering disabled:", err);
      });
  }
  await initPromise;
}

function registrableDomain(hostname) {
  const labels = hostname.split(".");
  return labels.length <= 2 ? hostname : labels.slice(-2).join(".");
}

// resourceType follows the adblocker engine's WebRequestType strings
// (e.g. "script", "image", "stylesheet", "sub_frame", "media", "other").
function isBlockedUrl(url, { sourceUrl, type = "other" } = {}) {
  if (!ENABLED || !engine) return false;
  try {
    const target = new URL(url);
    const source = sourceUrl ? new URL(sourceUrl) : target;
    const request = Request.fromRawDetails({
      url: target.toString(),
      hostname: target.hostname,
      domain: registrableDomain(target.hostname),
      sourceUrl: source.toString(),
      sourceHostname: source.hostname,
      sourceDomain: registrableDomain(source.hostname),
      type,
    });
    return engine.match(request).match;
  } catch {
    return false;
  }
}

// CSS to hide known ad containers on this page, even when nothing about
// them was network-blockable (e.g. first-party markup for an ad slot).
function getCosmeticsForUrl(url) {
  if (!ENABLED || !engine) return "";
  try {
    const target = new URL(url);
    const { styles } = engine.getCosmeticsFilters({
      url: target.toString(),
      hostname: target.hostname,
      domain: registrableDomain(target.hostname),
      getBaseRules: true,
      getInjectionRules: true,
      getRulesFromHostname: true,
    });
    return styles || "";
  } catch {
    return "";
  }
}

module.exports = { initAdblock, isBlockedUrl, getCosmeticsForUrl };
