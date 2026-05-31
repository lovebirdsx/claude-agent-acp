// Bundles the agent CLI entry into a single ESM file so the embedding host
// (Universe Editor) can ship it without node_modules. The native Claude binary
// is NOT bundled — it is fetched on demand by the host and located via the
// CLAUDE_CODE_EXECUTABLE env var (see claudeCliPath in src/acp-agent.ts).

import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outFile = resolve(root, 'dist/index.js')

// Start from a clean dist so stale tsc artifacts (*.d.ts, tests/) never ship.
await rm(resolve(root, 'dist'), { recursive: true, force: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
})

// Record the Claude Agent SDK version so the host downloads the matching
// platform binary package (@anthropic-ai/claude-agent-sdk-<platform>-<arch>).
const sdkPkg = JSON.parse(
  await readFile(resolve(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'),
)
await mkdir(dirname(outFile), { recursive: true })
await writeFile(
  resolve(root, 'dist/claude-binary.json'),
  JSON.stringify({ sdkVersion: sdkPkg.version }, null, 2) + '\n',
)

console.log(`agent bundled → dist/index.js (claude SDK ${sdkPkg.version})`)
