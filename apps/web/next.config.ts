import type { NextConfig } from "next";

const config: NextConfig = {
  // The agent spawns the MCP server from its own node_modules and uses a
  // native SQLite addon, so it is loaded with Node's require, not bundled.
  serverExternalPackages: ["@pr-review/agent"],
};

export default config;
