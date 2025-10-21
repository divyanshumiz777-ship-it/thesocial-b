import mongoose from "mongoose";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-key-for-testing-only";
process.env.MONGO_URI = "mongodb://localhost:27017/discord-clone-test";
process.env.REDIS_URL = "redis://localhost:6379";

mongoose.set("strictQuery", true);
