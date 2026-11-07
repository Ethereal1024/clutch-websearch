"use strict";

// The transport: settings, one bounded request, one public-host fence.
//
// Everything here is stdlib (node 18+ `fetch`, `dns`, `net`): this file is shipped
// to the phone's embedded node as well, where there is no npm tree. Four promises
// are the contract every caller relies on:
//
//   * bounded in TIME — every request carries `AbortSignal.timeout`, and a GET is
//     retried exactly once on a timeout (a heavy page times out sporadically; a
//     POST is never replayed, and neither is a failure a retry cannot help);
//   * bounded in BYTES — the body is read in chunks and the read is abandoned the
//     moment it passes `maxBytes`, so a 2 GB tar is refused rather than swallowed;
//   * a non-public destination is refused — loopback, LAN, link-local, CGNAT,
//     multicast, reserved — and a REDIRECT is re-checked against the same rule,
//     because a public host answering `Location: http://127.0.0.1:8890/` is the
//     cheapest way to reach the machine the model is running on;
//   * a failure is a `WebError` carrying a reason, never a rejected fetch
//     primitive leaking "fetch failed" with the real code buried in `cause`.
//
// The fence is a guard against honest mistakes, not a sandbox: it resolves, then
// connects, so a DNS-rebinding race is possible and the operator's escape hatch
// (`CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS`) opens it deliberately. Search endpoints
// are operator-configured (the operator named the URL), so they pass
// `allowPrivate: true`; a URL that came out of the model's own mouth does not.

const dns = require("dns");
const net = require("net");

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36 ClutchAgent/0.2";
// English-first: a localized default silently steers every keyless lookup into a
// regional market. Per-request overrides win.
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9,*;q=0.5";
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// A request-level failure: DNS, timeout, size cap, private host, HTTP status.
class WebError extends Error {}

// ---- settings ---------------------------------------------------------------

