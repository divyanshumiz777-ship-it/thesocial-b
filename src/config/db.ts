import mongoose from "mongoose";

export const MONGO_POOL_CONFIG = { maxPoolSize: 50, minPoolSize: 5 };

// Connection-pool observability for the admin system-health "dependencies"
// view. CMAP events are client-side counters, always available regardless
// of the DB user's privileges — unlike db.serverStatus(), which needs a
// monitoring role many hosted/shared clusters (including Atlas free/shared
// tiers) don't grant.
const poolStats = { created: 0, closed: 0, checkedOut: 0, checkedIn: 0, poolCleared: 0 };
export function getMongoPoolStats() {
  return { ...poolStats, active: Math.max(0, poolStats.checkedOut - poolStats.checkedIn) };
}

export const connectDB = async (): Promise<void> => {
  try {
    const url = process.env.MONGO_URI;
    if (!url) {
      throw new Error("MONGO_URI is not defined in the environment");
    }

    const conn = await mongoose.connect(url, {
      ...MONGO_POOL_CONFIG,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      readPreference: "primaryPreferred",
    });
    console.log(`✅ MongoDB connected => ${conn.connection.host}`);

    const client = conn.connection.getClient();
    client.on("connectionCreated", () => poolStats.created++);
    client.on("connectionClosed", () => poolStats.closed++);
    client.on("connectionCheckedOut", () => poolStats.checkedOut++);
    client.on("connectionCheckedIn", () => poolStats.checkedIn++);
    client.on("connectionPoolCleared", () => poolStats.poolCleared++);
  } catch (error) {
    console.error("❌ MongoDB Connection Error =>", error);
    process.exit(1);
  }
};
