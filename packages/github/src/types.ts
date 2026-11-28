/** `@repo/github` の公開型契約とエラー型。 */

export interface AppCredentials {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId: number;
}

export type GitHubPermissionLevel = "read" | "write";

export interface InstallationTokenScope {
  /**
   * トークンのアクセス対象を限定するリポジトリ名（`owner/` を含めないリポジトリ名のみ）。
   * GitHub REST API (`POST /app/installations/{installation_id}/access_tokens`) の仕様に従う。
   */
  readonly repositories?: readonly string[];
  /** トークンに付与する権限の絞り込み（例: `{ contents: "read" }`）。 */
  readonly permissions?: Readonly<Record<string, GitHubPermissionLevel>>;
}

export type GitHubApiErrorCode =
  | "GITHUB_API_ERROR"
  | "GITHUB_DIFF_TOO_LARGE"
  | "GITHUB_PERMISSION_DENIED"
  | "GITHUB_INVALID_RESPONSE"
  | "GITHUB_GRAPHQL_ERROR";

/** GitHub REST / GraphQL API 呼び出し失敗を表す構造化エラー。 */
export class GitHubApiError extends Error {
  readonly code: GitHubApiErrorCode;
  readonly status: number;

  constructor(code: GitHubApiErrorCode, status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.code = code;
    this.status = status;
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

export interface PullRequestReadClientOptions {
  /** `owner/name` 形式。 */
  readonly repository: string;
  readonly pullNumber: number;
  /** Repo / PR Read 系 API（contents / pull_requests: read）用のトークン取得関数。 */
  readonly getToken: () => Promise<string>;
  /**
   * Check Runs / Check Suites / Commit Status（checks / statuses: read）用のトークン取得関数。
   * 省略時は `getToken` を使用する。
   */
  readonly getChecksToken?: (() => Promise<string>) | undefined;
  /** 自身の GitHub App ID。`getCommitChecks` で自身由来の Check Run / Check Suite を除外する。 */
  readonly selfAppId?: string | number | undefined;
  /** 任意。Commit Status の `context` プレフィックスで自身由来を除外したい場合に指定する。 */
  readonly selfStatusContextPrefix?: string | undefined;
}

export interface PullRequestWriteClientOptions {
  /** `owner/name` 形式。 */
  readonly repository: string;
  readonly pullNumber: number;
  /** Write 系 API（pull_requests: write）用のトークン取得関数。 */
  readonly getToken: () => Promise<string>;
}

export interface PullRequestClientOptions extends PullRequestReadClientOptions {
  /** Write 系 API 用トークンを明示分離したい場合に指定する。省略時は `getToken` を使用。 */
  readonly getWriteToken?: (() => Promise<string>) | undefined;
}

/** Agent ツール・Step 0 / 1 から利用可能な Read 専用 PR クライアント。 */
export interface PullRequestReadClient {
  getPullRequestMeta(): Promise<PullRequestMeta>;
  getDiff(range?: DiffRange): Promise<string>;
  listPullRequestFiles(): Promise<PullRequestFilesResult>;
  getCommitChecks(headSha: string): Promise<CommitChecksSnapshot>;
  listReviewThreads(): Promise<ReviewThreadsResult>;
  getFileContent(path: string, ref: string): Promise<string | null>;
}

/** Orchestrator 専用の Write PR クライアント。Agent ツールには露出しない。 */
export interface PullRequestWriteClient {
  postReview(input: PostReviewInput): Promise<PostReviewResult>;
  resolveThread(threadId: string): Promise<void>;
}

/** Read / Write を合成した PR クライアント。 */
export interface PullRequestClient extends PullRequestReadClient, PullRequestWriteClient {}
