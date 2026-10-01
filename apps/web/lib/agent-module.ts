import type * as AgentModule from "@pr-review/agent";

let loaded: Promise<typeof AgentModule> | undefined;

/**
 * Loads @pr-review/agent with Node's own import(), not through the bundler.
 *
 * The agent launches mcp-repo-tools from its own node_modules and uses a
 * native SQLite addon; both break if bundled. serverExternalPackages doesn't
 * cover pnpm workspace links (they resolve outside node_modules), so server
 * code imports only types statically and gets runtime values from here.
 */
export function agentModule(): Promise<typeof AgentModule> {
  loaded ??= import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@pr-review/agent");
  return loaded;
}
