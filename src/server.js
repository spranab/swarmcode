#!/usr/bin/env node

/**
 * SwarmCode CLI entry point.
 *
 * Usage:
 *   swarmcode init <workspace-id> [--redis <redis-url>]
 *   swarmcode channel   (starts the MCP server — normally spawned by Claude Code)
 *   swarmcode listen    (starts the one-shot Redis listener — background task)
 *   swarmcode check     (quick inbox check — used by hooks)
 */

const cmd = process.argv[2];

if (cmd === "init") {
  await import("./init.js");
} else if (cmd === "channel") {
  await import("./channel.js");
} else if (cmd === "listen") {
  await import("./listener.js");
} else if (cmd === "check") {
  await import("./check-inbox-http.js");
} else {
  console.log("SwarmCode — real-time networking between Claude Code instances\n");
  console.log("Usage:");
  console.log("  swarmcode init <workspace-id> --redis <redis-url>");
  console.log("  swarmcode channel    (MCP server — spawned by Claude Code)");
  console.log("  swarmcode listen     (background Redis listener)");
  console.log("  swarmcode check      (quick inbox check for hooks)\n");
  console.log("Quick start:");
  console.log("  npm install -g swarmcode");
  console.log("  swarmcode init my-workspace --redis redis://your-redis:6379");
}
