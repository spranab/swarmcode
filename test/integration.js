#!/usr/bin/env node

/**
 * Integration test for SwarmCode.
 * Tests Redis-level message passing between simulated workspaces.
 */

import Redis from "ioredis";

const REDIS_URL = process.env.SWARMCODE_REDIS_URL || "redis://localhost:6379";
const PREFIX = "swarmcode:";
const WS_CHANNEL_PREFIX = "swarmcode:ws:";

const redis = new Redis(REDIS_URL, { keyPrefix: PREFIX });
const rawRedis = new Redis(REDIS_URL);

async function cleanup() {
  const keys = await rawRedis.keys(`${PREFIX}*`);
  if (keys.length) await rawRedis.del(...keys);
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

async function register(id, description) {
  const ws = { id, description, machine: "test", registered_at: new Date().toISOString(), last_active: new Date().toISOString() };
  await redis.hset("workspaces", id, JSON.stringify(ws));
}

async function send(from, to, content, type = "info", priority = "normal") {
  const msg = { id: `msg-${Date.now()}-${Math.random()}`, from, to, type, content, metadata: {}, priority, timestamp: new Date().toISOString(), read: false };
  if (to === "*") {
    const workspaces = await redis.hgetall("workspaces");
    for (const wsId of Object.keys(workspaces)) {
      if (wsId !== from) {
        await redis.lpush(`inbox:${wsId}`, JSON.stringify(msg));
      }
    }
    await rawRedis.publish(`${WS_CHANNEL_PREFIX}broadcast`, JSON.stringify(msg));
  } else {
    await redis.lpush(`inbox:${to}`, JSON.stringify(msg));
    await rawRedis.publish(`${WS_CHANNEL_PREFIX}${to}`, JSON.stringify(msg));
  }
  return msg;
}

async function receive(workspaceId) {
  const raw = await redis.lrange(`inbox:${workspaceId}`, 0, -1);
  const messages = raw.map((m) => JSON.parse(m)).reverse();
  await redis.del(`inbox:${workspaceId}`);
  return messages;
}

async function main() {
  await cleanup();

  console.log("\n🔧 SwarmCode Integration Tests\n");

  // --- Register ---
  console.log("Register:");

  await test("workspace A registers", async () => {
    await register("desktop-api", "Building REST API");
    const raw = await redis.hget("workspaces", "desktop-api");
    const ws = JSON.parse(raw);
    assert(ws.id === "desktop-api", "id should match");
  });

  await test("workspace B registers", async () => {
    await register("laptop-frontend", "Building React frontend");
    const raw = await redis.hget("workspaces", "laptop-frontend");
    assert(raw, "should be registered");
  });

  // --- Status ---
  console.log("\nStatus:");

  await test("shows both workspaces", async () => {
    const raw = await redis.hgetall("workspaces");
    const ids = Object.keys(raw).sort();
    assert(ids.length === 2, `expected 2 workspaces, got ${ids.length}`);
    assert(ids[0] === "desktop-api", "should have desktop-api");
    assert(ids[1] === "laptop-frontend", "should have laptop-frontend");
  });

  // --- Send / Receive ---
  console.log("\nMessaging:");

  await test("A sends message to B", async () => {
    const msg = await send("desktop-api", "laptop-frontend", "User API is ready at /api/users", "info", "high");
    assert(msg.id, "should have message id");
  });

  await test("A sends another message to B", async () => {
    await send("desktop-api", "laptop-frontend", "Using JWT for auth tokens", "decision");
  });

  await test("B receives both messages", async () => {
    const msgs = await receive("laptop-frontend");
    assert(msgs.length === 2, `expected 2 messages, got ${msgs.length}`);
    assert(msgs[0].content.includes("User API"), "first message content");
    assert(msgs[1].content.includes("JWT"), "second message content");
  });

  await test("B has no more messages after reading", async () => {
    const msgs = await receive("laptop-frontend");
    assert(msgs.length === 0, `expected 0 messages, got ${msgs.length}`);
  });

  await test("A has no messages (was the sender)", async () => {
    const msgs = await receive("desktop-api");
    assert(msgs.length === 0, `expected 0 messages, got ${msgs.length}`);
  });

  // --- Broadcast ---
  console.log("\nBroadcast:");

  await test("B broadcasts to all", async () => {
    await send("laptop-frontend", "*", "Does anyone have the DB schema?", "question");
  });

  await test("A receives broadcast", async () => {
    const msgs = await receive("desktop-api");
    assert(msgs.length === 1, `expected 1, got ${msgs.length}`);
    assert(msgs[0].content.includes("DB schema"), "broadcast content");
    assert(msgs[0].from === "laptop-frontend", "from should be B");
  });

  await test("B does NOT receive own broadcast", async () => {
    const msgs = await receive("laptop-frontend");
    assert(msgs.length === 0, `expected 0, got ${msgs.length}`);
  });

  // --- Pub/Sub ---
  console.log("\nPub/Sub channels:");

  await test("direct message publishes to workspace channel", async () => {
    let received = null;
    const sub = new Redis(REDIS_URL);
    await sub.subscribe(`${WS_CHANNEL_PREFIX}laptop-frontend`);
    const promise = new Promise((resolve) => {
      sub.on("message", (ch, raw) => {
        received = JSON.parse(raw);
        resolve();
      });
    });
    await send("desktop-api", "laptop-frontend", "Channel test");
    await Promise.race([promise, new Promise((r) => setTimeout(r, 2000))]);
    await sub.quit();
    assert(received, "should receive on workspace channel");
    assert(received.content === "Channel test", "content should match");
  });

  await test("broadcast publishes to broadcast channel", async () => {
    let received = null;
    const sub = new Redis(REDIS_URL);
    await sub.subscribe(`${WS_CHANNEL_PREFIX}broadcast`);
    const promise = new Promise((resolve) => {
      sub.on("message", (ch, raw) => {
        received = JSON.parse(raw);
        resolve();
      });
    });
    await send("desktop-api", "*", "Broadcast channel test");
    await Promise.race([promise, new Promise((r) => setTimeout(r, 2000))]);
    await sub.quit();
    assert(received, "should receive on broadcast channel");
    assert(received.content === "Broadcast channel test", "content should match");
  });

  // --- Cleanup ---
  await cleanup();
  await redis.quit();
  await rawRedis.quit();

  console.log("\n" + (process.exitCode ? "❌ Some tests failed" : "✅ All tests passed") + "\n");
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
