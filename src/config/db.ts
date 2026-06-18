import mongoose from "mongoose";

export const connectDB = async (): Promise<void> => {
  try {
    const url = process.env.MONGO_URI;
    if (!url) {
      throw new Error("MONGO_URI is not defined in the environment");
    }

    const conn = await mongoose.connect(url, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      readPreference: "primaryPreferred",
    });
    console.log(`✅ MongoDB connected => ${conn.connection.host}`);
  } catch (error) {
    console.error("❌ MongoDB Connection Error =>", error);
    process.exit(1);
  }
};
