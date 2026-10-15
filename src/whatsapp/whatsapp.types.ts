export type ConnectionState = 'disconnected' | 'connecting' | 'qr_pending' | 'connected';

export interface WhatsappStatus {
  state: ConnectionState;
  botJid: string | null;
  botLid: string | null;
  botName: string;
  reconnectAttempts: number;
  nextReconnectAt: number | null;
  hasQr: boolean;
  lastDisconnectCode: number | null;
}

export interface GroupInfo {
  id: string;
  subject: string;
  participants: number;
  creation: number | null;
}
