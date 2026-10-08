import { ForkSessionRequest, ForkSessionResponse } from "@agentclientprotocol/sdk";
import { forkSession as forkClaudeSession } from "@anthropic-ai/claude-agent-sdk";
import { SessionTiming } from "./session-timing.js";

type ForkSessionDependencies = {
  logger?: { log: (...args: unknown[]) => void };
};

/**
 * Fork a session at its tip, for a client that gave no fork anchor.
 *
 * The SDK's `forkSession` copies the transcript into a new session; the client
 * then loads it with `session/load`, which replays the inherited history. The
 * editor's anchored fork (`_meta.rewindTo`) is resolved in `acp-agent.ts`
 * before this helper is reached.
 */
export async function forkSession(
  params: ForkSessionRequest,
  dependencies: ForkSessionDependencies = {},
): Promise<ForkSessionResponse> {
  const timing = new SessionTiming(dependencies.logger, "fork", params.sessionId);
  const forked = await forkClaudeSession(params.sessionId, { dir: params.cwd });
  timing.phase("sdk-fork", " resolution=latest");
  return { sessionId: forked.sessionId };
}
