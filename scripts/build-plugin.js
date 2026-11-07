#!/usr/bin/env node
// Builds this plugin: plugin/src/*.ts -> plugin/*.js, IN PLACE, one .js per .ts.
//
//    node scripts/build-plugin.js             compile            (needs tsc)
//    node scripts/build-plugin.js --check     stale?             (no tsc at all)
//    node scripts/build-plugin.js --typecheck tsc --noEmit       (no emit)
//
// Why in place, and why committed output: plugin/ IS this component's released
// artifact (`git archive HEAD:plugin`, whose members land at the tar's top
// level, beside the `entry` that names index.js). A client's embedded node on a
// phone cannot strip types, and the release workflow installs nothing — so the
// emitted .js are the truth that ships, and the sources are what they are made
// from. Same rule, same reason as the parent repository's ui/*.js.
//
// Why --check does not run tsc: it recomputes each source's sha256 and compares
// it with the digest the emitted file's banner records. That is what lets a
// tsc-free job (the release below, or a phone) refuse to ship a module older
// than its source, instead of silently archiving last week's code.
//
// Why this file does not import the parent repository's ui/build-ts.js: this
// tree is published and checked out on its OWN (Clutch vendors a clone of it
// under clutch-websearch/, but it is a separate repository with its own
// releases), so a build that reached `../ui/` would only work inside Clutch.
// The banner format and the three verbs are kept identical on purpose — one
// idea, two trees that cannot see each other.

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN = path.join(ROOT, "plugin");
const SRC = path.join(PLUGIN, "src");
const CONFIG = path.join(ROOT, "tsconfig.plugin.json");

// Specific to THIS build, and read back by the orphan sweep below: a .js in
// plugin/ carrying this marker was produced here, so a marker whose source is
// gone is this build's leftover — not something to leave lying in the artifact.
const BANNER = "// GENERATED FILE — do not edit; edit plugin/src/";
const HINT = "`node scripts/build-plugin.js`";
const LABEL = "build-plugin";
const REBUILD = "node scripts/build-plugin.js";

// There is no npm install in this repository (the plugin imports nothing and its
// tests run on a stock node), so the compiler is looked up where a checkout can
// find one: this tree's own devDependencies if a maintainer added them, else the
// parent Clutch checkout's single pinned install (`../ui/node_modules`), which is
// exactly why tsconfig.plugin.json's typeRoots names both.
function findTsc() {
  try {
    return require.resolve("typescript/lib/tsc.js", { paths: [ROOT, path.join(ROOT, "..", "ui")] });
  } catch (e) {
    return null;
  }
}

const TSC = findTsc();

// The digest is of the SOURCE, not of the output: tsc REPRINTS (a one-line
// `if (x) y();` becomes a block), so the emitted bytes are not reconstructible
// from the source text by any cheap means. Hashing the input is what makes
// `--check` answer "is this output older than the code it was made from?"
// without running the compiler.
function digestOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sources() {
  return fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
}

function bannerFor(name, digest) {
  return `${BANNER}${name}.ts and run ${HINT}.\n` + `// source sha256: ${digest}`;
}

// A compiled file's text with our banner in front. One blank line after the
// banner so the generated header reads as a header, not as the first
// statement's comment.
function stamped(name, compiled) {
  const source = fs.readFileSync(path.join(SRC, name + ".ts"), "utf8");
  return bannerFor(name, digestOf(source)) + "\n\n" + compiled;
}

// Every .js in plugin/ carrying THIS build's banner — the emitted set, as
// opposed to a hand-written .js that happens to live beside them.
function emittedFiles() {
  return fs
    .readdirSync(PLUGIN)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => fs.readFileSync(path.join(PLUGIN, f), "utf8").slice(0, BANNER.length) === BANNER)
    .sort();
}

function compile() {
  if (!TSC) {
    throw new Error(
      "no typescript found: this tree has no node_modules, and no parent checkout to borrow from.\n" +
        "  Either build it inside Clutch (which pins one typescript), or run `npm i -D typescript @types/node` here."
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), LABEL + "-"));
  try {
    const run = spawnSync(process.execPath, [TSC, "-p", CONFIG, "--outDir", tmp], { cwd: ROOT, encoding: "utf8" });
    const said = ((run.stdout || "") + (run.stderr || "")).trim();
    if (run.status !== 0) {
      if (said) console.error(said);
      throw new Error(`tsc failed (${run.status}); nothing was written`);
    }
    return { tmp, said };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function build() {
  const { tmp, said } = compile();
  const written = [];
  try {
    for (const file of sources()) {
      const name = file.replace(/\.ts$/, "");
      const compiled = fs.readFileSync(path.join(tmp, name + ".js"), "utf8");
      fs.writeFileSync(path.join(PLUGIN, name + ".js"), stamped(name, compiled));
      written.push(name + ".js");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (said) console.error(said);
  // An emitted file whose source is gone is deleted here, not left behind: a
  // stale module is still require-able, so a client would install and run code
  // no source describes — and the tar ships whatever is in plugin/.
  const orphans = emittedFiles().filter((f) => !sources().includes(f.replace(/\.js$/, ".ts")));
  for (const f of orphans) fs.rmSync(path.join(PLUGIN, f));
  return { written, orphans };
}

function check() {
  const bad = [];
  const list = sources();
  for (const file of list) {
    const name = file.replace(/\.ts$/, "");
    const out = path.join(PLUGIN, name + ".js");
    const expected = digestOf(fs.readFileSync(path.join(SRC, file), "utf8"));
    if (!fs.existsSync(out)) {
      bad.push(`${name}.js is MISSING (plugin/src/${file} has no output)`);
      continue;
    }
    const recorded = /^\/\/ source sha256: ([0-9a-f]{64})$/m.exec(fs.readFileSync(out, "utf8"));
    if (!recorded) {
      bad.push(`${name}.js has no digest banner — it was not produced by this build`);
    } else if (recorded[1] !== expected) {
      bad.push(`${name}.js is STALE (source ${expected.slice(0, 12)}…, output ${recorded[1].slice(0, 12)}…)`);
    }
  }
  for (const f of emittedFiles()) {
    if (!list.includes(f.replace(/\.js$/, ".ts"))) bad.push(`${f} has no source in plugin/src/ — remove it or restore the source`);
  }
  if (bad.length) {
    console.error(
      `${LABEL}: the emitted modules do not match plugin/src/:\n` +
        bad.map((b) => "  - " + b).join("\n") +
        `\n  Rebuild: ${REBUILD}`
    );
    process.exit(1);
  }
  console.log(`${LABEL}: up to date — ${list.length} modules`);
}

// type-check only: the same compiler, the same config, nothing written. For a
// tree whose committed output is what runs, "does it compile" and "is the
// output current" are different questions (check answers the second).
function typecheck() {
  if (!TSC) {
    console.error("no typescript found; see the message `node scripts/build-plugin.js` prints.");
    process.exit(1);
  }
  const run = spawnSync(process.execPath, [TSC, "-p", CONFIG, "--noEmit"], { cwd: ROOT, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status === null ? 1 : run.status);
  console.log(`${LABEL}: typecheck OK`);
}

// exercised by tests/plugin.test.js
module.exports = { sources, emittedFiles, digestOf, BANNER, findTsc };

if (require.main === module) {
  if (process.argv.includes("--check")) check();
  else if (process.argv.includes("--typecheck")) typecheck();
  else {
    const { written, orphans } = build();
    console.log(
      `${LABEL}: wrote ${written.length} modules to plugin/` + (orphans.length ? `, removed ${orphans.join(", ")}` : "")
    );
  }
}
