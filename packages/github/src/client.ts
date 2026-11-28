import {
  type CheckAnnotation,
  type CommitCheckConclusion,
  type CommitCheckItem,
  type CommitCheckStatus,
  type CommitCheckSuiteItem,
  type CommitChecksSnapshot,
  type DiffRange,
  GitHubApiError,
  type PostReviewInput,
  type PostReviewResult,
  type PullRequestClient,
  type PullRequestClientOptions,
  type PullRequestFileEntry,
  type PullRequestFilesResult,
  type PullRequestMeta,
  type PullRequestReadClient,
  type PullRequestReadClientOptions,
  type PullRequestWriteClient,
  type PullRequestWriteClientOptions,
  type ReviewEvent,
  type ReviewThread,
  type ReviewThreadComment,
  type ReviewThreadsResult,
} from "./types.js";

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "adversarial-pr-review-harness";

/** `getFileContent` で許容する最大ファイルサイズ（512 KiB）。 */
export const MAX_FILE_CONTENT_BYTES = 512 * 1024;

const MAX_CHECK_RUN_PAGES = 5;
const MAX_STATUS_PAGES = 5;
const MAX_REVIEW_THREAD_PAGES = 10;
const MAX_PR_FILE_PAGES = 10;
const MAX_FAILED_ANNOTATION_FETCHES = 10;
const MAX_CHECK_TEXT_LENGTH = 2_000;
const MAX_ANNOTATION_MESSAGE_LENGTH = 500;
const MAX_ERROR_BODY_LENGTH = 500;

const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const FINGERPRINT_MARKER_RE = /<!--\s*review-harness:fp=([A-Za-z0-9_.:-]+)\s*-->/;
const NEXT_LINK_RE = /<([^>]+)>;\s*rel="next"/;

const FAILED_CHECK_CONCLUSIONS: ReadonlySet<CommitCheckConclusion> = new Set([
  "failure",
  "startup_failure",
  "timed_out",
  "action_required",
]);

const TEST_PRIORITY_RE =
  /(?:^|[^a-z0-9])(?:tests?|testing|specs?|pytest|unittests?|jest|vitest|mocha|rspec|phpunit|junit|e2e|playwright|cypress|nextest)(?:[^a-z0-9]|$)|(?<=[a-z])(?:Tests?|Specs?)(?![a-z])/i;
const TYPECHECK_PRIORITY_RE =
  /(?:^|[^a-z0-9])(?:type-?check|type_check|tsc|mypy|pyright)(?:[^a-z0-9]|$)/i;
const BUILD_PRIORITY_RE = /(?:^|[^a-z0-9])(?:build|compile|bundle)(?:[^a-z0-9]|$)/i;
const LINT_PRIORITY_RE =
  /(?:^|[^a-z0-9])(?:lint|eslint|biome|prettier|ruff|flake8|clippy|format|style|check:ci|go\s+vet)(?:[^a-z0-9]|$)/i;

const VALID_REVIEW_EVENTS: ReadonlySet<ReviewEvent> = new Set([
  "COMMENT",
  "REQUEST_CHANGES",
  "APPROVE",
]);

