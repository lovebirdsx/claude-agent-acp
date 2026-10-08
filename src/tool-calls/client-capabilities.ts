import type { ClientCapabilities as AcpClientCapabilities } from "@agentclientprotocol/sdk";

/**
 * The client choices that decide the shape of a tool call report.
 *
 * The agent reads them once from `initialize.clientCapabilities`. The public
 * `toAcpNotifications` functions take the ACP capabilities and read them on
 * each call. The {@link AcpToolCallRenderer} reads nothing else, so one object
 * holds every capability choice of a tool call report.
 */
export class ClientCapabilities {
  constructor(
    /** The client renders a terminal from `_meta.terminal_info`, `terminal_output`, and `terminal_exit`. */
    readonly terminalOutput: boolean = false,
    /** The client appends `_meta.terminal_output_delta` instead of `terminal_output` chunks. */
    readonly terminalOutputDelta: boolean = false,
    /**
     * The client speaks ACP v2. Its diffs carry structured `changes` and an
     * optional git patch, which a v1 diff cannot express. Only the v2 surface
     * sets this, never the capabilities that a client sends. A v2 client also
     * takes the terminal extension (`terminalOutput`), which the v2 surface
     * sends as display terminals.
     */
    readonly v2: boolean = false,
  ) {}

  static from(
    capabilities: AcpClientCapabilities | null | undefined,
    { v2 = false }: { v2?: boolean } = {},
  ): ClientCapabilities {
    const meta = capabilities?._meta;
    const terminalOutputDelta = meta?.["terminal_output_delta"] === true;
    return new ClientCapabilities(
      v2 || terminalOutputDelta || meta?.["terminal_output"] === true,
      terminalOutputDelta,
      v2,
    );
  }
}
