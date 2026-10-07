import type { IceServer } from "./protocol";

/**
 * Between the main process and the hidden peer-host window, where the
 * RTCPeerConnections live (Node has no WebRTC). Main decides; the host only
 * runs connections: one per teammate, with a reliable "control" channel and
 * a lossy, ordered "stream" channel. The host never sees keys or signatures —
 * main verifies connection details before handing them over, with the DTLS
 * fingerprint the host must pin.
 */

export type Route = "direct" | "turn";

export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type HostCommand =
  /** A new connection to `peer` (replacing any other); the offerer makes the offer straight away. */
  | { op: "open"; peer: string; epoch: string; role: "offerer" | "answerer"; iceServers: IceServer[] }
  /** The peer's verified description; `fingerprint` is the DTLS certificate the connection must use. */
  | { op: "remote"; peer: string; epoch: string; description: SessionDescription; fingerprint: string }
  | { op: "candidate"; peer: string; epoch: string; candidate: IceCandidate }
  /** Offerer only: renegotiate ICE (a new network path) on the same connection. */
  | { op: "restart-ice"; peer: string; epoch: string }
  | { op: "close"; peer: string; reason: string }
  /** Reliable, ordered; queued while the channel is busy. */
  | { op: "send"; peer: string; data: string }
  /** Lossy: dropped (and counted) while the channel's buffer is full. */
  | { op: "stream"; peer: string; data: string }
  /** New ICE servers (fresh TURN credentials) for every connection. */
  | { op: "ice-servers"; iceServers: IceServer[] };

export type HostEvent =
  /** The host loaded (again): it holds no connections. */
  | { ev: "ready" }
  | { ev: "local-description"; peer: string; epoch: string; description: SessionDescription }
  | { ev: "candidate"; peer: string; epoch: string; candidate: IceCandidate }
  /** Both channels open and the peer's certificate matches the pinned fingerprint. */
  | { ev: "open"; peer: string; epoch: string; route: Route | null; fingerprint: string }
  | { ev: "state"; peer: string; epoch: string; state: string }
  | { ev: "route"; peer: string; epoch: string; route: Route | null }
  | { ev: "closed"; peer: string; epoch: string; reason: string }
  | { ev: "message"; peer: string; data: string }
  | { ev: "stream"; peer: string; data: string }
  | { ev: "congestion"; peer: string; congested: boolean; dropped: number }
  | { ev: "error"; peer?: string; epoch?: string; message: string }
  /** The machine's network changed (Wi-Fi switch, wake). */
  | { ev: "network-changed" };

/** Why the host closed a connection when the certificate didn't match. */
export const FINGERPRINT_MISMATCH = "fingerprint-mismatch";
