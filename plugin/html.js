"use strict";

// HTML -> words, twice over: one page becomes a title + readable text with its
// links KEPT, and the two scraped backends' result pages become
// {title, url, snippet}.
//
// The link-keeping is the P0 of the SRU 404 postmortem: a text extractor that
// drops hrefs leaves the caller inventing a URL from a button label, and four
// honest 404s then get reported as "never published". So every anchor renders as
// `[text](url)` with its href resolved against the page, and an anchor with no
// usable destination keeps its words and drops the markup.
//
// No dependency, no DOM: a tokenizer over the tag stream is enough for text and
// for two known layouts, and it is the same tokenizer in all three places (which
// is why the layouts can be read off the same pass a page is).

const DEAD_SCHEMES = ["javascript:", "mailto:", "tel:", "data:", "about:", "blob:"];

// script/style/nav chrome is not the page's content; `head` is here so a <title>
// is captured (below) without the rest of the head leaking into the text.
const SKIP = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "object",
  "embed", "canvas", "nav", "aside", "footer", "form", "button",
  "select", "option", "input", "label", "head",
]);

// Block edges become newlines; without them a page reads as one long line.
const BLOCK = new Set([
  "p", "div", "li", "tr", "table", "ul", "ol", "dl", "dt", "dd", "pre",
  "blockquote", "section", "article", "main", "figure", "figcaption",
  "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr",
]);

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", middot: "\u00b7",
  rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d",
};

function decodeEntities(text) {
  return String(text).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      } catch (e) {
        return whole; // not a code point
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : whole;
  });
}

// ---- the tag stream ---------------------------------------------------------

const TAG_RE = /<(!--[\s\S]*?--|\/?[a-zA-Z][^>]*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributes(body) {
  const out = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(body))) {
    const key = match[1].toLowerCase();
    if (key in out) continue; // the first spelling wins, as in a browser
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : "";
    out[key] = decodeEntities(value);
  }
  return out;
}

// {kind: "text", text} | {kind: "tag", name, attrs, closing, selfClosing}.
// Comments, doctypes and CDATA are dropped whole: none of them is a word the
// caller wants, and a `<` inside one would otherwise derail the scan.
function* tokens(html) {
  const text = String(html);
  TAG_RE.lastIndex = 0;
  let at = 0;
  let match;
  while ((match = TAG_RE.exec(text))) {
    if (match.index > at) yield { kind: "text", text: text.slice(at, match.index) };
    at = TAG_RE.lastIndex;
    const inner = match[1];
    if (inner[0] === "!") continue;
    const closing = inner[0] === "/";
    const body = closing ? inner.slice(1) : inner;
    const name = ((/^[a-zA-Z][^\s/>]*/.exec(body) || [""])[0] || "").toLowerCase();
    yield {
      kind: "tag",
      name,
      attrs: closing ? Object.create(null) : attributes(body),
      closing,
      selfClosing: /\/\s*$/.test(inner),
    };
  }
  if (at < text.length) yield { kind: "text", text: text.slice(at) };
}

function resolveHref(href, baseUrl) {
  const value = String(href || "");
  if (!value || value[0] === "#") return null;
  if (DEAD_SCHEMES.some((scheme) => value.toLowerCase().startsWith(scheme))) return null;
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (e) {
    return null;
  }
}

// ---- a page -----------------------------------------------------------------

