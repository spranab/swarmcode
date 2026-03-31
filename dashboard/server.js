#!/usr/bin/env node

import express from "express";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.DASHBOARD_PORT || "4200", 10);
const REDIS_URL = process.env.SWARMCODE_REDIS_URL || "redis://localhost:6379";
const USERNAME = process.env.DASHBOARD_USER || "admin";
const PASSWORD = process.env.DASHBOARD_PASS || "bridge";
const KEY_PREFIX = "swarmcode:";
const WS_CHANNEL_PREFIX = "swarmcode:ws:";

const redis = new Redis(REDIS_URL, { keyPrefix: KEY_PREFIX });
const publisher = new Redis(REDIS_URL);
const subscriber = new Redis(REDIS_URL);

const app = express();
app.use(express.json());

// --- Basic Auth ---
app.use((req, res, next) => {
  // Skip auth for SSE and health
  if (req.path === "/health") return next();

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="SwarmCode Dashboard"');
    return res.status(401).send("Authentication required");
  }
  const [user, pass] = Buffer.from(auth.split(" ")[1], "base64").toString().split(":");
  if (user !== USERNAME || pass !== PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="SwarmCode Dashboard"');
    return res.status(401).send("Invalid credentials");
  }
  next();
});

// --- Static HTML ---
app.get("/", (_req, res) => {
  res.send(readFileSync(resolve(__dirname, "index.html"), "utf-8"));
});

// --- API ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/workspaces", async (_req, res) => {
  const raw = await redis.hgetall("workspaces");
  const workspaces = Object.values(raw).map((v) => JSON.parse(v));
  for (const ws of workspaces) {
    ws.pending_messages = await redis.llen(`inbox:${ws.id}`);
  }
  workspaces.sort((a, b) => new Date(b.last_active) - new Date(a.last_active));
  res.json(workspaces);
});

app.get("/api/inbox/:id", async (req, res) => {
  const raw = await redis.lrange(`inbox:${req.params.id}`, 0, -1);
  const messages = raw.map((m) => JSON.parse(m)).reverse();
  res.json(messages);
});

app.get("/api/log", async (_req, res) => {
  const raw = await redis.lrange("messages:log", 0, 99);
  const messages = raw.map((m) => JSON.parse(m));
  res.json(messages);
});

app.post("/api/send", async (req, res) => {
  const { from, to, content, type, priority } = req.body;
  if (!from || !to || !content) {
    return res.status(400).json({ error: "from, to, content required" });
  }

  const msg = {
    id: uuidv4(),
    from: from || "dashboard",
    to,
    type: type || "info",
    content,
    metadata: { source: "dashboard" },
    priority: priority || "normal",
    timestamp: new Date().toISOString(),
    read: false,
  };

  if (to === "*") {
    const workspaces = await redis.hgetall("workspaces");
    for (const wsId of Object.keys(workspaces)) {
      if (wsId !== from) {
        await redis.lpush(`inbox:${wsId}`, JSON.stringify(msg));
        await redis.expire(`inbox:${wsId}`, 86400);
      }
    }
    await publisher.publish(`${WS_CHANNEL_PREFIX}broadcast`, JSON.stringify(msg));
  } else {
    await redis.lpush(`inbox:${to}`, JSON.stringify(msg));
    await redis.expire(`inbox:${to}`, 86400);
    await publisher.publish(`${WS_CHANNEL_PREFIX}${to}`, JSON.stringify(msg));
  }

  // Store in log
  await redis.lpush("messages:log", JSON.stringify(msg));
  await redis.ltrim("messages:log", 0, 499);

  res.json({ status: "sent", message_id: msg.id });
});

// --- SSE for real-time updates ---
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const sub = new Redis(REDIS_URL);
  sub.psubscribe(`${WS_CHANNEL_PREFIX}*`);
  sub.on("pmessage", (_pattern, channel, raw) => {
    try {
      const msg = JSON.parse(raw);
      res.write(`data: ${JSON.stringify({ channel: channel.replace(WS_CHANNEL_PREFIX, ""), ...msg })}\n\n`);
    } catch {}
  });

  req.on("close", () => {
    sub.quit();
  });
});

app.listen(PORT, () => {
  console.log(`SwarmCode Dashboard: http://0.0.0.0:${PORT}`);
  console.log(`  Redis: ${REDIS_URL}`);
  console.log(`  Auth: ${USERNAME} / ${"*".repeat(PASSWORD.length)}`);
});
