#!/usr/bin/env node

/**
 * Initialize a workspace for Agent Bridge.
 *
 * Usage:
 *   npx mcp-agent-bridge init <workspace-id> [--url <bridge-url>]
 *
 * Examples:
 *   npx mcp-agent-bridge init desktop-api
 *   npx mcp-agent-bridge init laptop-frontend --url https://agent-bridge.mcp.mycluster.cyou
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
  process.exit(1);
}

const workspaceId = args[1];
const urlIdx = args.indexOf("--url");
const bridgeUrl = urlIdx !== -1 ? args[urlIdx + 1] : "http://localhost:4100";
const cwd = process.cwd();

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = resolve(__dirname, "check-inbox-http.js");

// 1. Create/update .mcp.json (merges — preserves other MCP servers)
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
  headers: { "x-workspace-id": workspaceId },
};
writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
console.log(`✓ .mcp.json — workspace_id: "${workspaceId}", url: ${bridgeUrl}/sse`);

// 2. Create/update .claude/settings.json (merges — preserves existing hooks and settings)
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

const escapedScript = hookScript.replace(/\\/g, "\\\\");
const promptHookEntry = {
  matcher: "",
  hooks: [{ type: "command", command: `node ${escapedScript}`, timeout: 5000 }],
};
const stopHookEntry = {
  matcher: "",
  hooks: [{ type: "command", command: `AGENT_BRIDGE_HOOK_MODE=stop node ${escapedScript}`, timeout: 5000 }],
};

settings.hooks = settings.hooks || {};
for (const event of ["UserPromptSubmit", "Stop"]) {
  settings.hooks[event] = settings.hooks[event] || [];
  settings.hooks[event] = settings.hooks[event].filter(
    (h) => !h.hooks?.some((hook) => hook.command?.includes("check-inbox"))
  );
  settings.hooks[event].push(event === "Stop" ? stopHookEntry : promptHookEntry);
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`✓ .claude/settings.json — hooks: UserPromptSubmit + Stop`);

// 3. Register with the bridge
try {
  const regRes = await fetch(`${bridgeUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace_id: workspaceId,
      description: `Workspace ${workspaceId}`,
      machine: (await import("os")).hostname(),
    }),
  });
  if (regRes.ok) {
    const data = await regRes.json();
    console.log(`✓ Registered with bridge — ${data.active_workspaces?.length || 0} other workspace(s) online`);
  } else {
    console.log(`⚠ Could not register (bridge may be offline) — will auto-register when Claude connects`);
  }
} catch {
  console.log(`⚠ Could not reach bridge at ${bridgeUrl} — will auto-register when Claude connects`);
}

console.log("");
console.log(`Done! Restart Claude Code in this workspace to activate.`);
console.log(`Other workspaces can reach you as "${workspaceId}".`);
