/**
 * ハーネスが外界に触れるための境界。
 * ここに Cloudflare 固有の型を持ち込まないこと（harness の移植性を保つため）。
 *
 * セッションの永続化・コンテキスト組み立て・ループ制御は Pi (pi-durable) が担うので、
 * ここに残るのは Pi のツールや決定論的ステップが呼び出す先だけ。
 */

import type { ExecutionMode, Finding } from "@repo/review-core";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** 実行時間の上限を超えて打ち切られたとき true。通常終了時は省略される。 */
  readonly timedOut?: boolean;
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

/** LLM ツール向け境界（`SandboxPort`）から指定可能な実行オプション。 */
export interface SandboxPortExecOptions {
  /** コマンド実行時間の上限（ミリ秒）。Runner 側でプロファイル別上限にクランプされる。 */
  readonly timeoutMs?: number;
}

export interface SandboxExecOptions extends SandboxPortExecOptions {
  readonly egress?: SandboxEgressPolicy;
}

/** サンドボックス（fs / shell）への出口。 */
export interface SandboxPort {
  exec(command: string, options?: SandboxPortExecOptions): Promise<ExecResult>;
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
  destroy(sandboxId: string): Promise<void>;
}

/** `static_only` モード中に禁止操作（setupProject / exec / writeFile）を試みた際のエラー。 */
export class StaticOnlyPolicyError extends Error {
  readonly operation: "setupProject" | "exec" | "writeFile";

  constructor(operation: "setupProject" | "exec" | "writeFile", reason?: string) {
    super(
      `sandbox.${operation} is prohibited in static_only execution mode${reason ? ` (${reason})` : ""}`,
    );
    this.name = "StaticOnlyPolicyError";
    this.operation = operation;
  }
}

export interface DiffRange {
  readonly base: string;
  readonly head: string;
}

export interface PullRequestMeta {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly title: string;
  readonly body: string | null;
  readonly authorLogin: string | null;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly defaultBranch: string;
  readonly baseRepoId: number | null;
  readonly headRepoId: number | null;
  readonly baseRepoFullName: string | null;
  readonly headRepoFullName: string | null;
  readonly isFork: boolean;
}

export interface PullRequestFileEntry {
  readonly filename: string;
  readonly previousFilename?: string | undefined;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string | undefined;
}

export interface PullRequestFilesResult {
  readonly files: readonly PullRequestFileEntry[];
  readonly truncated: boolean;
}

export interface CheckAnnotation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly annotationLevel: string;
  readonly title: string | null;
  readonly message: string;
}

export type CommitCheckStatus = "queued" | "in_progress" | "completed";

export type CommitCheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure"
  | "error";

export interface CommitCheckItem {
  readonly source: "check_run" | "commit_status";
  readonly id?: number | undefined;
  readonly name: string;
  readonly appId: number | null;
  readonly appSlug: string | null;
  readonly status: CommitCheckStatus;
  readonly conclusion: CommitCheckConclusion | null;
  readonly detailsUrl: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly text: string | null;
  readonly annotations: readonly CheckAnnotation[];
  readonly completedAt: string | null;
}

export interface CommitCheckSuiteItem {
  readonly id: number;
  readonly appId: number | null;
  readonly appSlug: string | null;
  readonly status: CommitCheckStatus;
  readonly conclusion: CommitCheckConclusion | null;
}

export interface CommitChecksSnapshot {
  readonly headSha: string;
  readonly checks: readonly CommitCheckItem[];
  readonly checkSuites: readonly CommitCheckSuiteItem[];
  readonly truncated: boolean;
}

export interface ReviewThreadComment {
  readonly id: string;
  readonly body: string;
  readonly authorLogin: string | null;
  readonly createdAt: string | null;
  readonly url: string | null;
}

export interface ReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly startLine: number | null;
  readonly diffSide: "LEFT" | "RIGHT" | null;
  readonly body: string;
  readonly fingerprint: string | null;
  readonly comments: readonly ReviewThreadComment[];
}

export interface ReviewThreadsResult {
  readonly threads: readonly ReviewThread[];
  readonly truncated: boolean;
}

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface ReviewInlineComment {
  readonly path: string;
  readonly line: number;
  readonly side?: "LEFT" | "RIGHT" | undefined;
  readonly startLine?: number | undefined;
  readonly startSide?: "LEFT" | "RIGHT" | undefined;
  readonly body: string;
}

export interface PostReviewInput {
  readonly commitId?: string | undefined;
  readonly event?: ReviewEvent | undefined;
  readonly body: string;
  readonly comments?: readonly ReviewInlineComment[] | undefined;
}

export interface PostReviewResult {
  readonly id: number | null;
}

/**
 * Agent ツールおよび Step 0 / 1 から利用可能な Read 専用 GitHub ポート。
 * Write 操作（`postReview` / `resolveThread`）はここには含めず、`GitHubWritePort` へ分離する。
 */
export interface GitHubReadPort {
  getPullRequestMeta(): Promise<PullRequestMeta>;
  getDiff(range?: DiffRange): Promise<string>;
  listPullRequestFiles(): Promise<PullRequestFilesResult>;
  getCommitChecks(headSha: string): Promise<CommitChecksSnapshot>;
  listReviewThreads(): Promise<ReviewThreadsResult>;
  getFileContent(path: string, ref: string): Promise<string | null>;
}

/** Agent ツールに露出する GitHub ポートは Read 専用に限定する。 */
export type GitHubPort = GitHubReadPort;

/** Orchestrator 専用の GitHub Write ポート。`HarnessPorts` / Agent ツールには渡さない。 */
export interface GitHubWritePort {
  postReview(input: PostReviewInput): Promise<PostReviewResult>;
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

/** ツールが依存するポートの束（GitHub は Read 専用のみ）。 */
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
    exec: (command, options) => {
      // SandboxPort 経由で egress が注入されないよう timeoutMs のみを明示的に取り出す
      const timeoutMs = options?.timeoutMs ?? defaultExecOptions?.timeoutMs;
      const egress = defaultExecOptions?.egress;
      if (egress === undefined && timeoutMs === undefined) {
        return service.exec(sandboxId, command);
      }
      return service.exec(sandboxId, command, {
        ...(egress !== undefined ? { egress } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    },
    readFile: (path) => service.readFile(sandboxId, path),
    writeFile: (path, content) => service.writeFile(sandboxId, path, content),
    listFiles: (path) => service.listFiles(sandboxId, path),
  };
}

/**
 * 実行モード（`full` / `static_only`）を動的に評価し、`static_only` 時は
 * `exec` / `writeFile` を機械的に遮断する `SandboxPort` ラッパーを作る。
 */
export function guardSandboxPort(
  sandbox: SandboxPort,
  getExecutionMode: () => ExecutionMode,
  getReason?: () => string | undefined,
): SandboxPort {
  return {
    exec: async (command, options) => {
      if (getExecutionMode() === "static_only") {
        throw new StaticOnlyPolicyError("exec", getReason?.());
      }
      return sandbox.exec(command, options);
    },
    readFile: (path) => sandbox.readFile(path),
    writeFile: async (path, content) => {
      if (getExecutionMode() === "static_only") {
        throw new StaticOnlyPolicyError("writeFile", getReason?.());
      }
      return sandbox.writeFile(path, content);
    },
    listFiles: (path) => sandbox.listFiles(path),
  };
}
