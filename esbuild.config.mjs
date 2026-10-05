// Bundles the agent CLI entry into a single ESM file so the embedding host
// (Universe Editor) can ship it without node_modules. The native Claude binary
// is NOT bundled — it is fetched on demand by the host and located via the
// CLAUDE_CODE_EXECUTABLE env var (see claudeCliPath in src/acp-agent.ts).

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(root, "dist/index.js");

/** `2.1.220 (Claude Code)`, and — if the banner is ever reworded — any line that starts with a version. */
const CLAUDE_BANNER_RE = /^[ \t]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]*\(Claude Code\)/m;
const VERSION_LINE_RE = /^[ \t]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m;

// Start from a clean dist so stale tsc artifacts (*.d.ts, tests/) never ship.
await rm(resolve(root, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  sourcemap: false,
  logLevel: "info",
});

// Record the Claude Agent SDK version so the host downloads the matching
// platform binary package (@anthropic-ai/claude-agent-sdk-<platform>-<arch>).
// `cliVersion` records what that binary *self-reports* (`claude --version` →
// `2.1.220 (Claude Code)`), which is a different namespace from sdkVersion: the
// host uses it as the lower bound for a system/custom `claude` it reuses.
// Sampling is best-effort — a build machine without this platform's optional
// dependency still has to produce a package, and the host skips the check when
// the field is null rather than guessing a floor.
const sdkPkg = JSON.parse(
  await readFile(resolve(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"),
);
await mkdir(dirname(outFile), { recursive: true });
await writeFile(
  resolve(root, "dist/claude-binary.json"),
  JSON.stringify({ sdkVersion: sdkPkg.version, cliVersion: probeCliVersion() }, null, 2) + "\n",
);

function platformSuffix() {
  const arch = process.arch;
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "linux") {
    // Mirror the host's detection: both platform packages can be installed side
    // by side, so libc — not the arch alone — decides which one is ours.
    const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
    return `linux-${arch}${glibc ? "" : "-musl"}`;
  }
  return null;
}

function probeCliVersion() {
  try {
    const suffix = platformSuffix();
    if (!suffix) return null;
    const bin = resolve(
      root,
      "node_modules/@anthropic-ai",
      `claude-agent-sdk-${suffix}`,
      process.platform === "win32" ? "claude.exe" : "claude",
    );
    const out = String(execFileSync(bin, ["--version"], { timeout: 10_000, encoding: "utf8" }));
    // Anchored to the start of a line on purpose: the host treats this value as a
    // hard lower bound, so picking a number out of some advisory line
    // ("Update available: 3.0.0") would make every system/custom install
    // unreachable. Not matching at all only disables the host-side check.
    const match = CLAUDE_BANNER_RE.exec(out) ?? VERSION_LINE_RE.exec(out);
    if (match) return match[1];
    console.warn(`cliVersion probe: unrecognized --version output from ${bin}`);
  } catch (err) {
    console.warn(`cliVersion probe failed on ${process.platform}-${process.arch}: ${String(err)}`);
  }
  return null;
}

// Mark the bundle as ESM so Node loads it correctly when `dist/` is shipped on
// its own. electron-builder's extraResources copies only `dist/`, without the
// package root's package.json; Node then resolves the module type from the
// nearest package.json and falls back to CJS, making the bundle's `import`
// statements throw "Cannot use import statement outside a module".
await writeFile(
  resolve(root, "dist/package.json"),
  JSON.stringify({ type: "module" }, null, 2) + "\n",
);

console.log(`agent bundled → dist/index.js (claude SDK ${sdkPkg.version})`);
