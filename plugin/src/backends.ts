"use strict";

// The search chain, ported from the Python module this plugin replaces: tavily
// (if a key), searxng (if a URL), bing, ddg — first success wins, and every
// failure is DATA (`{error, failures}`), so a degradation is visible instead of
// silent.
//
// Two things about this chain are contract, not implementation detail:
//
//   * the relevance guard. A SCRAPED backend (bing's RSS, ddg's html) can answer
//     from the wrong market or after a layout drift without failing; a ranked API
//     cannot. So a scraped answer whose top results share no term with the query
//     is an error that FALLS THROUGH, which is what stopped bing answering
//     English niche queries with unrelated Chinese pages;
//   * the available list is derived, never assumed: an unconfigured service does
//     not exist on this machine (no name, no install advice) — the error names the
//     backends that do, because that is the list a `backend=` pin can use.

import type { Fetched, RequestOptions, Settings } from "./http";
import type { SearchResult } from "./html";

// The two neighbours, announced with the shapes their interfaces publish: these
// are CommonJS modules (`module.exports = …`), which the compiler cannot read a
// module shape off, so the contract is written here where its callers use it.
const { WebError, decodeBody, httpGet, settings, short } = require("./http") as {
  WebError: new (message: string) => Error;
  decodeBody: (raw: Buffer, contentType: string) => string;
  httpGet: (url: string, options?: RequestOptions) => Promise<Fetched>;
  settings: () => Settings;
  short: (reason: unknown) => string;
};
const { cleanSnippet, parseBingRss, parseDdg } = require("./html") as {
  cleanSnippet: (text: string) => string;
  parseBingRss: (xml: string) => SearchResult[] | null;
  parseDdg: (html: string) => SearchResult[];
};

// A backends' own failure: it answered (or did not), and what came back did not
// become a result list.
class BackendError extends Error {}

// ---- the relevance guard ----------------------------------------------------

const STOPWORDS = new Set(
  `a an and are as at be by do does for from has have how in into is it its of on or that the this
  to was were what when where which who why with site`.split(/\s+/)
);
const WORD_RE = /[a-z0-9][a-z0-9_+.\-]*/g;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

