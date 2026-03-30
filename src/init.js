#!/usr/bin/env node

/**
 * Initialize a workspace for Agent Bridge.
 *
 * Usage:
 *   npx mcp-agent-bridge init my-workspace
 *   npx mcp-agent-bridge init my-workspace --url https://agent-bridge.mcp.mycluster.cyou
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);

if (args[0] !== "init" || !args[1]) {
  console.log("Usage: mcp-agent-bridge init <workspace-id> [--url <bridge-url>]");
  console.log("");
  console.log("Examples:");
  console.log("  npx mcp-agent-bridge init desktop-api");
  console.log("  npx mcp-agent-bridge init laptop-frontend --url https://agent-bridge.mcp.mycluster.cyou");
  console.log("  npx mcp-agent-bridge init my-workspace --url http://localhost:4100");
  process.exit(1);
}

const workspaceId = args[1];
const urlIdx = args.indexOf("--url");
const bridgeUrl = urlIdx !== -1 ? args[urlIdx + 1] : "http://localhost:4100";
const cwd = process.cwd();

// Find the check-inbox-http.js path (relative to this package)
const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = resolve(__dirname, "check-inbox-http.js");

// 1. Create/update .mcp.json
const mcpPath = resolve(cwd, ".mcp.json");
let mcpConfig = {};
if (existsSync(mcpPath)) {
  try {
    mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
  } catch {}
}
mcpConfig.mcpServers = mcpConfig.mcpServers || {};
mcpConfig.mcpServers["agent-bridge"] = {
  type: "sse",
  url: `${bridgeUrl}/sse`,
  headers: {
    "x-workspace-id": workspaceId,
  },
};
writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
console.log(`✓ .mcp.json — workspace_id: "${workspaceId}", url: ${bridgeUrl}/sse`);

// 2. Create/update .claude/settings.json
const claudeDir = resolve(cwd, ".claude");
const settingsPath = resolve(claudeDir, "settings.json");
if (!existsSync(claudeDir)) {
  mkdirSync(claudeDir, { recursive: true });
}

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {}
}

const hookCommand = `node ${hookScript.replace(/\\/g, "\\\\")}`;
const hookEntry = {
  matcher: "",
  hooks: [{ type: "command", command: hookCommand, timeout: 5000 }],
};

settings.hooks = settings.hooks || {};
settings.hooks.UserPromptSubmit = [hookEntry];
settings.hooks.Stop = [hookEntry];

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`✓ .claude/settings.json — hooks: UserPromptSubmit + Stop`);

console.log("");
console.log(`Done! Restart Claude Code in this workspace to activate.`);
console.log(`Other workspaces can reach you as "${workspaceId}".`);
