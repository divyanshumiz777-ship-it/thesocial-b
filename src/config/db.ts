import mongoose from "mongoose";

export const connectDB = async (): Promise<void> => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error("MONGO_URI is not defined in the environment");
    }

    const conn = await mongoose.connect(uri);
    console.log(`✅ MongoDB connected => ${conn.connection.host}`);
  } catch (error) {
    console.error("❌ MongoDB Connection Error =>", error);
    process.exit(1);
  }
};
