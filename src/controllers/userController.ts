import mongoose from "mongoose";
import { Context } from "hono";
import User from "../models/User.ts";
import DiscordServer from "../models/DiscordServer.ts";

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

export const joinServer = async (c: Context) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { serverId } = body;

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid user ID or server ID format" }, 400);
  }

  const serverExists = await DiscordServer.findById(serverId);
  if (!serverExists) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { $addToSet: { servers: serverId } },
      { new: true }
    );
    const updatedServer = await DiscordServer.findByIdAndUpdate(serverId, {
      $addToSet: { members: { user: id, roles: ["member"] } },
    });
    if (!updatedUser) {
      return c.json({ error: "User not found" }, 404);
    }
    return c.json(
      { message: "Joined server successfully", server: updatedServer },
      200
    );
  } catch (error) {
    console.error("Error joining server:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const leaveServer = async (c: Context) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { serverId } = body;

  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(serverId)
  ) {
    return c.json({ error: "Invalid user ID or server ID format" }, 400);
  }

  const serverExists = await User.findById(serverId);
  if (!serverExists) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const user = await User.findById(id);
    if (!user) {
      return c.json({ message: "No such user exists" }, 404);
    }

    if (user.servers?.includes(serverId)) {
      user.servers = user.servers.filter(
        (server) => server.toString() !== serverId
      );
      await user.save();
      await DiscordServer.findByIdAndUpdate(serverId, {
        $pull: { members: { user: id } },
      });
      return c.json({ message: "Left server successfully", user }, 200);
    } else {
      return c.json({ message: "Not a member of this server" }, 400);
    }
  } catch (error) {
    console.error("Error leaving server:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
};