// HTML -> {title, text}. Anchors survive as `[label](url)`.
function htmlToText(html, baseUrl = "") {
  let title = "";
  let inTitle = false;
  let skip = 0;
  let link = null; // {href, parts}
  const chunks = [];

  const boundary = () => {
    if (link) link.parts.push(" ");
    else chunks.push("\n");
  };

  const closeLink = () => {
    const open = link;
    link = null;
    if (!open) return;
    const label = open.parts.join("").replace(/\s+/g, " ").trim();
    const url = resolveHref(open.href, baseUrl);
    if (url === null) {
      if (label) chunks.push(` ${label} `); // nothing linkable: keep the words
    } else if (!label || label === url) {
      chunks.push(` ${url} `);
    } else {
      chunks.push(` [${label}](${url}) `);
    }
  };

  for (const token of tokens(html)) {
    if (token.kind === "text") {
      const text = decodeEntities(token.text);
      if (inTitle) title += text.trim();
      else if (skip) continue;
      else if (link) link.parts.push(text);
      else chunks.push(text);
      continue;
    }
    if (token.name === "title") {
      inTitle = !token.closing;
      continue;
    }
    if (SKIP.has(token.name)) {
      // A self-closing skip tag opens nothing, so it closes nothing either.
      if (token.closing) {
        if (skip) skip -= 1;
      } else if (!token.selfClosing) skip += 1;
      continue;
    }
    if (skip) continue;
    if (token.name === "a") {
      if (token.closing) {
        closeLink();
        continue;
      }
      closeLink(); // a malformed nested anchor: the outer one is flushed
      link = { href: String(token.attrs.href || "").trim(), parts: [] };
      continue;
    }
    if (token.name === "img" && link) {
      const alt = String(token.attrs.alt || "").trim(); // image buttons carry their label here
      if (alt) link.parts.push(` ${alt} `);
      continue;
    }
    if (BLOCK.has(token.name)) boundary();
  }
  closeLink();

  const lines = chunks
    .join("")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f]+/g, " ").trim());
  return { title, text: lines.filter(Boolean).join("\n") };
}

// A feed blurb or an RSS description: markup to one line of plain text.
function cleanSnippet(text) {
  const plain = decodeEntities(String(text).replace(/<[^>]+>/g, " ")).replace(/\u00a0/g, " ");
  return plain.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ---- the two scraped layouts -------------------------------------------------

// duckduckgo's html endpoint: `<a class="result__a" href="/l/?uddg=<encoded>">`
// for the title, then `<a class="result__snippet">` for the blurb.
function parseDdg(html) {
  const results = [];
  let pending = null;
  let mode = "";
  let buffer = [];

  const flush = () => {
    if (pending && pending.title) results.push(pending);
    pending = null;
    mode = "";
  };

  for (const token of tokens(html)) {
    if (token.kind === "text") {
      if (mode) buffer.push(decodeEntities(token.text));
      continue;
    }
    if (token.name !== "a") continue;
    if (token.closing) {
      if (!pending) continue;
      if (mode === "title") {
        pending.title = buffer.join("").replace(/\s+/g, " ").trim();
        mode = "";
      } else if (mode === "snippet") {
        pending.snippet = cleanSnippet(buffer.join(""));
        results.push(pending);
        pending = null;
        mode = "";
      }
      continue;
    }
    const cls = String(token.attrs.class || "");
    if (cls.includes("result__a")) {
      flush();
      pending = { url: ddgTarget(String(token.attrs.href || "")), title: "", snippet: "" };
      mode = "title";
      buffer = [];
    } else if (cls.includes("result__snippet") && pending) {
      mode = "snippet";
      buffer = [];
    }
  }
  flush();
  return results;
}

// The href is a `/l/?uddg=<percent-encoded target>` hop, and the real address is
// the one the caller needs. `searchParams` already decodes it once.
function ddgTarget(href) {
  try {
    const target = new URL(href, "https://duckduckgo.com").searchParams.get("uddg");
    return target || href;
  } catch (e) {
    return href;
  }
}

// The bing RSS endpoint: <item><title/><link/><description/></item>. `null` means
// "this is not RSS at all" (a bot-check page, changed layout), which the caller
// reports as such instead of as "no results".
function parseBingRss(xml) {
  const source = String(xml);
  if (!/<(rss|feed|channel)\b/i.test(source)) return null;
  const out = [];
  for (const item of source.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
    const title = xmlText(item, "title");
    const url = xmlText(item, "link");
    if (!title || !url) continue;
    out.push({ title: cleanSnippet(title), url, snippet: cleanSnippet(xmlText(item, "description")) });
  }
  return out;
}

function xmlText(block, name) {
  const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!found) return "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(found[1]);
  return decodeEntities(cdata ? cdata[1] : found[1]).trim();
}

module.exports = { cleanSnippet, decodeEntities, htmlToText, parseBingRss, parseDdg };
