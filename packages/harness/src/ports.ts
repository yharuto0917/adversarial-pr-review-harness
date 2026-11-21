/**
 * ハーネスが外界に触れるための境界。
 * ここに Cloudflare 固有の型を持ち込まないこと（harness の移植性を保つため）。
 *
 * セッションの永続化・コンテキスト組み立て・ループ制御は Pi (pi-durable) が担うので、
 * ここに残るのは Pi のツールが呼び出す先だけ。
 */

import type { Finding } from "@repo/review-core";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * サンドボックスの単一コマンド実行に適用する外向き通信ポリシー。
 * LLM ツール向けの `SandboxPort` からは指定できず、`SandboxService` 境界でのみ扱う。
 */
export type SandboxEgressPolicy =
  | { readonly profile: "locked" }
  | {
      readonly profile: "checkout";
      /** `owner/name` 形式。 */
      readonly repository: string;
      /**
       * Worker 側（ContainerProxy）でオンメモリ注入する一時的な GitHub installation token。
       * コンテナのコマンド引数・環境変数・DO 永続ストレージには残さない。
       */
      readonly githubToken?: string;
      /** true の場合、チェックアウト実行前に既存コンテナを破棄してクリーンな状態から開始する。 */
      readonly resetContainer?: boolean;
    }
  | { readonly profile: "install" };

export interface SandboxExecOptions {
  readonly egress?: SandboxEgressPolicy;
}

/** サンドボックス（fs / shell）への出口。 */
export interface SandboxPort {
  exec(command: string): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
}

/**
 * 複数のサンドボックスを id で引ける、SandboxPort のリモート版。
 * runner が RPC で公開し、orchestrator が sandboxId を固定して SandboxPort に束ねる。
 */
export interface SandboxService {
  exec(sandboxId: string, command: string, options?: SandboxExecOptions): Promise<ExecResult>;
  readFile(sandboxId: string, path: string): Promise<string>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  listFiles(sandboxId: string, path: string): Promise<string[]>;
}

/** GitHub への出口。 */
export interface GitHubPort {
  getDiff(): Promise<string>;
  postReview(body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
}

/** fingerprint を計算する前の指摘。fingerprint は集計時に review-core が付ける。 */
export type FindingDraft = Omit<Finding, "fingerprint">;

/**
 * モデルが報告した指摘の出口。
 * 中断からの復帰で同じ報告が再実行されうるため、同一内容の再報告は無視すること。
 */
export interface FindingsPort {
  report(finding: FindingDraft): Promise<void>;
}

/** ツールが依存するポートの束。 */
export interface HarnessPorts {
  readonly sandbox: SandboxPort;
  readonly github: GitHubPort;
  readonly findings: FindingsPort;
}

/** sandboxId を固定して SandboxService を SandboxPort として扱う。 */
export function bindSandbox(
  service: SandboxService,
  sandboxId: string,
  defaultExecOptions?: SandboxExecOptions,
): SandboxPort {
  return {
    exec: (command) =>
      defaultExecOptions === undefined
        ? service.exec(sandboxId, command)
        : service.exec(sandboxId, command, defaultExecOptions),
    readFile: (path) => service.readFile(sandboxId, path),
    writeFile: (path, content) => service.writeFile(sandboxId, path, content),
    listFiles: (path) => service.listFiles(sandboxId, path),
  };
}
