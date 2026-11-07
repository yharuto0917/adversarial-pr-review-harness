import type { SessionStorePort } from "./ports.js";

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly iteration: number;
  readonly transcript: readonly string[];
}

/**
 * セッションを復元する。存在しなければ初期状態を返す。
 * TODO: 実装。
 */
export function restoreSession(
  _store: SessionStorePort,
  _sessionId: string,
): Promise<SessionSnapshot> {
  throw new Error("not implemented: restoreSession");
}

/**
 * 長くなったトランスクリプトを要約して圧縮する。
 * TODO: 実装。
 */
export function compactSession(_snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  throw new Error("not implemented: compactSession");
}
