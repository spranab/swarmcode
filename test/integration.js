#!/usr/bin/env node

/**
 * Integration test: simulates two workspaces communicating via Agent Bridge.
 * Requires the server to NOT be running (this test uses stdio mode directly).
 */

import Redis from "ioredis";
import { connect, disconnect } from "../src/redis.js";
import { toolDefinitions, handleTool } from "../src/tools.js";

const REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL || "redis://localhost:6379";
const PREFIX = "agent-bridge:";

async function cleanup() {
  const raw = new Redis(REDIS_URL);
  const keys = await raw.keys(`${PREFIX}*`);
  if (keys.length) await raw.del(...keys);
  await raw.quit();
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function main() {
  await connect();
  // No global subscriber — per-workspace channels handled by server.js
  await cleanup();

  console.log("\n🔧 Agent Bridge Integration Tests\n");

  // --- Register ---
  console.log("Register:");

  await test("workspace A registers", async () => {
    const res = parse(
      await handleTool("register", {
        workspace_id: "desktop-api",
        description: "Building REST API",
        machine: "desktop",
      })
    );
    assert(res.status === "registered", "should be registered");
    assert(res.workspace.id === "desktop-api", "id should match");
  });

  await test("workspace B registers", async () => {
    const res = parse(
      await handleTool("register", {
        workspace_id: "laptop-frontend",
        description: "Building React frontend",
        machine: "laptop",
      })
    );
    assert(res.status === "registered", "should be registered");
  });

  // --- Status ---
  console.log("\nStatus:");

  await test("shows both workspaces", async () => {
    const res = parse(await handleTool("status", {}));
    assert(res.workspace_count === 2, `expected 2 workspaces, got ${res.workspace_count}`);
    const ids = res.workspaces.map((w) => w.id).sort();
    assert(ids[0] === "desktop-api", "should have desktop-api");
    assert(ids[1] === "laptop-frontend", "should have laptop-frontend");
  });

  // --- Send / Receive ---
  console.log("\nMessaging:");

  await test("A sends message to B", async () => {
    const res = parse(
      await handleTool("send", {
        from: "desktop-api",
        to: "laptop-frontend",
        type: "info",
        content: "User API is ready at /api/users",
        priority: "high",
      })
    );
    assert(res.status === "sent", "should be sent");
    assert(res.to === "laptop-frontend", "target should match");
  });

  await test("A sends another message to B", async () => {
    const res = parse(
      await handleTool("send", {
        from: "desktop-api",
        to: "laptop-frontend",
        type: "decision",
        content: "Using JWT for auth tokens",
      })
    );
    assert(res.status === "sent", "should be sent");
  });

  await test("B receives both messages", async () => {
    const res = parse(
      await handleTool("receive", { workspace_id: "laptop-frontend" })
    );
    assert(res.message_count === 2, `expected 2 messages, got ${res.message_count}`);
    assert(res.messages[0].content.includes("User API"), "first message content");
    assert(res.messages[1].content.includes("JWT"), "second message content");
    assert(res.messages[0].priority === "high", "priority should be high");
  });

  await test("B has no more messages after reading", async () => {
    const res = parse(
      await handleTool("receive", { workspace_id: "laptop-frontend" })
    );
    assert(res.message_count === 0, `expected 0 messages, got ${res.message_count}`);
  });

  await test("A has no messages (was the sender)", async () => {
    const res = parse(
      await handleTool("receive", { workspace_id: "desktop-api" })
    );
    assert(res.message_count === 0, `expected 0 messages, got ${res.message_count}`);
  });

  // --- Broadcast ---
  console.log("\nBroadcast:");

  await test("B broadcasts to all", async () => {
    const res = parse(
      await handleTool("send", {
        from: "laptop-frontend",
        to: "*",
        type: "question",
        content: "Does anyone have the DB schema?",
      })
    );
    assert(res.status === "sent", "broadcast should be sent");
  });

  await test("A receives broadcast", async () => {
    const res = parse(
      await handleTool("receive", { workspace_id: "desktop-api" })
    );
    assert(res.message_count === 1, `expected 1, got ${res.message_count}`);
    assert(res.messages[0].content.includes("DB schema"), "broadcast content");
    assert(res.messages[0].from === "laptop-frontend", "from should be B");
  });

  await test("B does NOT receive own broadcast", async () => {
    const res = parse(
      await handleTool("receive", { workspace_id: "laptop-frontend" })
    );
    assert(res.message_count === 0, `expected 0, got ${res.message_count}`);
  });

  // --- Artifacts ---
  console.log("\nArtifacts:");

  await test("A shares an artifact", async () => {
    const res = parse(
      await handleTool("share_artifact", {
        from: "desktop-api",
        name: "user-schema",
        type: "schema",
        content: JSON.stringify({ id: "uuid", email: "string", name: "string" }),
        description: "User table schema for the REST API",
      })
    );
    assert(res.status === "shared", "should be shared");
  });

  await test("B gets notified about the artifact", async () => {
    const res = parse(
      await handleTool("receive", { workspace_id: "laptop-frontend" })
    );
    assert(res.message_count === 1, `expected 1 notification, got ${res.message_count}`);
    assert(res.messages[0].type === "artifact", "should be artifact notification");
    assert(res.messages[0].metadata.artifact_name === "user-schema", "artifact name in metadata");
  });

  await test("B retrieves the artifact", async () => {
    const res = JSON.parse(
      (await handleTool("get_artifact", { name: "user-schema" })).content[0].text
    );
    assert(res.name === "user-schema", "name should match");
    assert(res.type === "schema", "type should match");
    const content = JSON.parse(res.content);
    assert(content.email === "string", "content should have email field");
  });

  await test("list artifacts shows the shared one", async () => {
    const res = parse(await handleTool("list_artifacts", {}));
    assert(res.count === 1, `expected 1 artifact, got ${res.count}`);
    assert(res.artifacts[0].name === "user-schema", "name should match");
  });

  // --- Update Status ---
  console.log("\nUpdate Status:");

  await test("A updates its status", async () => {
    const res = parse(
      await handleTool("update_status", {
        workspace_id: "desktop-api",
        description: "Now working on auth middleware",
        progress: "60% complete",
      })
    );
    assert(res.status === "updated", "should be updated");
    assert(res.workspace.progress === "60% complete", "progress should match");
  });

  await test("status reflects the update", async () => {
    const res = parse(await handleTool("status", {}));
    const api = res.workspaces.find((w) => w.id === "desktop-api");
    assert(api.description === "Now working on auth middleware", "description updated");
    assert(api.progress === "60% complete", "progress updated");
  });

  // --- Cleanup ---
  await cleanup();
  await disconnect();

  console.log("\n" + (process.exitCode ? "❌ Some tests failed" : "✅ All tests passed") + "\n");
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