// What one query means as terms: ASCII words worth matching, and CJK bigrams
// (a script without spaces still has repeated two-character sequences).
interface Terms {
  words: Set<string>;
  grams: Set<string>;
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

// (ASCII tokens, CJK bigrams) — what a relevant result should echo back.
function queryTerms(query: string): Terms {
  const low = String(query).toLowerCase();
  const words = new Set((low.match(WORD_RE) || []).filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
  const grams = new Set<string>();
  for (const run of low.match(CJK_RE) || []) {
    if (run.length === 1) grams.add(run);
    else for (let i = 0; i + 2 <= run.length; i += 1) grams.add(run.slice(i, i + 2));
  }
  return { words, grams };
}

// True when at least one of the top results shares a term with the query. The bar
// is deliberately low (any shared token, not a score): it exists to turn "wrong
// market / drifted layout" into an error, not to rank. A query whose only terms
// are stopwords is never judged.
function looksRelevant(query: string, results: SearchResult[], top = 5): boolean {
  const { words, grams } = queryTerms(query);
  if (!words.size && !grams.size) return true;
  for (const result of results.slice(0, top)) {
    const hay = `${result.title || ""} ${result.url || ""} ${result.snippet || ""}`.toLowerCase();
    const seen = new Set(hay.match(WORD_RE) || []);
    for (const word of words) if (seen.has(word)) return true;
    for (const gram of grams) if (hay.includes(gram)) return true;
  }
  return false;
}

// ---- the backends: (query, limit, settings, get) -> [{title,url,snippet}] -----

// One request as the chain must make it: every endpoint is operator-configured,
// so a self-hosted searxng on the LAN is a legitimate destination.
type GetFn = (url: string, options?: RequestOptions) => Promise<Fetched>;
type SearchFn = (query: string, limit: number, s: Settings, get: GetFn) => Promise<SearchResult[]>;

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

// tavily and searxng publish the same shape: {results: [{title,url,content}]}.
function ranked(response: Fetched, name: string, limit: number, hint = ""): SearchResult[] {
  let data;
  try {
    data = JSON.parse(decodeBody(response.body, response.contentType));
  } catch (e) {
    throw new BackendError(`${name} returned non-JSON body${hint}: ${e.message}`);
  }
  const rows = Array.isArray(data && data.results) ? data.results : [];
  const out = rows
    .filter((row) => row && typeof row === "object" && row.url)
    .map((row) => ({
      title: String(row.title || "").trim(),
      url: String(row.url || "").trim(),
      snippet: cleanSnippet(String(row.content || "")),
    }))
    .slice(0, limit);
  if (!out.length) throw new BackendError("response had no usable results");
  return out;
}

async function tavily(query: string, limit: number, s: Settings, get: GetFn): Promise<SearchResult[]> {
  const response = await get(s.tavilyUrl, {
    method: "POST",
    body: JSON.stringify({ query, max_results: limit }),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.tavilyApiKey}`,
      Accept: "application/json",
    },
  });
  return ranked(response, "tavily", limit);
}

async function searxng(query: string, limit: number, s: Settings, get: GetFn): Promise<SearchResult[]> {
  const url = withQuery(`${s.searxngUrl}/search`, { q: query, format: "json" });
  const response = await get(url, { headers: { Accept: "application/json" } });
  return ranked(response, "searxng", limit, " (format=json enabled?)");
}

// One market's request parameters, both halves of the same decision: bing reads
// `mkt`/`setlang` from the URL and `Accept-Language` from the header, and they
// must agree or it answers in one language and links in another.
interface Market {
  params: Record<string, string>;
  language: string;
}

// Market/language params follow the query's script: a hardcoded regional
// preference is what made bing answer English niche queries with Chinese pages.
function bingMarket(query: string): Market {
  if (hasCjk(query)) {
    return { params: { mkt: "zh-CN", setlang: "zh-hans" }, language: "zh-CN,zh;q=0.9,en;q=0.8" };
  }
  return { params: { mkt: "en-US", setlang: "en", ensearch: "1" }, language: "en-US,en;q=0.9" };
}

async function bing(query: string, limit: number, s: Settings, get: GetFn): Promise<SearchResult[]> {
  const market = bingMarket(query);
  const url = withQuery(s.bingUrl, { q: query, format: "rss", count: String(Math.min(limit, 30)), ...market.params });
  const response = await get(url, {
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "Accept-Language": market.language,
    },
  });
  const items = parseBingRss(decodeBody(response.body, response.contentType));
  if (items === null) throw new BackendError("bing RSS is not parseable XML");
  const out = items.slice(0, limit);
  if (!out.length) throw new BackendError("no items in the RSS (blocked, or genuinely no results)");
  return out;
}

async function ddg(query: string, limit: number, s: Settings, get: GetFn): Promise<SearchResult[]> {
  const response = await get(withQuery(s.ddgUrl, { q: query }));
  const out = parseDdg(decodeBody(response.body, response.contentType))
    .filter((row) => row.url)
    .slice(0, limit);
  if (!out.length) throw new BackendError("no results parsed (bot-checked, blocked, or layout changed)");
  return out;
}

// One entry of the chain: a name (the word a `backend=` pin uses), the call, and
// whether this machine has what it needs.
interface Backend {
  name: string;
  search: SearchFn;
  configured: (s: Settings) => boolean;
  guard?: boolean;
}

// The chain, in order. `guard` marks the scraped sources: their answers must pass
// the relevance guard, a ranked API's must not.
const CHAIN: Backend[] = [
  { name: "tavily", search: tavily, configured: (s) => !!s.tavilyApiKey },
  { name: "searxng", search: searxng, configured: (s) => !!s.searxngUrl },
  { name: "bing", search: bing, configured: () => true, guard: true },
  { name: "ddg", search: ddg, configured: () => true, guard: true },
];

// The usable subset: registered AND configured on this machine, in chain order.
function availableBackends(s: Settings): string[] {
  return CHAIN.filter((backend) => backend.configured(s)).map((backend) => backend.name);
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    out.push(result);
  }
  return out;
}

// The model's arguments for web_search, as component.json declares them.
interface SearchArgs {
  query?: string;
  max_results?: number;
  backend?: string;
}

// One backend's reason, kept as data.
interface Failure {
  backend: string;
  reason: string;
}

// What search() answers: the fused result list, or why every backend declined.
interface SearchOk {
  query: string;
  backend: string;
  results: SearchResult[];
}
interface SearchFail {
  error: string;
  failures?: Failure[];
  query?: string;
}

// Backends fall through in order until one yields. Returns
// {query, backend, results} or {error, failures} — never throws for a
// source-level problem (error-as-data).
async function search(args: SearchArgs = {}): Promise<SearchOk | SearchFail> {
  const s = settings();
  const query = String(args.query || "").trim();
  if (!query) return { error: "query is required" };
  const limit = Math.max(1, Math.min(Math.trunc(Number(args.max_results) || s.maxResults), 20));
  const names = availableBackends(s);
  const pinned = String(args.backend || "").trim();
  if (pinned && !names.includes(pinned)) {
    // One factual gate for every source: not on the available list -> not named
    // in the error either. No install/setup advice, ever.
    return { error: `backend ${JSON.stringify(pinned)} is not available; available: ${names.join(", ") || "none"}` };
  }
  const chain = pinned ? [pinned] : names;
  // The endpoints are operator-configured, so a self-hosted searxng on the LAN is
  // a legitimate destination — unlike a URL the model itself supplied.
  const get: GetFn = (url, options = {}) =>
    httpGet(url, { timeout: s.timeout, maxBytes: s.maxBytes, allowPrivate: true, ...options });

  const failures: Failure[] = [];
  for (const name of chain) {
    const backend = CHAIN.find((entry) => entry.name === name);
    let results: SearchResult[];
    try {
      results = await backend.search(query, limit, s, get);
    } catch (e) {
      if (!(e instanceof BackendError) && !(e instanceof WebError)) throw e;
      failures.push({ backend: name, reason: short(e) });
      continue;
    }
    if (backend.guard && !looksRelevant(query, results)) {
      failures.push({ backend: name, reason: "results share no term with the query (wrong market, or layout drift)" });
      continue;
    }
    return { query, backend: name, results: dedupe(results) };
  }
  return { error: "all search backends failed", failures, query };
}

// search() rendered as the model-facing shape: the fused answer, or the reason
// per backend.
async function searchText(args: SearchArgs): Promise<{ content: string; error?: boolean }> {
  const r = await search(args);
  if ("error" in r) {
    let body = r.error;
    if (r.failures && r.failures.length) body += "\n" + r.failures.map((f) => `- ${f.backend}: ${f.reason}`).join("\n");
    return { content: `ERROR: ${body}`, error: true };
  }
  const body = r.results.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`).join("\n");
  return { content: `${r.results.length} results for ${JSON.stringify(r.query)} (via ${r.backend}):\n\n${body}` };
}

module.exports = { BackendError, availableBackends, looksRelevant, queryTerms, search, searchText };
