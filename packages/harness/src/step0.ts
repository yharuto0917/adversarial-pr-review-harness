import {
  type AdminReviewConfigPolicy,
  type ClampedConfigField,
  type ExecutionMode,
  mergeRepoReviewConfig,
  type PartialRepoReviewConfig,
  type RepoReviewConfig,
  type StaticOnlyReason,
} from "@repo/review-core";

import {
  type CiScriptHazardResult,
  detectCiScriptHazardInDiff,
  detectCiScriptHazardInFiles,
} from "./ci-hazard.js";
import type { GitHubPort, PullRequestMeta } from "./ports.js";

/** リポジトリ内宣言設定ファイルの探索順（必ず `defaultBranch` 側から読み取る）。 */
export const REPO_CONFIG_CANDIDATE_PATHS = [
  ".github/review-harness.json",
  ".review-harness.json",
] as const;

/** プロジェクトレビュー規約ファイルのパス。 */
export const REVIEW_GUIDELINES_PATH = "REVIEW.md";

export interface LoadRepoReviewConfigOptions {
  readonly defaultBranch: string;
  readonly baseRef?: string | undefined;
  readonly baseSha?: string | undefined;
  readonly managedConfig: PartialRepoReviewConfig;
  readonly adminPolicy?: AdminReviewConfigPolicy | undefined;
}

export interface LoadedRepoReviewConfig {
  readonly config: RepoReviewConfig;
  readonly clampedFields: readonly ClampedConfigField[];
  readonly warnings: readonly string[];
  readonly configPath: string | null;
  readonly configParseError: boolean;
  readonly reviewGuidelines: string | null;
}

/**
 * リポジトリ内宣言設定と `REVIEW.md` を安全に読み込む。
 *
 * - 宣言設定（`.github/review-harness.json` / `.review-harness.json`）は必ず `defaultBranch` 側から
 *   `getFileContent` で取得し、PR head 側の改ざんを完全に無視する。
 * - 取得した宣言設定は `@repo/review-core` の `mergeRepoReviewConfig` で管理ストア設定へマージ・クランプする。
 * - `REVIEW.md` も原則 `defaultBranch`（`baseRef === defaultBranch` が確認できた場合のみ `baseSha`）から取得する。
 */
