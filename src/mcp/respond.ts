/**
 * Response convention for a self-explaining MCP server.
 *
 * Three layers, ported from the reference implementation
 * (LOUPZ-DE/test-dcr-mcp-server, commit 1fa9ba6):
 *
 *   1. `instructions` in the InitializeResult — workflow and rules, placed in
 *      the client's system prompt BEFORE the first tool call.
 *   2. Tool descriptions that name the follow-up step.
 *   3. `nextSteps` on every response — this function.
 *
 * Two rules make layer 3 useful rather than noise, and both come from the
 * reference's README:
 *
 *   Concrete   — pre-filled call values, never abstract prose. "elo_list_folder
 *                with {"folderId":"4711"}", not "you could list the folder".
 *   Conditional — only steps that apply right now. A hint that does not fit the
 *                situation costs tokens on every call and teaches the model to
 *                ignore the field. Verbatim from the reference: "Tokens für
 *                unzutreffende Hinweise sind schlechter als keine Hinweise."
 */

export interface ToolResponse {
  content: { type: 'text'; text: string }[];
  [key: string]: unknown;
}

/**
 * Serialise a tool result, merging in follow-up steps when there are any.
 *
 * `nextSteps` is a payload convention, not a spec field — it rides inside the
 * JSON text block and is therefore client-agnostic.
 */
export function respond(payload: unknown, nextSteps?: string[]): ToolResponse {
  const body =
    nextSteps && nextSteps.length > 0 && payload && typeof payload === 'object'
      ? { ...(payload as Record<string, unknown>), nextSteps }
      : payload;
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}
