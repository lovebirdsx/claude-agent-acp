// The fork's own features (autoCompactWindow clamp, subagent model pinning)
// read these env vars, and dev shells dogfooding the fork export them —
// without this cleanup they would leak into every test's `process.env` reads
// (e.g. context-window assertions clamped by a real CLAUDE_CODE_AUTO_COMPACT_WINDOW).
// Direct assignment (not vi.stubEnv) so a test's own stubEnv/unstubAllEnvs
// round-trip restores these clean values, not the shell's.
process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "";
process.env.CLAUDE_CODE_SUBAGENT_MODEL = "";
