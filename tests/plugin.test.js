// clutch-websearch's own suite: the parsers, the guards, the chain, the entry.
//
// The parent repository's `tests/client-plugin-websearch.test.js` proves the
// plugin is installed and CALLED the way the app calls a plugin (through the
// channel, forked, with the seams a fork really has). This file is the other
// half, and it lives beside the code it tests because it is part of what a
// `clutch-websearch` install ships: what a page becomes, what the two scraped
// layouts become, what the relevance guard refuses, what the fence refuses, and
// what one bounded request does when the far side hangs.
//
// Offline by design: every HTTP hop is a loopback socket this file starts.
// Run: node tests/plugin.test.js

"use strict";

const http = require("http");
const path = require("path");

const PLUGIN = path.join(__dirname, "..", "plugin");
const { cleanSnippet, htmlToText, parseBingRss, parseDdg } = require(path.join(PLUGIN, "html"));
const { assertPublicHost, httpGet, isPublicAddress } = require(path.join(PLUGIN, "http"));
const { looksRelevant } = require(path.join(PLUGIN, "backends"));
const plugin = require(path.join(PLUGIN, "index"));

// ---- a harness, because a suite that needs npm is a suite nobody runs ---------

let passed = 0;
const failures = [];

function check(ok, what) {
  if (ok) {
    passed += 1;
    console.log(`ok:   ${what}`);
  } else {
    failures.push(what);
    console.log(`FAIL: ${what}`);
  }
}

