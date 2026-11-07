# clutch-websearch

Web access for the agent: two tools, `web_search` and `web_fetch`, as a client
plugin. No Python, no daemon, no host code imported — the client starts
`run(argv)` in this directory and prints what comes back.

## The plugin

`plugin/component.json` is the whole interface: the two tool names, their
parameters, and `command: "<tool> {*}"`. The client renders that command into the
prompt and hands `run(argv)` the tool's own name in `argv[0]` and the model's
arguments as ONE JSON object in `argv[1]` — this file never parses a command
line, a flag or a shell. The answer is `{content, error?}`; `content` is
model-facing text, so a failure is a line, not a stack.

| file | holds |
|---|---|
| `plugin/index.js` | `run`, the two tools, extraction/truncation/redirect rendering |
| `plugin/http.js` | settings, public-host fence, transport (timeout, retry, byte cap, redirects), charset decoding |
| `plugin/html.js` | tokenizer, `htmlToText` (link-preserving), snippet cleaning, the two scraped parsers |
| `plugin/backends.js` | the chain, the relevance guard, ranking, `searchText` |

The plugin is published, not vendored: `web_search` and `web_fetch` reach the
model only while this component is installed on the client.

## Backends

Tried in order, first success wins:

| backend | activated by | notes |
|---|---|---|
| tavily | `CLUTCH_TAVILY_API_KEY` / `TAVILY_API_KEY` | LLM-first search API, best quality |
| searxng | `CLUTCH_SEARXNG_URL` / `SEARXNG_URL` | self-hosted metasearch, JSON API |
| bing | nothing (keyless) | undocumented RSS endpoint of `www.bing.com` |
| ddg | nothing (keyless) | duckduckgo html endpoint |

Endpoints can be redirected at `CLUTCH_TAVILY_URL`, `CLUTCH_BING_URL`,
`CLUTCH_DDG_URL`. Other environment: `CLUTCH_WEBSEARCH_TIMEOUT` (15 s),
`CLUTCH_WEBSEARCH_MAX_RESULTS` (8), `CLUTCH_WEBSEARCH_MAX_CHARS` (20000),
`CLUTCH_WEBSEARCH_MAX_BYTES` (2000000), `CLUTCH_WEBSEARCH_ALLOW_PRIVATE_HOSTS`.

`web_search` takes `query` (required), `max_results` and `backend`; pinning a
name the client is not configured with is an error naming it, never a silent
fall-through. When every backend fails, the answer carries one line per backend
with its reason, so degradation is visible instead of silent.

## The contract callers can rely on

- **bounded I/O** — every request has a timeout; a GET that times out is retried
  exactly once (never a POST), and a response over `max_bytes` is rejected from
  its `content-length` or while streaming;
- **private-network guard** — `web_fetch` refuses loopback/LAN/link-local hosts,
  and every redirect hop is re-checked against the same rule. A literal address is
  judged locally, never through the resolver: asking DNS about `127.0.0.1` would
  both hang when the resolver is dead and let a lying resolver through. Search
  endpoints are operator-configured, so a self-hosted searxng on the LAN still
  works;
- **link-preserving extraction** — anchors become `[text](url)`, so a caller never
  invents a URL from a button label;
- **relevance guard** — a scraped backend whose results share no term with the
  query falls through to the next one, instead of answering an English niche
  query with unrelated Chinese pages;
- **truncation hints** — an oversized page ends with the exact `start=` to
  continue, mirroring `read_file`'s offset hints.

## Tests

```
cd clutch-websearch && node tests/plugin.test.js
```

No dependencies and no network: the suite runs a loopback stub server and
exercises the plugin over real HTTP — extraction, both parsers, the relevance
guard, the fence (loopback, link-local, IPv4 and IPv6 private ranges), transport
(timeout, the single retry, the byte cap), and the chain's fall-through and
all-fail rendering.

The host also pins this component's shape end to end in
`tests/client-plugin-websearch.test.js` (run from the host repo root), which
loads `component.json`, pushes it through the real plugin host and calls both
tools.