function env(name, ...fallbacks) {
  for (const key of [name, ...fallbacks]) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function amount(text, fallback) {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// One read per call: this process exists for one call, so a fresh read is the
// only honest one (a fork's environment is fixed for its lifetime anyway).
function settings() {
  return {
    timeout: amount(env("CLUTCH_WEBSEARCH_TIMEOUT"), 15),
    maxResults: Math.trunc(amount(env("CLUTCH_WEBSEARCH_MAX_RESULTS"), 8)),
    maxChars: Math.trunc(amount(env("CLUTCH_WEBSEARCH_MAX_CHARS"), 20000)),
    maxBytes: Math.trunc(amount(env("CLUTCH_WEBSEARCH_MAX_BYTES"), 2000000)),
    tavilyApiKey: env("CLUTCH_TAVILY_API_KEY", "TAVILY_API_KEY"),
    tavilyUrl: env("CLUTCH_TAVILY_URL") || "https://api.tavily.com/search",
    searxngUrl: env("CLUTCH_SEARXNG_URL", "SEARXNG_URL").replace(/\/+$/, ""),
    bingUrl: env("CLUTCH_BING_URL") || "https://www.bing.com/search",
    ddgUrl: env("CLUTCH_DDG_URL") || "https://html.duckduckgo.com/html/",
    allowPrivateHosts: /^(1|true|yes|on)$/i.test(env("CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS")),
  };
}

// ---- the fence --------------------------------------------------------------

// IPv4 blocks that are not a destination on the public internet.
const V4_BLOCKS = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function v4Value(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function v4IsPublic(address) {
  const value = v4Value(address);
  if (value === null) return false;
  for (const [base, bits] of V4_BLOCKS) {
    const size = 2 ** (32 - bits);
    if (Math.floor(value / size) === Math.floor(v4Value(base) / size)) return false;
  }
  return true;
}

function v6IsPublic(address) {
  const text = String(address).replace(/^\[|\]$/g, "").toLowerCase();
  if (text === "::" || text === "::1") return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return v4IsPublic(mapped[1]);
  if (/^fe[89ab]/.test(text)) return false; // link-local fe80::/10
  if (/^f[cd]/.test(text)) return false; // unique-local fc00::/7
  if (/^ff/.test(text)) return false; // multicast
  const head = parseInt(text.split(":")[0] || "0", 16);
  return head >= 0x2000 && head <= 0x3fff; // global unicast 2000::/3
}

function isPublicAddress(address) {
  const text = String(address).replace(/^\[|\]$/g, "");
  return net.isIP(text) === 6 ? v6IsPublic(text) : v4IsPublic(text);
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch (e) {
    return "";
  }
}

// Refuse non-public destinations. A literal address is judged locally, never
// through the resolver: asking DNS about 127.0.0.1 both hangs when the resolver is
// dead and lets a lying resolver through.
async function assertPublicHost(url) {
  const host = hostOf(url);
  if (!host) throw new WebError(`URL has no host: ${JSON.stringify(String(url))}`);
  if (host === "localhost" || /\.(localhost|local|internal)$/i.test(host)) {
    throw new WebError(`non-public host refused: ${host}`);
  }
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (!isPublicAddress(bare)) throw new WebError(`non-public host refused: ${host}`);
    return;
  }
  let rows;
  try {
    rows = await dns.promises.lookup(bare, { all: true, verbatim: true });
  } catch (e) {
    throw new WebError(`cannot resolve host ${JSON.stringify(bare)}: ${(e && (e.code || e.message)) || e}`);
  }
  for (const row of rows || []) {
    if (!isPublicAddress(row.address)) throw new WebError(`non-public host refused: ${host} (${row.address})`);
  }
}

// ---- one request ------------------------------------------------------------

async function discard(response) {
  try {
    if (response && response.body) await response.body.cancel();
  } catch (e) {
    /* the body is already gone; the caller has the reason it needs */
  }
}

function reasonOf(e, timeout) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return `timed out after ${timeout}s`;
  const cause = e && e.cause;
  const reason = (cause && (cause.code || cause.message)) || (e && (e.code || e.message)) || e;
  return String(reason || "request failed");
}

async function open(rawUrl, options) {
  const { method, body, headers, timeout, maxBytes, allowPrivate } = options;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch (e) {
      throw new WebError(`invalid URL ${JSON.stringify(String(current))}`);
    }
    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") {
      throw new WebError(`unsupported URL scheme ${JSON.stringify(scheme.replace(":", ""))} (http/https only)`);
    }
    if (!allowPrivate) await assertPublicHost(current);

    let response;
    try {
      response = await fetch(current, {
        method,
        body,
        // No `Accept-Encoding` here on purpose: set by hand, undici stops
        // decompressing. Left alone, `fetch` negotiates and decodes gzip/deflate
        // itself, so the body this file sees is already text.
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
          ...headers,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.round(timeout * 1000)),
      });
    } catch (e) {
      throw new WebError(reasonOf(e, timeout));
    }

    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location") || "";
      await discard(response);
      if (!location) throw new WebError(`HTTP ${response.status} from ${current} with no Location`);
      if (method !== "GET") throw new WebError(`HTTP ${response.status} from ${current}`);
      if (hop === MAX_REDIRECTS) throw new WebError(`too many redirects from ${rawUrl}`);
      try {
        current = new URL(location, current).href;
      } catch (e) {
        throw new WebError(`redirect to an unusable location ${JSON.stringify(location)} from ${current}`);
      }
      continue;
    }
    if (!response.ok) {
      await discard(response);
      throw new WebError(`HTTP ${response.status} from ${current}`);
    }

    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      await discard(response);
      throw new WebError(`response exceeds ${maxBytes} bytes`);
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) throw new WebError(`response exceeds ${maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      if (e instanceof WebError) throw e;
      throw new WebError(`reading the response failed: ${(e && (e.code || e.message)) || e}`);
    }
    return {
      url: current,
      contentType: response.headers.get("content-type") || "",
      body: Buffer.concat(chunks),
    };
  }
  throw new WebError(`too many redirects from ${rawUrl}`);
}

// One bounded request, with a single retry on timeout (GET only).
async function httpGet(url, options = {}) {
  const resolved = {
    method: "GET",
    body: undefined,
    headers: {},
    timeout: 15,
    maxBytes: 2000000,
    allowPrivate: false,
    retries: 1,
    ...options,
  };
  const attempts = 1 + (resolved.method === "GET" ? resolved.retries : 0);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await open(url, resolved);
    } catch (e) {
      if (!(e instanceof WebError) || attempt + 1 >= attempts || !/timed out/.test(e.message)) throw e;
    }
  }
}

// ---- bytes -> text ----------------------------------------------------------

const CHARSET_RE = /charset=["']?([\w\-:+.]+)/i;
const META_CHARSET_RE = /<meta[^>]+charset=["']?([\w\-:+.]+)/i;

function decodeWith(raw, label) {
  try {
    return new TextDecoder(label, { fatal: false }).decode(raw);
  } catch (e) {
    return null; // an unknown label is not a reason to lose the page
  }
}

// Header charset, then a meta sniff, then a BOM, then utf-8, then windows-1252
// (which never fails, so decoding cannot raise).
function decodeBody(raw, contentType) {
  let charset = (CHARSET_RE.exec(contentType || "") || [])[1];
  if (!charset) {
    const head = raw.subarray(0, 4096).toString("latin1");
    charset = (META_CHARSET_RE.exec(head) || [])[1] || "";
  }
  if (charset) {
    const text = decodeWith(raw, charset);
    if (text !== null) return text;
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return decodeWith(raw, "utf-16le") || "";
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return decodeWith(raw, "utf-16be") || "";
  const utf8 = decodeWith(raw, "utf-8");
  if (utf8 !== null && !utf8.includes("\ufffd")) return utf8;
  return decodeWith(raw, "windows-1252") || utf8 || "";
}

// One line out of a reason: the whole of what a caller can act on, in the space
// a result has for it.
function short(reason) {
  // `.message`, not `String(error)`: JavaScript prefixes the class name, and a
  // result line reading "ERROR: Error: …" wastes the two words it has.
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

module.exports = {
  DEFAULT_ACCEPT_LANGUAGE,
  USER_AGENT,
  WebError,
  assertPublicHost,
  decodeBody,
  httpGet,
  isPublicAddress,
  settings,
  short,
};
