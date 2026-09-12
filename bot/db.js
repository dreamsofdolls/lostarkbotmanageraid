/**
 * db.js
 * Manages a single shared Mongoose connection to MongoDB.
 * Uses a lazy-connect pattern so the connection is established
 * on first use rather than at startup.
 */

const mongoose = require("mongoose");
const dns = require("node:dns");

let connected = false;
let connectionPromise = null;
let listenersAttached = false;

async function ensureApplicationIndexes() {
  if (process.env.MONGO_ENSURE_INDEXES === "false") return;

  const started = Date.now();
  try {
    const User = require("./models/user");
    const GuildConfig = require("./models/guildConfig");
    const LocalSyncPreview = require("./models/localSyncPreview");
    await Promise.all([
      User.createIndexes(),
      GuildConfig.createIndexes(),
      LocalSyncPreview.createIndexes(),
    ]);
    console.log(`[db] Ensured Mongo indexes in ${Date.now() - started}ms`);
  } catch (err) {
    // Index creation is a performance/ops aid, not a correctness gate.
    // Keep the bot online even if the Mongo user lacks index privileges.
    console.warn("[db] Mongo index ensure failed:", err?.message || err);
  }
}

/**
 * Connect to MongoDB if not already connected.
 * Overlapping callers share one attempt, including DNS fallback and index setup.
 */
async function connectDB() {
  if (connectionPromise) return connectionPromise;
  if (connected) return;
  connectionPromise = Promise.resolve().then(openConnection).finally(() => {
    connectionPromise = null;
  });
  return connectionPromise;
}

async function openConnection() {
  const mongoUri = process.env.MONGO_URI;
  const mongoDbName = process.env.MONGO_DB_NAME || "manage";
  const dnsServers = process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1";

  if (!mongoUri) {
    throw new Error("Missing MONGO_URI in .env");
  }

  try {
    await mongoose.connect(mongoUri, { dbName: mongoDbName });
  } catch (error) {
    const isDnsRefused = error?.code === "ECONNREFUSED" && ["querySrv", "queryA", "queryAAAA"].includes(error?.syscall);

    if (!isDnsRefused) throw error;

    const fallbackServers = dnsServers
      .split(",")
      .map((server) => server.trim())
      .filter(Boolean);

    if (fallbackServers.length === 0) throw error;

    console.warn(
      `[db] DNS lookup failed (${error.syscall} ${error.code}). Retrying with DNS servers: ${fallbackServers.join(", ")}`
    );

    dns.setServers(fallbackServers);
    await mongoose.connect(mongoUri, { dbName: mongoDbName });
  }

  connected = true;

  const { host, port, name } = mongoose.connection;
  console.log(`[db] Connected to MongoDB at ${host}:${port}/${name}`);

  if (!listenersAttached) {
    listenersAttached = true;
    mongoose.connection.on("disconnected", () => {
      connected = false;
      console.warn("[db] MongoDB disconnected");
    });

    mongoose.connection.on("error", (err) => {
      console.error("[db] MongoDB error:", err.message);
    });
  }

  await ensureApplicationIndexes();
}

async function disconnectDB() {
  if (connectionPromise) await connectionPromise.catch(() => {});
  if (mongoose.connection.readyState === 0) {
    connected = false;
    return;
  }

  await mongoose.disconnect();
  connected = false;
}

module.exports = {
  connectDB,
  disconnectDB,
};
