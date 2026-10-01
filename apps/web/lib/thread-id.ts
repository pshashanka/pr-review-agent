/**
 * Web thread ids are `<repo name>|<agent thread id>`, so any request can find
 * the repo (and its agent) from the id alone, even after a server restart.
 */
export function webThreadId(repo: string, agentThreadId: string): string {
  return `${repo}|${agentThreadId}`;
}

export function parseWebThreadId(id: string): { repo: string } | null {
  const separator = id.indexOf("|");
  return separator <= 0 ? null : { repo: id.slice(0, separator) };
}
