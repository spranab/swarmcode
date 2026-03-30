import Redis from "ioredis";

const REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL || "redis://localhost:6379";
const KEY_PREFIX = process.env.AGENT_BRIDGE_PREFIX || "agent-bridge:";
const WS_CHANNEL_PREFIX = "agent-bridge:ws:";

let redis = null;

export { REDIS_URL, KEY_PREFIX, WS_CHANNEL_PREFIX };

export function getRedis() {
  if (!redis) {
    redis = new Redis(REDIS_URL, { keyPrefix: KEY_PREFIX, lazyConnect: true });
  }
  return redis;
}

/**
 * Create a new subscriber for a workspace channel.
 * Each SSE session gets its own subscriber so it can subscribe/unsubscribe independently.
 */
export function createSubscriber() {
  return new Redis(REDIS_URL, { lazyConnect: true });
}

export async function connect() {
  await getRedis().connect();
}

export async function disconnect() {
  if (redis) await redis.quit();
}
