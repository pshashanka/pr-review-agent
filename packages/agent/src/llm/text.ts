/** Keeps at most `maxBytes` of UTF-8 from the start of `text`, cutting at a line break. */
export function keepWithinBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const cut = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
  const lastNewline = cut.lastIndexOf("\n");
  return { text: lastNewline > 0 ? cut.slice(0, lastNewline + 1) : cut, truncated: true };
}
