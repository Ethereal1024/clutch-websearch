// GENERATED FILE — do not edit; edit plugin/src/backends.ts and run `node scripts/build-plugin.js`.
// source sha256: 4861d46055834fde7712628eea0b19326557a7842d15f58438a8c5d582941975

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// The two neighbours, announced with the shapes their interfaces publish: these
// are CommonJS modules (`module.exports = …`), which the compiler cannot read a
// module shape off, so the contract is written here where its callers use it.
const { WebError, decodeBody, httpGet, settings, short } = require("./http");
const { cleanSnippet, parseBingRss, parseDdg } = require("./html");
// A backends' own failure: it answered (or did not), and what came back did not
// become a result list.
class BackendError extends Error {
}
// ---- the relevance guard ----------------------------------------------------
const STOPWORDS = new Set(`a an and are as at be by do does for from has have how in into is it its of on or that the this
  to was were what when where which who why with site`.split(/\s+/));
const WORD_RE = /[a-z0-9][a-z0-9_+.\-]*/g;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
function hasCjk(text) {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}
// (ASCII tokens, CJK bigrams) — what a relevant result should echo back.
function queryTerms(query) {
    const low = String(query).toLowerCase();
    const words = new Set((low.match(WORD_RE) || []).filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
    const grams = new Set();
    for (const run of low.match(CJK_RE) || []) {
        if (run.length === 1)
            grams.add(run);
        else
            for (let i = 0; i + 2 <= run.length; i += 1)
                grams.add(run.slice(i, i + 2));
    }
    return { words, grams };
}
// True when at least one of the top results shares a term with the query. The bar
// is deliberately low (any shared token, not a score): it exists to turn "wrong
// market / drifted layout" into an error, not to rank. A query whose only terms
// are stopwords is never judged.
function looksRelevant(query, results, top = 5) {
    const { words, grams } = queryTerms(query);
    if (!words.size && !grams.size)
        return true;
    for (const result of results.slice(0, top)) {
        const hay = `${result.title || ""} ${result.url || ""} ${result.snippet || ""}`.toLowerCase();
        const seen = new Set(hay.match(WORD_RE) || []);
        for (const word of words)
            if (seen.has(word))
                return true;
        for (const gram of grams)
            if (hay.includes(gram))
                return true;
    }
    return false;
}
function withQuery(base, params) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
    return url.href;
}
// tavily and searxng publish the same shape: {results: [{title,url,content}]}.
function ranked(response, name, limit, hint = "") {
    let data;
    try {
        data = JSON.parse(decodeBody(response.body, response.contentType));
    }
    catch (e) {
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
    if (!out.length)
        throw new BackendError("response had no usable results");
    return out;
}
async function tavily(query, limit, s, get) {
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
async function searxng(query, limit, s, get) {
    const url = withQuery(`${s.searxngUrl}/search`, { q: query, format: "json" });
    const response = await get(url, { headers: { Accept: "application/json" } });
    return ranked(response, "searxng", limit, " (format=json enabled?)");
}
// Market/language params follow the query's script: a hardcoded regional
// preference is what made bing answer English niche queries with Chinese pages.
function bingMarket(query) {
    if (hasCjk(query)) {
        return { params: { mkt: "zh-CN", setlang: "zh-hans" }, language: "zh-CN,zh;q=0.9,en;q=0.8" };
    }
    return { params: { mkt: "en-US", setlang: "en", ensearch: "1" }, language: "en-US,en;q=0.9" };
}
async function bing(query, limit, s, get) {
    const market = bingMarket(query);
    const url = withQuery(s.bingUrl, { q: query, format: "rss", count: String(Math.min(limit, 30)), ...market.params });
    const response = await get(url, {
        headers: {
            Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
            "Accept-Language": market.language,
        },
    });
    const items = parseBingRss(decodeBody(response.body, response.contentType));
    if (items === null)
        throw new BackendError("bing RSS is not parseable XML");
    const out = items.slice(0, limit);
    if (!out.length)
        throw new BackendError("no items in the RSS (blocked, or genuinely no results)");
    return out;
}
async function ddg(query, limit, s, get) {
    const response = await get(withQuery(s.ddgUrl, { q: query }));
    const out = parseDdg(decodeBody(response.body, response.contentType))
        .filter((row) => row.url)
        .slice(0, limit);
    if (!out.length)
        throw new BackendError("no results parsed (bot-checked, blocked, or layout changed)");
    return out;
}
// The chain, in order. `guard` marks the scraped sources: their answers must pass
// the relevance guard, a ranked API's must not.
const CHAIN = [
    { name: "tavily", search: tavily, configured: (s) => !!s.tavilyApiKey },
    { name: "searxng", search: searxng, configured: (s) => !!s.searxngUrl },
    { name: "bing", search: bing, configured: () => true, guard: true },
    { name: "ddg", search: ddg, configured: () => true, guard: true },
];
// The usable subset: registered AND configured on this machine, in chain order.
function availableBackends(s) {
    return CHAIN.filter((backend) => backend.configured(s)).map((backend) => backend.name);
}
function dedupe(results) {
    const seen = new Set();
    const out = [];
    for (const result of results) {
        if (seen.has(result.url))
            continue;
        seen.add(result.url);
        out.push(result);
    }
    return out;
}
// Backends fall through in order until one yields. Returns
// {query, backend, results} or {error, failures} — never throws for a
// source-level problem (error-as-data).
async function search(args = {}) {
    const s = settings();
    const query = String(args.query || "").trim();
    if (!query)
        return { error: "query is required" };
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
    const get = (url, options = {}) => httpGet(url, { timeout: s.timeout, maxBytes: s.maxBytes, allowPrivate: true, ...options });
    const failures = [];
    for (const name of chain) {
        const backend = CHAIN.find((entry) => entry.name === name);
        let results;
        try {
            results = await backend.search(query, limit, s, get);
        }
        catch (e) {
            if (!(e instanceof BackendError) && !(e instanceof WebError))
                throw e;
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
async function searchText(args) {
    const r = await search(args);
    if ("error" in r) {
        let body = r.error;
        if (r.failures && r.failures.length)
            body += "\n" + r.failures.map((f) => `- ${f.backend}: ${f.reason}`).join("\n");
        return { content: `ERROR: ${body}`, error: true };
    }
    const body = r.results.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`).join("\n");
    return { content: `${r.results.length} results for ${JSON.stringify(r.query)} (via ${r.backend}):\n\n${body}` };
}
module.exports = { BackendError, availableBackends, looksRelevant, queryTerms, search, searchText };
