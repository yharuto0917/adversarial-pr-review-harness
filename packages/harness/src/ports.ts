/**
 * ハーネスが外界に触れるための境界。
 * ここに Cloudflare 固有の型を持ち込まないこと（harness の移植性を保つため）。
 */

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** サンドボックス（fs / shell）への出口。 */
export interface SandboxPort {
  exec(command: string): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
}

/** GitHub への出口。 */
export interface GitHubPort {
  getDiff(): Promise<string>;
  postReview(body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
}

/** セッション永続化の出口。 */
export interface SessionStorePort {
  load(sessionId: string): Promise<string | null>;
  save(sessionId: string, snapshot: string): Promise<void>;
}

/** ループが依存するポートの束。 */
export interface HarnessPorts {
  readonly sandbox: SandboxPort;
  readonly github: GitHubPort;
  readonly sessions: SessionStorePort;
}
