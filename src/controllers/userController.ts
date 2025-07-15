import mongoose from "mongoose";
import { Context } from "hono";
import User from "../models/User.ts";

export const getAllUsers = async (c: Context) => {
  try {
    const users = await User.find();
    if (users.length === 0) {
      return c.json({ message: "No users found" }, 404);
    }
    return c.json({ users }, 200);
  } catch (error) {
    console.error("Error fetching users:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getUser = async (c: Context) => {
  const { id } = c.req.param();

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return c.json({ message: "No user found" }, 404);
    }
    return c.json({ user }, 200);
  } catch (error) {
    console.error("Error fetching user:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const editUser = async (c: Context) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { name } = body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return c.json({ message: "No such user exists" }, 404);
    }

    if (name) user.name = name;
    await user.save();

    return c.json({ message: "User updated successfully", user }, 200);
  } catch (error) {
    console.error("Error updating user:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
export const deleteUser = async (c: Context) => {
  const { id } = c.req.param();

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return c.json({ error: "Invalid user ID format" }, 400);
  }

  try {
    const deletedUser = await User.findByIdAndDelete(id);

    if (!deletedUser) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({ message: "User deleted successfully" }, 200);
  } catch (error) {
    console.error("Error deleting user:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
