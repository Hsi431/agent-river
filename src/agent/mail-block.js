// Runners may preserve a final newline (or CRLF) after the closing fence.
// Share the boundary rule between delivery and presentation.
export function matchMailBlock(text) {
  return String(text || "").match(/(?:^|\r?\n)```agent-mail[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n[ \t]*)*$/);
}
