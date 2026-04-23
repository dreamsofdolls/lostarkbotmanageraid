/**
 * db.js
 * Manages a single shared Mongoose connection to MongoDB.
 * Uses a lazy-connect pattern so the connection is established
 * on first use rather than at startup.
 */

const mongoose = require("mongoose");
const dns = require("node:dns");

let connected = false;

async function ensureApplicationIndexes() {
  if (process.env.MONGO_ENSURE_INDEXES === "false") return;

  const started = Date.now();
  try {
    const User = require("./src/schema/user");
    const GuildConfig = require("./src/schema/guildConfig");
    await Promise.all([User.createIndexes(), GuildConfig.createIndexes()]);
    console.log(`[db] Ensured Mongo indexes in ${Date.now() - started}ms`);
  } catch (err) {
    // Index creation is a performance/ops aid, not a correctness gate.
    // Keep the bot online even if the Mongo user lacks index privileges.
    console.warn("[db] Mongo index ensure failed:", err?.message || err);
  }
}

/**
 * Connect to MongoDB if not already connected.
 * Safe to call multiple times – subsequent calls are no-ops.
 */
async function connectDB() {
  if (connected) return;

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

  await ensureApplicationIndexes();

  mongoose.connection.on("disconnected", () => {
    connected = false;
    console.warn("[db] MongoDB disconnected");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[db] MongoDB error:", err.message);
  });
}

module.exports = {
  connectDB,
};
