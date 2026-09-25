export const ROOM_PHOTO_BUDGET_BYTES = 48 * 1024 * 1024;
export const ROOM_PHOTO_BUDGET_PIXELS = 36 * 1024 * 1024;
export const ROOM_LIMITS = Object.freeze({
  members: 4, pendingMembers: 8, roomSeconds: 7200, admissionSeconds: 300,
  statePollMs: 5000, signalPollMs: 1000, negotiationSeconds: 60,
  signalTtlSeconds: 60, signalPage: 16, roomSignals: 64, memberSignals: 16,
  sdpBytes: 32768, iceBytes: 4096, bodyBytes: 40000,
  captureLeadMinMs: 3000, captureLeadMaxMs: 30000, commitLeadMs: 1000,
  totalPhotoBytes: ROOM_PHOTO_BUDGET_BYTES, totalPhotoPixels: ROOM_PHOTO_BUDGET_PIXELS,
});

export type RoomRole = "A" | "B" | "C" | "D";
export type RoomAction = "state" | "admit" | "remove" | "lock" | "end" | "signal" | "poll" | "prepare" | "ack" | "commit" | "abort" | "capture";
export interface RoomDeliveryProfile { maxPhotoBytes: number; maxPhotoPixels: number; shotsPerMember: number }
export interface RoomCaptureProposal {
  captureId: string; rosterRevision: number; recipeHash: string; shotIds: string[];
  fireAt: number; intervalMs: number; profile: RoomDeliveryProfile;
}
export interface RoomCapture extends RoomCaptureProposal {
  memberIds: string[]; acks: string[]; state: "prepared" | "committed" | "aborted";
}
export interface RoomState {
  roomId: string; code: string; sessionId: string; hostId: string; selfId: string;
  selfRole: RoomRole | null; connectionEpoch: string; status: "open" | "ended"; locked: boolean;
  rosterRevision: number; expiresAt: number; serverNow: number;
  members: { id: string; role: RoomRole | null; displayName: string; status: "pending" | "admitted" | "removed"; connectionEpoch: string }[];
  capture: RoomCapture | null;
}
export interface RoomSignalInput {
  messageId: string; toMemberId: string; kind: "sdp" | "ice";
  connectionEpoch: string; payload: string;
}
export interface RoomSignal extends RoomSignalInput { id: number; fromMemberId: string; createdAt: number }
export interface RoomSignalPage { signals: RoomSignal[]; cursor: number; serverNow: number; resetRequired: boolean }
export type RoomErrorCode = "unavailable" | "invalid_request" | "origin_denied" | "access_denied" | "room_full" | "rate_limited" | "state_conflict" | "not_ready";