function summary(name) {
  console.log("");
  if (failures.length) {
    console.log(`${name}: ${failures.length} FAILED`);
    for (const what of failures) console.log(`  - ${what}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${name}: ${passed} checks pass`);
}

// ---- fixtures -----------------------------------------------------------------

const BING_RSS = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
<title>bing: q</title><item><title>Alpha result</title><link>https://a.example/x</link>
<description>First &amp;lt;tag&amp;gt; snippet</description></item>
<item><title>Beta</title><link>https://b.example/</link><description>Second snippet</description></item>
</channel></rss>`;

// the postmortem's silent failure: a real RSS, real items, wrong market
const BING_UNRELATED = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
<title>bing: q</title><item><title>在粉笔工作是一种什么体验？ - 知乎</title>
<link>https://www.zhihu.com/question/1</link><description>粉笔申论和小马哥申论该听哪个</description></item>
<item><title>求一份2025下小学教资资料</title><link>https://www.fenbi.com/x</link>
<description>教资备考</description></item></channel></rss>`;

const DDG_HTML = `
<html><body>
<div class="result">
<h2><a class="result__a" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Fleggedrobotics%2Fsru-navigation-learning">sru-navigation-learning</a></h2>
<a class="result__snippet">The <b>official</b> sru-navigation-learning repository</a>
</div>
<div class="result">
<h2><a class="result__a" href="https://b.example/two">leggedrobotics sru</a></h2>
<a class="result__snippet">sru-navigation-learning mirror</a>
</div>
</body></html>`;

const PAGE_HTML = `<!doctype html><html><head><title>SRU project</title><style>x{}</style></head>
<body><nav>home / code / about</nav>
<p>Prose about the project.</p>
<a href="/orgs/leggedrobotics/repos"><img alt="GitHub" src="x.png"></a>
<a href="javascript:void(0)">Menu</a></body></html>`;

const SEARXNG_JSON = JSON.stringify({
  results: [
    { title: "Alpha one", url: "https://example.com/first", content: "a snippet about alpha beta" },
    { title: "Alpha two", url: "https://example.com/second", content: "another snippet" },
  ],
});

// One loopback server for every seam: each route is a seam the settings read.
function stub() {
  const hits = Object.create(null);
  const routes = {
    "/searxng/search": (res) => send(res, 200, "application/json", SEARXNG_JSON),
    "/bing": (res) => send(res, 200, "application/rss+xml", BING_RSS),
    "/bing-unrelated": (res) => send(res, 200, "application/rss+xml", BING_UNRELATED),
    "/ddg": (res) => send(res, 200, "text/html; charset=utf-8", DDG_HTML),
    "/page": (res) => send(res, 200, "text/html; charset=utf-8", PAGE_HTML),
    "/redirect": (res) => {
      res.writeHead(302, { Location: "/page" });
      res.end();
    },
    "/png": (res) => send(res, 200, "image/png", "not really a png"),
    "/big": (res) => send(res, 200, "text/plain", "x".repeat(5000)),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub.invalid");
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    if (url.pathname === "/hang") return; // never answers: the timeout's own test
    const route = routes[url.pathname];
    if (!route) return send(res, 404, "text/plain", "no such route");
    route(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function send(res, status, type, body) {
  const buffer = Buffer.from(String(body), "utf8");
  res.writeHead(status, { "Content-Type": type, "Content-Length": buffer.length });
  res.end(buffer);
}

// The seams, pointed at the stub; the operator-configured ones (tavily, searxng)
// are off unless a case turns one on.
function seams(base) {
  delete process.env.CLUTCH_TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.CLUTCH_SEARXNG_URL;
  delete process.env.SEARXNG_URL;
  delete process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS;
  delete process.env.CLUTCH_WEBSEARCH_MAX_BYTES;
  process.env.CLUTCH_BING_URL = `${base}/bing`;
  process.env.CLUTCH_DDG_URL = `${base}/ddg`;
}

// ---- extraction: the P0 fix --------------------------------------------------

function checkExtraction() {
  const page = '<html><body><p>Code:</p><a href="https://github.com/leggedrobotics/sru">GitHub</a></body></html>';
  check(
    htmlToText(page).text.includes("[GitHub](https://github.com/leggedrobotics/sru)"),
    "an anchor survives as [label](url) — never a label with no address"
  );

  const relative = '<a href="/orgs/leggedrobotics/repos"><img alt="GitHub" src="x.png"></a>';
  check(
    htmlToText(relative, "https://michaelfyang.github.io/sru-project-website/").text.includes(
      "[GitHub](https://michaelfyang.github.io/orgs/leggedrobotics/repos)"
    ),
    "a relative href is resolved against the page, and an image button's alt is its label"
  );

  const dead = htmlToText(
    '<a href="javascript:void(0)">Menu</a><a href="#top">Top</a><a href="mailto:a@b.c">Mail</a>',
    "https://example.com/p"
  ).text;
  check(
    dead.includes("Menu") && !dead.includes("javascript") && !dead.includes("mailto") && !dead.includes("(#"),
    "a dead href keeps its words and drops the markup"
  );

  const chrome = htmlToText(
    "<html><head><title>SRU</title><style>x{}</style></head><body><nav>skip me</nav><p>Body text</p></body></html>"
  );
  check(chrome.title === "SRU", "the <title> is the title");
  check(
    chrome.text.includes("Body text") && !chrome.text.includes("skip me") && !chrome.text.includes("x{}"),
    "and nav/style chrome is not the page's text"
  );

  const bare = htmlToText('<a href="https://example.com/a">https://example.com/a</a>').text;
  check(bare.split("https://example.com/a").length - 1 === 1, "a bare-URL anchor is printed once, not twice");

  check(
    cleanSnippet("a <b>bold</b>  &amp;\n tail") === "a bold & tail",
    "a feed blurb becomes one line of plain text"
  );
}

// ---- the two scraped layouts --------------------------------------------------

function checkParsers() {
  const bing = parseBingRss(BING_RSS);
  check(
    bing.map((row) => row.url).join(",") === "https://a.example/x,https://b.example/",
    "bing's RSS items parse in order"
  );
  check(bing[0].snippet === "First <tag> snippet", "with its description decoded, entities and all");
  check(parseBingRss("<rss><channel></channel></rss>").length === 0, "an empty RSS is an empty list, not a throw");
  check(parseBingRss("<html>blocked</html>") === null, "a bot-check page is 'not RSS at all'");

  const ddg = parseDdg(DDG_HTML);
  check(
    ddg[0].url === "https://github.com/leggedrobotics/sru-navigation-learning",
    "ddg's /l/?uddg= redirect hop is unwrapped to the real address"
  );
  check(ddg[0].title === "sru-navigation-learning", "with its title");
  check(ddg[1].url === "https://b.example/two", "and a result that is not a redirect is kept as it is");
  check(ddg[0].snippet.includes("The official sru-navigation-learning"), "and its snippet is cleaned of markup");
}

// ---- the relevance guard (P1) ------------------------------------------------

function checkGuard() {
  const junk = [
    { title: "在粉笔工作是一种什么体验？ - 知乎", url: "https://www.zhihu.com/question/1", snippet: "教资备考" },
  ];
  check(
    !looksRelevant("michaelfyang sru-navigation-learning github", junk),
    "an answer sharing no term with the query is NOT a success (this is the postmortem's failure)"
  );
  const hit = [{ title: "whatever", url: "https://github.com/leggedrobotics/sru-navigation-learning", snippet: "" }];
  check(looksRelevant("michaelfyang sru-navigation-learning github", hit), "overlap in the URL alone passes");
  check(
    looksRelevant("上海 天气", [{ title: "上海天气预报", url: "https://t.example/", snippet: "" }]),
    "and a CJK bigram matching is enough"
  );
  check(
    !looksRelevant("上海 天气", [{ title: "Beijing forecast", url: "https://b.example/", snippet: "" }]),
    "while a CJK query answered in another language does not"
  );
  check(
    looksRelevant("the of", [{ title: "anything", url: "https://x.example/", snippet: "" }]),
    "a stopword-only query is never judged"
  );
}

// ---- the fence ---------------------------------------------------------------

async function checkFence(base) {
  const refused = async (url) => {
    try {
      await assertPublicHost(url);
      return "";
    } catch (e) {
      return e.message;
    }
  };
  check((await refused("http://127.0.0.1:8890/")).startsWith("non-public host refused: 127.0.0.1"), "loopback is refused");
  check((await refused("http://localhost/")).includes("non-public host refused"), "localhost is refused");
  check((await refused("http://169.254.169.254/latest/meta-data/")).includes("non-public"), "cloud metadata is refused");
  check((await refused("http://10.0.0.5/")).includes("non-public"), "a private range is refused");
  check((await refused("http://[::1]/")).includes("non-public"), "and its IPv6 spelling too");
  check(!(await refused("file:///etc/passwd")).includes("non-public"), "and a scheme with no host is not the fence's answer");

  check(isPublicAddress("93.184.216.34"), "a public address is public");
  check(!isPublicAddress("192.168.1.1") && !isPublicAddress("::1") && isPublicAddress("2606:2800:220:1::1"), "and the tables agree");

  // The operator's escape hatch, and only that: the fetch is what a model's URL reaches.
  process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS = "1";
  const page = await plugin.run(["web_fetch", JSON.stringify({ url: `${base}/page` })]);
  delete process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS;
  check(page.content.startsWith("# SRU project\n\n"), "with allow-private, a loopback page fetches and is titled");
  check(page.content.includes("[GitHub](") && !page.content.includes("home / code / about"), "with its link kept and its chrome dropped");
}

// ---- one bounded request -----------------------------------------------------

async function checkTransport(net) {
  const base = net.base;
  const error = async (options) => {
    try {
      await httpGet(`${base}/hang`, { timeout: 0.05, allowPrivate: true, ...options });
      return "";
    } catch (e) {
      return e.message;
    }
  };
  const reason = await error({});
  check(/^timed out after 0\.05s$/.test(reason), "a hung GET is a timeout with the number in the sentence");
  check(net.hits["/hang"] === 2, "and it is retried exactly once");

  await error({ method: "POST" });
  check(net.hits["/hang"] === 3, "a POST is never replayed");

  let capped = "";
  try {
    await httpGet(`${base}/big`, { maxBytes: 1000, allowPrivate: true });
  } catch (e) {
    capped = e.message;
  }
  check(capped === "response exceeds 1000 bytes", "a response past the byte cap is refused, not swallowed");
}

// ---- the chain and the entry -------------------------------------------------

async function checkChain(net) {
  seams(net.base);

  // Every keyless tier, answering the wrong market first: bing must be tried and
  // REJECTED, not returned.
  process.env.CLUTCH_BING_URL = `${net.base}/bing-unrelated`;
  const fell = await plugin.run(["web_search", JSON.stringify({ query: "michaelfyang sru-navigation-learning github" })]);
  check(
    /\(via ddg\)/.test(fell.content) && fell.content.includes("https://github.com/leggedrobotics/"),
    "an unrelated bing answer falls through to ddg instead of succeeding"
  );

  // A pinned backend that is not configured is a factual answer, not a search.
  const pinned = await plugin.run(["web_search", JSON.stringify({ query: "x", backend: "tavily" })]);
  check(pinned.error === true && /available: bing, ddg/.test(pinned.content), "a pinned backend that does not exist here is named with the list that does");

  process.env.CLUTCH_BING_URL = `${net.base}/bing`;
  const viaBing = await plugin.run(["web_search", JSON.stringify({ query: "alpha result" })]);
  check(/^2 results for "alpha result" \(via bing\):/.test(viaBing.content), "bing answers when its results do share the query's terms");

  process.env.CLUTCH_SEARXNG_URL = `${net.base}/searxng`;
  const viaSearxng = await plugin.run(["web_search", JSON.stringify({ query: "alpha beta", max_results: 1 })]);
  check(/^1 results for "alpha beta" \(via searxng\):/.test(viaSearxng.content), "a configured searxng comes first (the operator's own endpoint)");
  check((net.hits["/bing"] || 0) > 0, "…and the keyless tier is still reachable when it is the only one");

  // The tail of the chain: everything failing is per-backend reasons, in order.
  process.env.CLUTCH_SEARXNG_URL = `${net.base}/nope`;
  process.env.CLUTCH_BING_URL = `${net.base}/bing-unrelated`;
  process.env.CLUTCH_DDG_URL = `${net.base}/nope`;
  const all = await plugin.run(["web_search", JSON.stringify({ query: "alpha beta" })]);
  check(
    all.error === true && /^ERROR: all search backends failed\n- searxng: HTTP 404 from /.test(all.content),
    "every backend failing is one answer, with the first reason on its own line"
  );
  check(
    /- bing: results share no term with the query/.test(all.content) && /- ddg: HTTP 404 from /.test(all.content),
    "…including the guarded one that answered in the wrong market, and the last of the chain"
  );
  process.env.CLUTCH_DDG_URL = `${net.base}/ddg`;

  process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS = "1";
  const binary = await plugin.run(["web_fetch", JSON.stringify({ url: `${net.base}/png` })]);
  delete process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS;
  check(/unsupported content-type "image\/png"/.test(binary.content), "a binary type is refused by name");

  let threw = "";
  try {
    await plugin.run(["delete_everything", "{}"]);
  } catch (e) {
    threw = e.message;
  }
  check(/publishes web_search and web_fetch/.test(threw), "the entry refuses a tool it does not publish");
}

async function checkPageFetches(base) {
  process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS = "1";
  const truncated = await plugin.run(["web_fetch", JSON.stringify({ url: `${base}/big`, max_chars: 200 })]);
  const redirected = await plugin.run(["web_fetch", JSON.stringify({ url: `${base}/redirect` })]);
  delete process.env.CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS;
  check(
    /^x{200}\n\.\.\. \[4800 chars truncated; fetch again with start=200 to continue\]$/.test(truncated.content),
    "a page longer than max_chars says exactly where to continue"
  );

  check(
    redirected.content.startsWith("# SRU project\n\n") && redirected.content.includes(`(redirected to ${base}/page)\n\n`),
    "a redirect is reported with the address that answered"
  );

  const refused = await plugin.run(["web_fetch", JSON.stringify({ url: `${base}/page` })]);
  check(/^ERROR: non-public host refused: 127\.0\.0\.1/.test(refused.content), "and without the hatch the same URL is refused, naming the host");
}

// ---- the built modules -------------------------------------------------------

// The shipped .js are generated from plugin/src/, and they are what a client
// runs, so "are they current" belongs in this suite and not only in the release
// job: a source edited without a rebuild fails HERE, on a laptop, before a tag.
function checkBuild() {
  const fs = require("fs");
  const build = require(path.join(__dirname, "..", "scripts", "build-plugin.js"));
  const sources = build.sources();
  check(
    ["backends.ts", "html.ts", "http.ts", "index.ts"].every((name) => sources.includes(name)),
    "the build sees every source it emits"
  );
  const stale = [];
  for (const name of sources) {
    const out = path.join(PLUGIN, name.replace(/\.ts$/, ".js"));
    const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    const recorded = (/^\/\/ source sha256: ([0-9a-f]{64})$/m.exec(text) || [])[1];
    if (recorded !== build.digestOf(fs.readFileSync(path.join(PLUGIN, "src", name), "utf8"))) stale.push(name);
  }
  check(stale.length === 0, `every emitted module carries its source's digest${stale.length ? ` (${stale.join(", ")})` : ""}`);
  check(
    build.emittedFiles().join(",") === sources.map((name) => name.replace(/\.ts$/, ".js")).sort().join(","),
    "…and none without a source (no orphan in the artifact)"
  );
  // The artifact really is component.json plus these four modules: git enforces
  // that at archive time, so the rule is asserted where it lives.
  check(
    /^src\/ export-ignore$/m.test(fs.readFileSync(path.join(PLUGIN, ".gitattributes"), "utf8")),
    "the sources are not part of the artifact"
  );
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const net = await stub();
  try {
    checkBuild();
    checkExtraction();
    checkParsers();
    checkGuard();
    await checkFence(net.base);
    await checkTransport(net);
    await checkChain(net);
    await checkPageFetches(net.base);
  } finally {
    net.server.close();
  }
}

main()
  .then(() => summary("clutch-websearch"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