export async function loadRepoReviewConfig(
  github: GitHubPort,
  options: LoadRepoReviewConfigOptions,
): Promise<LoadedRepoReviewConfig> {
  const warnings: string[] = [];
  let configPath: string | null = null;
  let rawConfigText: string | null = null;

  for (const candidatePath of REPO_CONFIG_CANDIDATE_PATHS) {
    try {
      const content = await github.getFileContent(candidatePath, options.defaultBranch);
      if (content !== null) {
        configPath = candidatePath;
        rawConfigText = content;
        break;
      }
    } catch (error) {
      if (isInvalidResponseError(error)) {
        warnings.push(
          `ignored invalid config entry ${candidatePath} on "${options.defaultBranch}": ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      throw error;
    }
  }

  let parsedDeclared: unknown;
  let configParseError = false;
  if (rawConfigText !== null) {
    try {
      parsedDeclared = JSON.parse(rawConfigText);
    } catch (error) {
      configParseError = true;
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(
        `failed to parse ${configPath} on "${options.defaultBranch}": ${reason}; falling back to managed store config`,
      );
    }
  }

  const merged = mergeRepoReviewConfig(options.managedConfig, parsedDeclared, options.adminPolicy);

  // 非デフォルト・未保護ブランチ経由の REVIEW.md プロンプトインジェクションを防ぐ
  const guidelinesRef =
    options.baseRef !== undefined &&
    options.baseRef === options.defaultBranch &&
    options.baseSha !== undefined &&
    options.baseSha.length > 0
      ? options.baseSha
      : options.defaultBranch;
  const reviewGuidelines = await github.getFileContent(REVIEW_GUIDELINES_PATH, guidelinesRef);

  return {
    config: merged.config,
    clampedFields: merged.clampedFields,
    warnings: [...warnings, ...merged.warnings],
    configPath,
    configParseError,
    reviewGuidelines,
  };
}

export interface Step0PreprocessingInput {
  /** Webhook から受理した確定 `headSha`。`meta.headSha` と一致しない場合は stale 扱いで中断する。 */
  readonly headSha: string;
  /** Webhook ペイロードから判定された `isFork`（不明時は `undefined`）。 */
  readonly webhookIsFork?: boolean | undefined;
  readonly managedConfig: PartialRepoReviewConfig;
  readonly adminPolicy?: AdminReviewConfigPolicy | undefined;
}

export interface Step0StaleResult {
  readonly status: "stale";
  readonly requestedHeadSha: string;
  readonly latestHeadSha: string;
  readonly meta: PullRequestMeta;
}

export interface Step0ReadyResult {
  readonly status: "ready";
  readonly meta: PullRequestMeta;
  readonly isFork: boolean;
  readonly executionMode: ExecutionMode;
  readonly staticOnlyReason: StaticOnlyReason | undefined;
  readonly staticOnlyReasons: readonly string[];
  readonly ciScriptHazard: CiScriptHazardResult;
  readonly config: RepoReviewConfig;
  readonly clampedFields: readonly ClampedConfigField[];
  readonly configWarnings: readonly string[];
  readonly configPath: string | null;
  readonly reviewGuidelines: string | null;
  readonly diff: string | null;
  readonly diffTooLarge: boolean;
}

export type Step0Result = Step0StaleResult | Step0ReadyResult;

/**
 * Step 0（決定論的前処理）を実行する。
 *
 * 1. `getPullRequestMeta()` で PR メタデータを確定し、`headSha` 不一致（force-push による TOCTOU）を検知する。
 * 2. `defaultBranch` 側から宣言設定と `REVIEW.md` を安全に読み込み、管理ストア設定へクランプ統合する。
 * 3. SHA 固定の PR 全体差分（`compare/{baseSha}...{headSha}`、406 時は `/files` フォールバック）を
 *    `detectCiScriptHazardInDiff` で走査し、`isFork || ci_script_hazard` なら `static_only` を強制する。
 */
export async function runStep0Preprocessing(
  github: GitHubPort,
  input: Step0PreprocessingInput,
): Promise<Step0Result> {
  const meta = await github.getPullRequestMeta();
  if (meta.headSha !== input.headSha) {
    return {
      status: "stale",
      requestedHeadSha: input.headSha,
      latestHeadSha: meta.headSha,
      meta,
    };
  }

  const loadedConfig = await loadRepoReviewConfig(github, {
    defaultBranch: meta.defaultBranch,
    baseRef: meta.baseRef,
    baseSha: meta.baseSha,
    managedConfig: input.managedConfig,
    adminPolicy: input.adminPolicy,
  });

  let diff: string | null = null;
  let diffTooLarge = false;
  let ciScriptHazard: CiScriptHazardResult;

  try {
    diff = await github.getDiff({ base: meta.baseSha, head: input.headSha });
    ciScriptHazard = detectCiScriptHazardInDiff(diff);
  } catch (error) {
    if (!isDiffTooLargeError(error)) {
      throw error;
    }
    diffTooLarge = true;
    const filesResult = await github.listPullRequestFiles();
    // /pulls/{n}/files は可変の現在 PR HEAD を返すため、取得直後に headSha 一致を再検証し TOCTOU を防ぐ
    const metaAfterFiles = await github.getPullRequestMeta();
    if (metaAfterFiles.headSha !== input.headSha) {
      return {
        status: "stale",
        requestedHeadSha: input.headSha,
        latestHeadSha: metaAfterFiles.headSha,
        meta: metaAfterFiles,
      };
    }
    ciScriptHazard = detectCiScriptHazardInFiles(filesResult.files, filesResult.truncated);
  }

  const isFork = input.webhookIsFork === true || meta.isFork;
  const staticOnlyReasons: string[] = [];
  if (isFork) {
    staticOnlyReasons.push("external_fork_pr");
  }
  if (ciScriptHazard.detected) {
    staticOnlyReasons.push(...ciScriptHazard.reasons.map((reason) => `ci_script_hazard:${reason}`));
  }

  let executionMode: ExecutionMode = "full";
  let staticOnlyReason: StaticOnlyReason | undefined;
  if (isFork) {
    executionMode = "static_only";
    staticOnlyReason = "fork_pr";
  } else if (ciScriptHazard.detected) {
    executionMode = "static_only";
    staticOnlyReason = "ci_script_hazard";
  }

  return {
    status: "ready",
    meta,
    isFork,
    executionMode,
    staticOnlyReason,
    staticOnlyReasons,
    ciScriptHazard,
    config: loadedConfig.config,
    clampedFields: loadedConfig.clampedFields,
    configWarnings: loadedConfig.warnings,
    configPath: loadedConfig.configPath,
    reviewGuidelines: loadedConfig.reviewGuidelines,
    diff,
    diffTooLarge,
  };
}

function isDiffTooLargeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const record = error as unknown as Record<string, unknown>;
  return record.code === "GITHUB_DIFF_TOO_LARGE" || record.status === 406;
}

function isInvalidResponseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const record = error as unknown as Record<string, unknown>;
  return record.code === "GITHUB_INVALID_RESPONSE";
}
