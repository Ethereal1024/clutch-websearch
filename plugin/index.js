"use strict";

// clutch-websearch, as a client plugin: the two tools whose subject is the
// network, running on the machine the user is looking at.
//
// The ABI is one line (ui/plugin-child.js states it in full): `run(argv)`, where
// `argv[0]` is the tool's own name and `argv[1]` is the model's arguments as ONE
// JSON object. Declaring `command: "web_search {*}"` in component.json is what
// makes both true — the client renders the statement into words, and this file
// never parses a command line, a flag or a shell.
//
// The answer is `{content, error?}`: `content` is the model-facing text and
// `error` says whether the tool failed — the same shape the session side calls an
// envelope, so one renderer draws both. Everything below renders text, never
// JSON: a model reads these lines, and a failure is a line, not a stack.

const { decodeBody, httpGet, settings, short } = require("./http");
const { htmlToText } = require("./html");
const { searchText } = require("./backends");

const BINARY_PREFIXES = ["image/", "video/", "audio/"];
const BINARY_EXACT = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/octet-stream",
]);

// One character slice plus the next offset (null when nothing remains), so an
// oversized page can be continued instead of lost — the same hint shape read_file
// gives for an offset.
function slice(text, start, limit) {
  const from = Math.max(0, start);
  const chunk = text.slice(from, from + limit);
  const edge = from + chunk.length;
  return [chunk, edge < text.length ? edge : null];
}

async function fetchPage(args) {
  const s = settings();
  const url = String(args.url || "").trim();
  if (!url) return { content: "ERROR: url is required", error: true };

  let response;
  try {
    // The URL came out of the model's mouth: loopback/LAN stays refused unless the
    // operator opened the escape hatch.
    response = await httpGet(url, { timeout: s.timeout, maxBytes: s.maxBytes, allowPrivate: s.allowPrivateHosts });
  } catch (e) {
    return { content: `ERROR: ${short(e)}`, error: true };
  }

  const type = String(response.contentType || "").split(";")[0].trim().toLowerCase();
  if (BINARY_PREFIXES.some((prefix) => type.startsWith(prefix)) || BINARY_EXACT.has(type)) {
    return { content: `ERROR: unsupported content-type ${JSON.stringify(type)} (text pages only)`, error: true };
  }
  const body = decodeBody(response.body, response.contentType);
  let title = "";
  let page;
  if (type.includes("html") || (!type && body.replace(/^\s+/, "").startsWith("<"))) {
    const extracted = htmlToText(body, response.url);
    title = extracted.title;
    page = extracted.text || "(no extractable text; the page is probably JS-rendered)";
  } else {
    page = body;
  }

  const limit = Math.max(200, Math.trunc(Number(args.max_chars) || s.maxChars));
  const [chunk, next] = slice(page, Math.trunc(Number(args.start) || 0), limit);
  let content = chunk;
  if (next !== null) {
    content += `\n... [${page.length - next} chars truncated; fetch again with start=${next} to continue]`;
  }
  if (response.url !== url) content = `(redirected to ${response.url})\n\n${content}`;
  if (title) content = `# ${title}\n\n${content}`;
  return { content };
}

// The list of tools is NOT here: it is component.json's `tools`, because the
// client must be able to show and validate them without running this file.
const TOOLS = { web_search: searchText, web_fetch: fetchPage };

exports.run = async (argv) => {
  const words = Array.isArray(argv) ? argv.map(String) : [];
  const tool = words[0] || "";
  const handler = TOOLS[tool];
  if (!handler) {
    throw new Error(`this plugin publishes ${Object.keys(TOOLS).join(" and ")}, not ${JSON.stringify(tool)}`);
  }
  let args;
  try {
    args = JSON.parse(words[1] || "{}");
  } catch (e) {
    throw new Error(`${tool}: its arguments are not one JSON object: ${e.message}`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${tool}: its arguments are not one JSON object (got ${Array.isArray(args) ? "an array" : typeof args})`);
  }
  return handler(args);
};
