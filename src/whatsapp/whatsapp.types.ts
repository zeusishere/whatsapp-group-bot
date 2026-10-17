export type ConnectionState = 'disconnected' | 'connecting' | 'qr_pending' | 'connected' | 'logged_out';

/** What the owner wants: "connected" sessions are re-opened automatically on boot. */
export type DesiredState = 'connected' | 'stopped';

export interface SessionStatus {
  id: string;
  ownerId: string;
  label: string | null;
  state: ConnectionState;
  desiredState: DesiredState;
  botJid: string | null;
  botLid: string | null;
  reconnectAttempts: number;
  nextReconnectAt: number | null;
  hasQr: boolean;
  lastDisconnectCode: number | null;
  lastConnectedAt: number | null;
  /** Last heartbeat at which the socket was seen connected (epoch ms). */
  lastSeenAt: number | null;
  createdAt: number;
}

/** Response of `connect`: the status plus the QR when the device still has to be linked. */
export interface ConnectResult extends SessionStatus {
  /** Raw QR string, or null if the session is already linked / no QR arrived in time. */
  qr: string | null;
  /** PNG data URL of the QR, ready for an <img src>. */
  qrDataUrl: string | null;
}

export interface GroupInfo {
  id: string;
  subject: string;
  participants: number;
  creation: number | null;
}
