import { Types } from "mongoose";

export interface IUserMinimal {
  _id: Types.ObjectId;
  name: string;
  profilePic?: string;
}

export interface IBanned {
  isBanned: boolean;
  reason: string;
  bannedBy: Types.ObjectId;
}

export interface IMuted {
  isMuted: boolean;
  reason: string;
  mutedBy: Types.ObjectId;
  expiresAt: Date;
}

export interface IMember {
  user: Types.ObjectId;
  roles: string[];
  banned: IBanned;
  muted: IMuted;
}

export interface IMemberPopulated extends Omit<IMember, "user"> {
  user: IUserMinimal;
}

export interface IJoinRequest {
  user: Types.ObjectId;
  requestedAt: Date;
  status: "pending" | "approved" | "rejected";
}

export interface IPrivacy {
  showInSearch: boolean;
  allowMemberDMs: boolean;
  allowFriendRequests: boolean;
}

export interface IDiscordServer {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  categories: Types.ObjectId[];
  channels: Types.ObjectId[];
  visibility: "public" | "private" | "invite-only";
  name: string;
  description: string;
  members: IMember[];
  joinRequests?: IJoinRequest[];
  onlineCount: number;
  imageUrl: string;
  privacy?: IPrivacy;
}

export interface IDiscordServerPopulated
  extends Omit<IDiscordServer, "members" | "owner"> {
  owner: IUserMinimal;
  members: IMemberPopulated[];
}
