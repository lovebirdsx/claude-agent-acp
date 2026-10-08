import type { FileEditInput, FileWriteInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { toolUpdateFromDiffToolResponse, v2UpdateFromDiffToolResponse } from "../../diff.js";
import { textContent, toDisplayPath } from "../content.js";
import type { ToolReporter, ToolResultFacts, ToolUseContext, ToolUseFacts } from "../facts.js";

/**
 * Write: the diff holds the file text. The PostToolUse hook sends the final
 * diff, so the result text is only a confirmation.
 */
export class WriteReporter implements ToolReporter {
  toolUse(input: unknown, { cwd, capabilities }: ToolUseContext): ToolUseFacts {
    const write = normalizeWriteInput(input);
    const displayPath = write?.file_path ? toDisplayPath(write.file_path, cwd) : undefined;
    const facts: ToolUseFacts = {
      title: displayPath ? `Write ${displayPath}` : "Preparing file…",
      kind: "edit",
      locations: write?.file_path ? [{ path: write.file_path }] : [],
    };
    if (write?.file_path) {
      // A v2 client gets the exact patch from the PostToolUse hook. The input
      // does not tell whether the file exists, so the live tool call shows no
      // diff: a diff without the old text would claim a creation. A v2 diff
      // names the operation, which the input does not tell either.
      const inputDiff = !capabilities.v2;
      if (inputDiff) {
        facts.change = [
          {
            type: "diff",
            path: write.file_path,
            oldText: null,
            // The content is absent until the input streams in. The diff still names the file.
            newText: write.content as string,
          },
        ];
      }
    } else if (write?.content) {
      facts.display = [textContent(write.content)];
    }
    return facts;
  }

  toolResult(): ToolResultFacts {
    return {};
  }

  hookResult(toolResponse: unknown, context: ToolUseContext): Promise<ToolResultFacts> {
    return finalChange(toolResponse, context);
  }
}

/** A Write input with the canonical keys. */
type NormalizedWriteInput = Partial<FileWriteInput>;

const WRITE_CONTENT_KEYS = ["content", "file_text", "file_content"] as const;

/**
 * Reads a Write input the way the CLI validates it. Since CLI 2.1.280 the CLI
 * accepts `path` for `file_path`, and `file_text` or `file_content` for
 * `content`. The streamed tool use keeps the original keys. The canonical key
 * wins when both spellings are present.
 */
export function normalizeWriteInput(input: unknown): NormalizedWriteInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const filePath =
    typeof raw.file_path === "string"
      ? raw.file_path
      : typeof raw.path === "string"
        ? raw.path
        : undefined;
  const contentKey = WRITE_CONTENT_KEYS.find((key) => raw[key] !== undefined && raw[key] !== null);
  const content = contentKey ? (raw[contentKey] as string) : undefined;
  return { file_path: filePath, content };
}

/** Edit: the diff holds the old and the new text. */
export class EditReporter implements ToolReporter {
  toolUse(input: unknown, { cwd, capabilities }: ToolUseContext): ToolUseFacts {
    const edit = input as FileEditInput | undefined;
    const displayPath = edit?.file_path ? toDisplayPath(edit.file_path, cwd) : undefined;
    const facts: ToolUseFacts = {
      title: displayPath ? `Edit ${displayPath}` : "Edit",
      kind: "edit",
      locations: edit?.file_path ? [{ path: edit.file_path }] : [],
    };
    // The standard diff: the input holds a snippet, not the file, so a patch
    // would need line numbers that the adapter does not know here. A v2 diff
    // cannot hold a snippet, so a v2 client gets the patch from the
    // PostToolUse hook alone.
    if (edit?.file_path && (edit.old_string || edit.new_string) && !capabilities.v2) {
      facts.change = [
        {
          type: "diff",
          path: edit.file_path,
          oldText: edit.old_string || null,
          newText: edit.new_string ?? "",
        },
      ];
    }
    return facts;
  }

  toolResult(): ToolResultFacts {
    return {};
  }

  hookResult(toolResponse: unknown, context: ToolUseContext): Promise<ToolResultFacts> {
    return finalChange(toolResponse, context);
  }
}

/**
 * The final change of an Edit or a Write, from the structuredPatch of the
 * PostToolUse `tool_response`. For Write it replaces the optimistic creation
 * diff with the real diff of an updated file. A v2 client gets a v2 diff.
 */
async function finalChange(
  toolResponse: unknown,
  { capabilities }: ToolUseContext,
): Promise<ToolResultFacts> {
  return capabilities.v2
    ? v2UpdateFromDiffToolResponse(toolResponse)
    : toolUpdateFromDiffToolResponse(toolResponse);
}