const LIST_REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $pullNumber: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pullNumber) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          diffSide
          comments(first: 20) {
            nodes {
              id
              body
              author { login }
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_REVIEW_THREAD_MUTATION =
  "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }";

/** レビューコメント本文に埋め込まれた不可視 fingerprint マーカーを抽出する。 */
export function extractReviewFingerprint(body: string): string | null {
  const match = FINGERPRINT_MARKER_RE.exec(body);
  return match?.[1] ?? null;
}

/** GitHub API エラー応答本文をログ／例外向けに安全な長さと文字へサニタイズする。 */
export function sanitizeGitHubErrorBody(raw: string): string {
  const cleaned = stripControlChars(raw).trim();
  if (cleaned.length <= MAX_ERROR_BODY_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_ERROR_BODY_LENGTH)}...`;
}

/**
 * PR に対する Read 専用クライアントを作成する。
 * Agent ツールや Step 0/1 判定ロジックへ露出する境界として利用する。
 */
export function createPullRequestReadClient(
  options: PullRequestReadClientOptions,
): PullRequestReadClient {
  const repository = validateRepository(options.repository);
  const pullNumber = validatePullNumber(options.pullNumber);
  const selfAppId =
    options.selfAppId !== undefined && String(options.selfAppId).trim().length > 0
      ? String(options.selfAppId).trim()
      : undefined;
  const selfStatusPrefix =
    options.selfStatusContextPrefix !== undefined && options.selfStatusContextPrefix.length > 0
      ? options.selfStatusContextPrefix
      : undefined;
  const getChecksToken = options.getChecksToken ?? options.getToken;

  return {
    async getPullRequestMeta(): Promise<PullRequestMeta> {
      const token = await options.getToken();
      const response = await fetch(`${GITHUB_API_BASE}/repos/${repository}/pulls/${pullNumber}`, {
        method: "GET",
        headers: buildRestHeaders(token, "application/vnd.github+json"),
      });
      await assertOkResponse(response, "failed to get pull request metadata");
      const raw: unknown = await response.json();
      return parsePullRequestMeta(raw, pullNumber);
    },

    async getDiff(range?: DiffRange): Promise<string> {
      const token = await options.getToken();
      let url: string;
      if (range === undefined) {
        url = `${GITHUB_API_BASE}/repos/${repository}/pulls/${pullNumber}`;
      } else {
        const base = validateGitRef(range.base, "diff range base");
        const head = validateGitRef(range.head, "diff range head");
        url = `${GITHUB_API_BASE}/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      }
      const response = await fetch(url, {
        method: "GET",
        headers: buildRestHeaders(token, "application/vnd.github.v3.diff"),
      });
      if (response.status === 406) {
        const text = sanitizeGitHubErrorBody(await response.text().catch(() => ""));
        throw new GitHubApiError(
          "GITHUB_DIFF_TOO_LARGE",
          406,
          `pull request diff exceeded GitHub API limit (406): ${text}`,
        );
      }
      await assertOkResponse(response, "failed to get pull request diff");
      return response.text();
    },

    async listPullRequestFiles(): Promise<PullRequestFilesResult> {
      const token = await options.getToken();
      const files: PullRequestFileEntry[] = [];
      let nextUrl: string | null =
        `${GITHUB_API_BASE}/repos/${repository}/pulls/${pullNumber}/files?per_page=100`;
      let pages = 0;
      let truncated = false;

      while (nextUrl !== null) {
        if (pages >= MAX_PR_FILE_PAGES) {
          truncated = true;
          break;
        }
        pages += 1;
        const response = await fetch(nextUrl, {
          method: "GET",
          headers: buildRestHeaders(token, "application/vnd.github+json"),
        });
        await assertOkResponse(response, "failed to list pull request files");
        const raw: unknown = await response.json();
        if (!Array.isArray(raw)) {
          throw new GitHubApiError(
            "GITHUB_INVALID_RESPONSE",
            response.status,
            "pull request files response must be an array",
          );
        }
        for (const item of raw) {
          const parsed = parsePullRequestFileEntry(item);
          if (parsed !== null) {
            files.push(parsed);
          }
        }
        nextUrl = getNextLinkUrl(response.headers.get("link"));
      }

      return { files, truncated };
    },

    async getCommitChecks(headSha: string): Promise<CommitChecksSnapshot> {
      const validatedSha = validateGitRef(headSha, "headSha");
      const token = await getChecksToken();

      const [checkRunsResult, checkSuitesResult, statusesResult] = await Promise.all([
        fetchAllCheckRuns(repository, validatedSha, token, selfAppId),
        fetchCheckSuites(repository, validatedSha, token, selfAppId),
        fetchCommitStatuses(repository, validatedSha, token, selfStatusPrefix),
      ]);

      // 失敗 Check Run の Annotations はカテゴリ優先順で上位件数のみ取得しサブリクエスト数を抑える
      const annotationTargets = checkRunsResult.runs
        .filter(
          (run) =>
            run.status === "completed" &&
            run.conclusion !== null &&
            FAILED_CHECK_CONCLUSIONS.has(run.conclusion) &&
            run.id !== undefined &&
            run.annotationsCount !== 0,
        )
        .sort((a, b) => checkNamePriority(a.name) - checkNamePriority(b.name))
        .slice(0, MAX_FAILED_ANNOTATION_FETCHES);

      const annotationsByRunId = new Map<number, readonly CheckAnnotation[]>();
      if (annotationTargets.length > 0) {
        const fetchedAnnotations = await Promise.all(
          annotationTargets.map(async (run) => {
            const runId = run.id as number;
            const annotations = await fetchCheckRunAnnotations(repository, runId, token);
            return [runId, annotations] as const;
          }),
        );
        for (const [runId, annotations] of fetchedAnnotations) {
          annotationsByRunId.set(runId, annotations);
        }
      }

      const checkRunItems: CommitCheckItem[] = checkRunsResult.runs.map((run) => ({
        source: "check_run",
        ...(run.id !== undefined ? { id: run.id } : {}),
        name: run.name,
        appId: run.appId,
        appSlug: run.appSlug,
        status: run.status,
        conclusion: run.conclusion,
        detailsUrl: run.detailsUrl,
        title: run.title,
        summary: run.summary,
        text: run.text,
        annotations: run.id !== undefined ? (annotationsByRunId.get(run.id) ?? []) : [],
        completedAt: run.completedAt,
      }));

      return {
        headSha: validatedSha,
        checks: [...checkRunItems, ...statusesResult.items],
        checkSuites: checkSuitesResult.suites,
        truncated:
          checkRunsResult.truncated || checkSuitesResult.truncated || statusesResult.truncated,
      };
    },

    async listReviewThreads(): Promise<ReviewThreadsResult> {
      const token = await options.getToken();
      const [owner, name] = splitRepository(repository);
      const threads: ReviewThread[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let truncated = false;

      while (true) {
        if (pages >= MAX_REVIEW_THREAD_PAGES) {
          truncated = true;
          break;
        }
        pages += 1;

        const response = await fetch(`${GITHUB_API_BASE}/graphql`, {
          method: "POST",
          headers: buildGraphQlHeaders(token),
          body: JSON.stringify({
            query: LIST_REVIEW_THREADS_QUERY,
            variables: { owner, name, pullNumber, cursor },
          }),
        });
        await assertOkResponse(response, "failed to list review threads");

        const payload = (await response.json()) as {
          errors?: Array<{ message?: string }>;
          data?: {
            repository?: {
              pullRequest?: {
                reviewThreads?: {
                  pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
                  nodes?: unknown[];
                };
              } | null;
            } | null;
          };
        };
        assertNoGraphQlErrors(payload.errors, "failed to list review threads");

        const connection = payload.data?.repository?.pullRequest?.reviewThreads;
        if (!connection || !Array.isArray(connection.nodes)) {
          throw new GitHubApiError(
            "GITHUB_INVALID_RESPONSE",
            response.status,
            `failed to list review threads: pull request ${repository}#${pullNumber} was not found in GraphQL response`,
          );
        }

        for (const node of connection.nodes) {
          const parsed = parseReviewThread(node);
          if (parsed !== null) {
            threads.push(parsed);
          }
        }

        const hasNextPage = connection.pageInfo?.hasNextPage === true;
        const endCursor =
          typeof connection.pageInfo?.endCursor === "string" ? connection.pageInfo.endCursor : null;
        if (!hasNextPage || endCursor === null) {
          break;
        }
        cursor = endCursor;
      }

      return { threads, truncated };
    },

    async getFileContent(path: string, ref: string): Promise<string | null> {
      const encodedPath = encodeRepoFilePath(path);
      const validatedRef = validateGitRef(ref, "ref");
      const token = await options.getToken();
      const query = new URLSearchParams({ ref: validatedRef });

      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${repository}/contents/${encodedPath}?${query.toString()}`,
        {
          method: "GET",
          headers: buildRestHeaders(token, "application/vnd.github+json"),
        },
      );
      if (response.status === 404) {
        return null;
      }
      await assertOkResponse(response, `failed to get file content for "${path}"`);

      const raw: unknown = await response.json();
      if (Array.isArray(raw)) {
        throw new GitHubApiError(
          "GITHUB_INVALID_RESPONSE",
          response.status,
          `path "${path}" is a directory, not a file`,
        );
      }
      if (!isRecord(raw)) {
        throw new GitHubApiError(
          "GITHUB_INVALID_RESPONSE",
          response.status,
          `invalid file content response for "${path}"`,
        );
      }
      if (raw.type !== "file") {
        throw new GitHubApiError(
          "GITHUB_INVALID_RESPONSE",
          response.status,
          `path "${path}" has unsupported content type "${String(raw.type)}" (only regular files are allowed)`,
        );
      }
      if (typeof raw.size === "number" && raw.size > MAX_FILE_CONTENT_BYTES) {
        throw new GitHubApiError(
          "GITHUB_INVALID_RESPONSE",
          response.status,
          `file "${path}" exceeds maximum allowed size (${raw.size} > ${MAX_FILE_CONTENT_BYTES} bytes)`,
        );
      }
      if (raw.encoding !== "base64" || typeof raw.content !== "string") {
        throw new GitHubApiError(
          "GITHUB_INVALID_RESPONSE",
          response.status,
          `file "${path}" is not base64-encoded`,
        );
      }

      const bytes = decodeBase64Bytes(raw.content);
      if (bytes.byteLength > MAX_FILE_CONTENT_BYTES) {
        throw new GitHubApiError(
          "GITHUB_INVALID_RESPONSE",
          response.status,
          `decoded file "${path}" exceeds maximum allowed size (${bytes.byteLength} > ${MAX_FILE_CONTENT_BYTES} bytes)`,
        );
      }
      return new TextDecoder("utf-8").decode(bytes);
    },
  };
}

/**
 * PR に対する Orchestrator 専用の Write クライアントを作成する。
 * Agent ツールからは呼び出さず、Orchestrator からのみ使用する。
 */
export function createPullRequestWriteClient(
  options: PullRequestWriteClientOptions,
): PullRequestWriteClient {
  const repository = validateRepository(options.repository);
  const pullNumber = validatePullNumber(options.pullNumber);

  return {
    async postReview(input: PostReviewInput): Promise<PostReviewResult> {
      const event: ReviewEvent = input.event ?? "COMMENT";
      if (!VALID_REVIEW_EVENTS.has(event)) {
        throw new Error(`invalid review event: "${String(event)}"`);
      }

      let commitId: string | undefined;
      if (input.commitId !== undefined) {
        commitId = validateGitRef(input.commitId, "commitId");
      }

      let mappedComments:
        | Array<{
            readonly path: string;
            readonly line: number;
            readonly side: "LEFT" | "RIGHT";
            readonly start_line?: number;
            readonly start_side?: "LEFT" | "RIGHT";
            readonly body: string;
          }>
        | undefined;

      if (input.comments !== undefined && input.comments.length > 0) {
        mappedComments = input.comments.map((comment) => {
          const trimmedPath = comment.path.trim();
          if (trimmedPath.length === 0) {
            throw new Error("inline review comment path must not be empty");
          }
          if (!Number.isInteger(comment.line) || comment.line <= 0) {
            throw new Error(
              `inline review comment line must be a positive integer: ${comment.line}`,
            );
          }
          if (
            comment.startLine !== undefined &&
            (!Number.isInteger(comment.startLine) ||
              comment.startLine <= 0 ||
              comment.startLine > comment.line)
          ) {
            throw new Error(
              `inline review comment startLine must be between 1 and line (${comment.line}): ${comment.startLine}`,
            );
          }
          const side = comment.side ?? "RIGHT";
          return {
            path: trimmedPath,
            line: comment.line,
            side,
            ...(comment.startLine !== undefined
              ? {
                  start_line: comment.startLine,
                  start_side: comment.startSide ?? side,
                }
              : {}),
            body: comment.body,
          };
        });
      }

      const payload: Record<string, unknown> = {
        body: input.body,
        event,
      };
      if (commitId !== undefined) {
        payload.commit_id = commitId;
      }
      if (mappedComments !== undefined) {
        payload.comments = mappedComments;
      }

      const token = await options.getToken();
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${repository}/pulls/${pullNumber}/reviews`,
        {
          method: "POST",
          headers: {
            ...buildRestHeaders(token, "application/vnd.github+json"),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
      await assertOkResponse(response, "failed to post pull request review");

      const data = (await response.json().catch(() => null)) as unknown;
      const id = isRecord(data) && typeof data.id === "number" ? data.id : null;
      return { id };
    },

    async resolveThread(threadId: string): Promise<void> {
      const trimmed = threadId.trim();
      if (trimmed.length === 0) {
        throw new Error("threadId must not be empty");
      }
      const token = await options.getToken();
      const response = await fetch(`${GITHUB_API_BASE}/graphql`, {
        method: "POST",
        headers: buildGraphQlHeaders(token),
        body: JSON.stringify({
          query: RESOLVE_REVIEW_THREAD_MUTATION,
          variables: { threadId: trimmed },
        }),
      });
      await assertOkResponse(response, "failed to resolve review thread");
      const result = (await response.json()) as { errors?: Array<{ message?: string }> };
      assertNoGraphQlErrors(result.errors, "failed to resolve review thread");
    },
  };
}

/**
 * PR に対する Read / Write 操作を統合したクライアントを作る。
 * トークン権限を分離したい場合は `createPullRequestReadClient` / `createPullRequestWriteClient` を使う。
 */
export function createPullRequestClient(options: PullRequestClientOptions): PullRequestClient {
  const readClient = createPullRequestReadClient(options);
  const writeClient = createPullRequestWriteClient({
    repository: options.repository,
    pullNumber: options.pullNumber,
    getToken: options.getWriteToken ?? options.getToken,
  });
  return {
    ...readClient,
    ...writeClient,
  };
}

interface InternalCheckRun {
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
  readonly annotationsCount: number | undefined;
  readonly completedAt: string | null;
}

async function fetchAllCheckRuns(
  repository: string,
  headSha: string,
  token: string,
  selfAppId: string | undefined,
): Promise<{ readonly runs: readonly InternalCheckRun[]; readonly truncated: boolean }> {
  const deduped = new Map<string, InternalCheckRun>();
  let nextUrl: string | null =
    `${GITHUB_API_BASE}/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs?filter=latest&per_page=100`;
  let pages = 0;
  let truncated = false;

  while (nextUrl !== null) {
    if (pages >= MAX_CHECK_RUN_PAGES) {
      truncated = true;
      break;
    }
    pages += 1;
    const response = await fetch(nextUrl, {
      method: "GET",
      headers: buildRestHeaders(token, "application/vnd.github+json"),
    });
    await assertOkResponse(response, `failed to get check runs for ${headSha}`);

    const raw: unknown = await response.json();
    const checkRuns = isRecord(raw) && Array.isArray(raw.check_runs) ? raw.check_runs : null;
    if (checkRuns === null) {
      throw new GitHubApiError(
        "GITHUB_INVALID_RESPONSE",
        response.status,
        "check runs response is missing check_runs array",
      );
    }

    for (const item of checkRuns) {
      if (!isRecord(item)) {
        continue;
      }
      // head_sha 厳密一致チェック
      if (item.head_sha !== headSha) {
        continue;
      }
      const app = isRecord(item.app) ? item.app : null;
      const appId = typeof app?.id === "number" && Number.isInteger(app.id) ? app.id : null;
      if (selfAppId !== undefined && appId !== null && String(appId) === selfAppId) {
        continue;
      }

      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (name.length === 0) {
        continue;
      }
      const status = normalizeCheckStatus(item.status);
      if (status === null) {
        continue;
      }
      const conclusion = normalizeCheckConclusion(item.conclusion);
      const id = typeof item.id === "number" && Number.isInteger(item.id) ? item.id : undefined;
      const output = isRecord(item.output) ? item.output : null;
      const parsed: InternalCheckRun = {
        ...(id !== undefined ? { id } : {}),
        name,
        appId,
        appSlug: typeof app?.slug === "string" ? app.slug : null,
        status,
        conclusion,
        detailsUrl: typeof item.details_url === "string" ? item.details_url : null,
        title: typeof output?.title === "string" ? truncateText(output.title, 256) : null,
        summary:
          typeof output?.summary === "string"
            ? truncateText(output.summary, MAX_CHECK_TEXT_LENGTH)
            : null,
        text:
          typeof output?.text === "string"
            ? truncateText(output.text, MAX_CHECK_TEXT_LENGTH)
            : null,
        annotationsCount:
          typeof output?.annotations_count === "number" ? output.annotations_count : undefined,
        completedAt: typeof item.completed_at === "string" ? item.completed_at : null,
      };

      const key = `${appId ?? "none"}:${name}`;
      const existing = deduped.get(key);
      if (
        existing === undefined ||
        (parsed.id !== undefined && (existing.id === undefined || parsed.id > existing.id))
      ) {
        deduped.set(key, parsed);
      }
    }

    nextUrl = getNextLinkUrl(response.headers.get("link"));
  }

  return { runs: [...deduped.values()], truncated };
}

async function fetchCheckSuites(
  repository: string,
  headSha: string,
  token: string,
  selfAppId: string | undefined,
): Promise<{ readonly suites: readonly CommitCheckSuiteItem[]; readonly truncated: boolean }> {
  const results: CommitCheckSuiteItem[] = [];
  let nextUrl: string | null =
    `${GITHUB_API_BASE}/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-suites?per_page=100`;
  let pages = 0;
  let truncated = false;

  while (nextUrl !== null) {
    if (pages >= MAX_CHECK_RUN_PAGES) {
      truncated = true;
      break;
    }
    pages += 1;
    const response = await fetch(nextUrl, {
      method: "GET",
      headers: buildRestHeaders(token, "application/vnd.github+json"),
    });
    await assertOkResponse(response, `failed to get check suites for ${headSha}`);

    const raw: unknown = await response.json();
    const suites = isRecord(raw) && Array.isArray(raw.check_suites) ? raw.check_suites : null;
    if (suites === null) {
      throw new GitHubApiError(
        "GITHUB_INVALID_RESPONSE",
        response.status,
        "check suites response is missing check_suites array",
      );
    }

    for (const item of suites) {
      if (!isRecord(item) || item.head_sha !== headSha) {
        continue;
      }
      const id = typeof item.id === "number" && Number.isInteger(item.id) ? item.id : null;
      if (id === null) {
        continue;
      }
      const app = isRecord(item.app) ? item.app : null;
      const appId = typeof app?.id === "number" && Number.isInteger(app.id) ? app.id : null;
      if (selfAppId !== undefined && appId !== null && String(appId) === selfAppId) {
        continue;
      }
      const status = normalizeCheckStatus(item.status);
      if (status === null) {
        continue;
      }
      results.push({
        id,
        appId,
        appSlug: typeof app?.slug === "string" ? app.slug : null,
        status,
        conclusion: normalizeCheckConclusion(item.conclusion),
      });
    }

    nextUrl = getNextLinkUrl(response.headers.get("link"));
  }

  return { suites: results, truncated };
}

async function fetchCheckRunAnnotations(
  repository: string,
  checkRunId: number,
  token: string,
): Promise<readonly CheckAnnotation[]> {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${repository}/check-runs/${checkRunId}/annotations?per_page=50`,
    {
      method: "GET",
      headers: buildRestHeaders(token, "application/vnd.github+json"),
    },
  );
  if (response.status === 404) {
    return [];
  }
  await assertOkResponse(response, `failed to get annotations for check run ${checkRunId}`);

  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) {
    return [];
  }
  const annotations: CheckAnnotation[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const path = typeof item.path === "string" ? item.path : "";
    const message = typeof item.message === "string" ? item.message : "";
    const startLine = typeof item.start_line === "number" ? item.start_line : 0;
    const endLine = typeof item.end_line === "number" ? item.end_line : startLine;
    if (message.length === 0) {
      continue;
    }
    annotations.push({
      path,
      startLine,
      endLine,
      annotationLevel: typeof item.annotation_level === "string" ? item.annotation_level : "notice",
      title: typeof item.title === "string" ? truncateText(item.title, 256) : null,
      message: truncateText(message, MAX_ANNOTATION_MESSAGE_LENGTH),
    });
  }
  return annotations;
}

async function fetchCommitStatuses(
  repository: string,
  headSha: string,
  token: string,
  selfStatusPrefix: string | undefined,
): Promise<{ readonly items: readonly CommitCheckItem[]; readonly truncated: boolean }> {
  const byContext = new Map<string, CommitCheckItem>();
  let nextUrl: string | null =
    `${GITHUB_API_BASE}/repos/${repository}/commits/${encodeURIComponent(headSha)}/status?per_page=100`;
  let pages = 0;
  let truncated = false;

  while (nextUrl !== null) {
    if (pages >= MAX_STATUS_PAGES) {
      truncated = true;
      break;
    }
    pages += 1;
    const response = await fetch(nextUrl, {
      method: "GET",
      headers: buildRestHeaders(token, "application/vnd.github+json"),
    });
    await assertOkResponse(response, `failed to get commit status for ${headSha}`);

    const raw: unknown = await response.json();
    if (!isRecord(raw) || !Array.isArray(raw.statuses)) {
      throw new GitHubApiError(
        "GITHUB_INVALID_RESPONSE",
        response.status,
        "commit status response is missing statuses array",
      );
    }
    if (typeof raw.sha === "string" && raw.sha !== headSha) {
      break;
    }

    for (const item of raw.statuses) {
      if (!isRecord(item)) {
        continue;
      }
      const context = typeof item.context === "string" ? item.context.trim() : "";
      if (context.length === 0) {
        continue;
      }
      if (selfStatusPrefix !== undefined && context.startsWith(selfStatusPrefix)) {
        continue;
      }
      const mapped = mapCommitStatusState(item.state);
      if (mapped === null) {
        continue;
      }
      byContext.set(context, {
        source: "commit_status",
        ...(typeof item.id === "number" && Number.isInteger(item.id) ? { id: item.id } : {}),
        name: context,
        appId: null,
        appSlug: null,
        status: mapped.status,
        conclusion: mapped.conclusion,
        detailsUrl: typeof item.target_url === "string" ? item.target_url : null,
        title: null,
        summary:
          typeof item.description === "string"
            ? truncateText(item.description, MAX_CHECK_TEXT_LENGTH)
            : null,
        text: null,
        annotations: [],
        completedAt: typeof item.updated_at === "string" ? item.updated_at : null,
      });
    }

    nextUrl = getNextLinkUrl(response.headers.get("link"));
  }

  return { items: [...byContext.values()], truncated };
}

function parsePullRequestMeta(raw: unknown, fallbackNumber: number): PullRequestMeta {
  if (!isRecord(raw)) {
    throw new GitHubApiError(
      "GITHUB_INVALID_RESPONSE",
      200,
      "pull request metadata response must be an object",
    );
  }
  const base = isRecord(raw.base) ? raw.base : null;
  const head = isRecord(raw.head) ? raw.head : null;
  const baseRepo = base && isRecord(base.repo) ? base.repo : null;
  const headRepo = head && isRecord(head.repo) ? head.repo : null;

  const baseSha = typeof base?.sha === "string" ? base.sha.trim() : "";
  const headSha = typeof head?.sha === "string" ? head.sha.trim() : "";
  const defaultBranch =
    typeof baseRepo?.default_branch === "string" ? baseRepo.default_branch.trim() : "";

  if (baseSha.length === 0 || headSha.length === 0 || defaultBranch.length === 0) {
    throw new GitHubApiError(
      "GITHUB_INVALID_RESPONSE",
      200,
      "pull request metadata is missing required base.sha, head.sha, or base.repo.default_branch",
    );
  }

  const baseRepoId =
    typeof baseRepo?.id === "number" && Number.isInteger(baseRepo.id) && baseRepo.id > 0
      ? baseRepo.id
      : null;
  const headRepoId =
    typeof headRepo?.id === "number" && Number.isInteger(headRepo.id) && headRepo.id > 0
      ? headRepo.id
      : null;
  const baseRepoFullName =
    typeof baseRepo?.full_name === "string" && baseRepo.full_name.trim().length > 0
      ? baseRepo.full_name.trim()
      : null;
  const headRepoFullName =
    typeof headRepo?.full_name === "string" && headRepo.full_name.trim().length > 0
      ? headRepo.full_name.trim()
      : null;

  // fail-closed: 同一リポジトリであることが id と full_name の両方で証明できた場合のみ isFork = false
  const isSameRepo =
    baseRepoId !== null &&
    headRepoId !== null &&
    baseRepoId === headRepoId &&
    baseRepoFullName !== null &&
    headRepoFullName !== null &&
    baseRepoFullName.toLowerCase() === headRepoFullName.toLowerCase();

  const user = isRecord(raw.user) ? raw.user : null;

  return {
    number: typeof raw.number === "number" ? raw.number : fallbackNumber,
    state: raw.state === "closed" ? "closed" : "open",
    draft: raw.draft === true,
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : null,
    authorLogin: typeof user?.login === "string" ? user.login : null,
    baseSha,
    headSha,
    baseRef: typeof base?.ref === "string" ? base.ref : "",
    headRef: typeof head?.ref === "string" ? head.ref : "",
    defaultBranch,
    baseRepoId,
    headRepoId,
    baseRepoFullName,
    headRepoFullName,
    isFork: !isSameRepo,
  };
}

function parsePullRequestFileEntry(raw: unknown): PullRequestFileEntry | null {
  if (!isRecord(raw) || typeof raw.filename !== "string" || raw.filename.length === 0) {
    return null;
  }
  return {
    filename: raw.filename,
    ...(typeof raw.previous_filename === "string"
      ? { previousFilename: raw.previous_filename }
      : {}),
    status: typeof raw.status === "string" ? raw.status : "modified",
    additions: typeof raw.additions === "number" ? raw.additions : 0,
    deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
    changes: typeof raw.changes === "number" ? raw.changes : 0,
    ...(typeof raw.patch === "string" ? { patch: raw.patch } : {}),
  };
}

function parseReviewThread(raw: unknown): ReviewThread | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }
  const commentsConn = isRecord(raw.comments) ? raw.comments : null;
  const commentNodes = Array.isArray(commentsConn?.nodes) ? commentsConn.nodes : [];
  const comments: ReviewThreadComment[] = [];
  for (const node of commentNodes) {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.body !== "string") {
      continue;
    }
    const author = isRecord(node.author) ? node.author : null;
    comments.push({
      id: node.id,
      body: node.body,
      authorLogin: typeof author?.login === "string" ? author.login : null,
      createdAt: typeof node.createdAt === "string" ? node.createdAt : null,
      url: typeof node.url === "string" ? node.url : null,
    });
  }

  const rootBody = comments[0]?.body ?? "";
  let fingerprint = extractReviewFingerprint(rootBody);
  if (fingerprint === null) {
    for (const comment of comments.slice(1)) {
      const candidate = extractReviewFingerprint(comment.body);
      if (candidate !== null) {
        fingerprint = candidate;
        break;
      }
    }
  }

  const diffSide = raw.diffSide === "LEFT" || raw.diffSide === "RIGHT" ? raw.diffSide : null;

  return {
    id: raw.id,
    isResolved: raw.isResolved === true,
    isOutdated: raw.isOutdated === true,
    path: typeof raw.path === "string" ? raw.path : null,
    line: typeof raw.line === "number" ? raw.line : null,
    originalLine: typeof raw.originalLine === "number" ? raw.originalLine : null,
    startLine: typeof raw.startLine === "number" ? raw.startLine : null,
    diffSide,
    body: rootBody,
    fingerprint,
    comments,
  };
}

function buildRestHeaders(token: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
  };
}

function buildGraphQlHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": GITHUB_USER_AGENT,
  };
}

async function assertOkResponse(response: Response, prefix: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const text = sanitizeGitHubErrorBody(await response.text().catch(() => ""));
  const code =
    response.status === 401 || response.status === 403
      ? "GITHUB_PERMISSION_DENIED"
      : "GITHUB_API_ERROR";
  throw new GitHubApiError(
    code,
    response.status,
    `${prefix} (${response.status})${text ? `: ${text}` : ""}`,
  );
}

function assertNoGraphQlErrors(
  errors: ReadonlyArray<{ readonly message?: string }> | undefined,
  prefix: string,
): void {
  if (!errors || errors.length === 0) {
    return;
  }
  const message = sanitizeGitHubErrorBody(
    errors.map((e) => e.message ?? "GraphQL error").join("; "),
  );
  throw new GitHubApiError("GITHUB_GRAPHQL_ERROR", 200, `${prefix}: ${message}`);
}

function validateRepository(repository: string): string {
  const trimmed = repository.trim();
  if (!SAFE_REPOSITORY.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`invalid repository: "${repository}"`);
  }
  return trimmed;
}

function validatePullNumber(pullNumber: number): number {
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error(`invalid pullNumber: ${pullNumber}`);
  }
  return pullNumber;
}

function validateGitRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 256 ||
    trimmed.includes("..") ||
    trimmed.endsWith("/") ||
    !SAFE_GIT_REF.test(trimmed)
  ) {
    throw new Error(`invalid ${label}: "${ref}"`);
  }
  return trimmed;
}

function encodeRepoFilePath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/")) {
    throw new Error(`invalid repository file path: "${path}"`);
  }
  if (path.includes("\\") || path.includes("%") || hasControlChar(path)) {
    throw new Error(`invalid repository file path: "${path}"`);
  }
  const segments = path.split("/");
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error(`invalid repository file path segment in "${path}"`);
    }
    encoded.push(encodeURIComponent(segment));
  }
  return encoded.join("/");
}

function splitRepository(repository: string): readonly [string, string] {
  const slashIndex = repository.indexOf("/");
  if (slashIndex <= 0 || slashIndex === repository.length - 1) {
    throw new Error(`invalid repository: "${repository}"`);
  }
  return [repository.slice(0, slashIndex), repository.slice(slashIndex + 1)];
}

function getNextLinkUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  const match = NEXT_LINK_RE.exec(linkHeader);
  const candidate = match?.[1];
  if (!candidate?.startsWith(`${GITHUB_API_BASE}/`)) {
    return null;
  }
  return candidate;
}

function normalizeCheckStatus(raw: unknown): CommitCheckStatus | null {
  if (raw === "queued" || raw === "in_progress" || raw === "completed") {
    return raw;
  }
  if (raw === "waiting" || raw === "pending" || raw === "requested") {
    return "queued";
  }
  return null;
}

function normalizeCheckConclusion(raw: unknown): CommitCheckConclusion | null {
  switch (raw) {
    case "success":
    case "failure":
    case "neutral":
    case "cancelled":
    case "skipped":
    case "timed_out":
    case "action_required":
    case "stale":
    case "startup_failure":
    case "error":
      return raw;
    default:
      return null;
  }
}

function mapCommitStatusState(state: unknown): {
  readonly status: CommitCheckStatus;
  readonly conclusion: CommitCheckConclusion | null;
} | null {
  switch (state) {
    case "pending":
      return { status: "in_progress", conclusion: null };
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failure":
      return { status: "completed", conclusion: "failure" };
    case "error":
      return { status: "completed", conclusion: "error" };
    default:
      return null;
  }
}

function checkNamePriority(name: string): number {
  if (TEST_PRIORITY_RE.test(name)) return 0;
  if (TYPECHECK_PRIORITY_RE.test(name)) return 1;
  if (BUILD_PRIORITY_RE.test(name)) return 2;
  if (LINT_PRIORITY_RE.test(name)) return 3;
  return 4;
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function stripControlChars(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      result += " ";
    } else if (code >= 0x20 && code !== 0x7f) {
      result += value[i] ?? "";
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
