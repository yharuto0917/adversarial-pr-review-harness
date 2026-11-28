import {
  type EarlyRejectPolicy,
  type ExecutionMode,
  type StaticOnlyReason,
  type TestCheckKind,
  type TestCheckResult,
  type TestCheckStatus,
  type TestExecutionReport,
  type TestReportOverallStatus,
  testExecutionReportSchema,
} from "@repo/review-core";

import type {
  CommitCheckConclusion,
  CommitCheckItem,
  CommitChecksSnapshot,
  GitHubPort,
  SandboxPort,
} from "./ports.js";
import { setupProject } from "./project.js";

/** Step 1 CI 待機時のポーリング間隔既定値（30 秒）。 */
export const DEFAULT_CI_POLL_INTERVAL_MS = 30_000;

/** Step 1 CI 待機の上限時間既定値（5 分）。 */
export const DEFAULT_CI_WAIT_TIMEOUT_MS = 5 * 60 * 1_000;

/** PR 作成直後の CI 未登録レースを吸収するための初期待機時間既定値（15 秒）。 */
export const DEFAULT_CI_DISCOVERY_GRACE_MS = 15_000;

const MAX_COMMAND_SUMMARY_LENGTH = 500;

const TEST_CHECK_WORD_RE =
  /(?:^|[^a-z0-9])(?:tests?|testing|specs?|pytest|unittests?|jest|vitest|mocha|rspec|phpunit|junit|e2e|playwright|cypress|nextest)(?:[^a-z0-9]|$)/i;
const TEST_CHECK_CAMEL_RE = /(?<=[a-z])(?:Tests?|Specs?)(?![a-z])/;
const TYPECHECK_NAME_RE =
  /(?:^|[^a-z0-9])(?:type-?check|type_check|tsc|mypy|pyright|types)(?:[^a-z0-9]|$)/i;
const BUILD_NAME_RE = /(?:^|[^a-z0-9])(?:build|compile|bundle|cargo\s+check)(?:[^a-z0-9]|$)/i;
const LINT_NAME_RE =
  /(?:^|[^a-z0-9])(?:lint(?:ing)?|eslint|biome|prettier|ruff|flake8|clippy|rubocop|format|style|check:ci|go\s+vet)(?:[^a-z0-9]|$)/i;

const FAILURE_CONCLUSIONS: ReadonlySet<CommitCheckConclusion> = new Set([
  "failure",
  "startup_failure",
  "error",
]);

const SKIPPED_CONCLUSIONS: ReadonlySet<CommitCheckConclusion> = new Set([
  "skipped",
  "neutral",
  "cancelled",
  "stale",
]);

/**
 * CI チェック名を決定論的にカテゴリ分類する。
 * 優先順: `requiredTestChecks` > `test` > `typecheck` > `build` > `lint` > `other`。
 */
export function classifyCheckKind(
  name: string,
  requiredTestChecks: readonly string[] = [],
): TestCheckKind {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "other";
  }
  const normalizedRequired = new Set(requiredTestChecks.map((entry) => entry.trim().toLowerCase()));
  if (normalizedRequired.has(trimmed.toLowerCase())) {
    return "test";
  }
  if (TEST_CHECK_WORD_RE.test(trimmed) || TEST_CHECK_CAMEL_RE.test(trimmed)) {
    return "test";
  }
  if (TYPECHECK_NAME_RE.test(trimmed)) {
    return "typecheck";
  }
  if (BUILD_NAME_RE.test(trimmed)) {
    return "build";
  }
  if (LINT_NAME_RE.test(trimmed)) {
    return "lint";
  }
  return "other";
}

/**
 * Sandbox 側で検出されたコマンド（Node / Python / Go / Rust）をカテゴリ分類する。
 */
export function classifySandboxCommandKind(command: string): TestCheckKind {
  const trimmed = command.trim();
  if (
    trimmed.endsWith(" test") ||
    /\srun\s+test(?::[^\s]+)?\b/.test(trimmed) ||
    /\b(?:pytest|unittest)\b/.test(trimmed) ||
    /^go\s+test\b/.test(trimmed) ||
    /^cargo\s+test\b/.test(trimmed)
  ) {
    return "test";
  }
  if (/\srun\s+type-?check\b/.test(trimmed) || /\b(?:tsc|mypy|pyright)\b/.test(trimmed)) {
    return "typecheck";
  }
  if (
    /\srun\s+build\b/.test(trimmed) ||
    /^go\s+build\b/.test(trimmed) ||
    /^cargo\s+(?:build|check)\b/.test(trimmed)
  ) {
    return "build";
  }
  if (
    /\srun\s+(?:lint|check|check:ci)\b/.test(trimmed) ||
    /\b(?:ruff|eslint|biome)\b/.test(trimmed) ||
    /^go\s+vet\b/.test(trimmed) ||
    /^cargo\s+clippy\b/.test(trimmed)
  ) {
    return "lint";
  }
  return classifyCheckKind(trimmed);
}

export interface EarlyRejectDecision {
  readonly shouldEarlyReject: boolean;
  readonly earlyRejectReason: string | undefined;
  readonly hasRegressionFailure: boolean;
  readonly triggerChecks: readonly TestCheckResult[];
}

/**
 * `earlyRejectPolicy`（`on_test_failure` / `never` / `strict`）に従い、
 * 早期差し戻し（`early_rejected`）可否と変更起因テスト失敗の有無を判定する。
 */
export function evaluateEarlyReject(
  checks: readonly TestCheckResult[],
  policy: EarlyRejectPolicy,
  requiredTestChecks: readonly string[] = [],
): EarlyRejectDecision {
  const requiredSet = new Set(requiredTestChecks.map((entry) => entry.trim().toLowerCase()));
  const isRequired = (check: TestCheckResult) => requiredSet.has(check.name.trim().toLowerCase());
  const isCoreTestKind = (check: TestCheckResult) =>
    isRequired(check) ||
    check.kind === "test" ||
    check.kind === "typecheck" ||
    check.kind === "build";

  const coreRegressionFailures = checks.filter(
    (check) => check.status === "failed" && isCoreTestKind(check),
  );
  const hasRegressionFailure = coreRegressionFailures.length > 0;

  if (policy === "never") {
    return {
      shouldEarlyReject: false,
      earlyRejectReason: undefined,
      hasRegressionFailure,
      triggerChecks: [],
    };
  }

  if (policy === "on_test_failure") {
    if (coreRegressionFailures.length === 0) {
      return {
        shouldEarlyReject: false,
        earlyRejectReason: undefined,
        hasRegressionFailure,
        triggerChecks: [],
      };
    }
    const names = coreRegressionFailures.map((check) => check.name).join(", ");
    return {
      shouldEarlyReject: true,
      earlyRejectReason: `earlyRejectPolicy=on_test_failure: change-induced failure in ${names}`,
      hasRegressionFailure,
      triggerChecks: coreRegressionFailures,
    };
  }

  // strict: test/typecheck/build/lint の変更起因 failed、または test/typecheck/build の timed_out で差し戻し
  // failed_preexisting は strict でも継続する
  const strictTriggers = checks.filter((check) => {
    if (check.status === "failed") {
      return isCoreTestKind(check) || check.kind === "lint";
    }
    if (check.status === "timed_out") {
      return isCoreTestKind(check);
    }
    return false;
  });

  if (strictTriggers.length === 0) {
    return {
      shouldEarlyReject: false,
      earlyRejectReason: undefined,
      hasRegressionFailure,
      triggerChecks: [],
    };
  }

  const names = strictTriggers.map((check) => `${check.name} (${check.status})`).join(", ");
  return {
    shouldEarlyReject: true,
    earlyRejectReason: `earlyRejectPolicy=strict: check failure/timeout in ${names}`,
    hasRegressionFailure,
    triggerChecks: strictTriggers,
  };
}

export interface EvaluateCommitChecksInput {
  readonly headSha: string;
  readonly baseSha?: string | undefined;
  readonly headSnapshot: CommitChecksSnapshot;
  readonly baseSnapshot?: CommitChecksSnapshot | undefined;
  readonly executionMode: ExecutionMode;
  readonly staticOnlyReason?: StaticOnlyReason | undefined;
  readonly earlyRejectPolicy: EarlyRejectPolicy;
  readonly requiredTestChecks?: readonly string[] | undefined;
  /** PR オープン直後に Check Run / Suite がまだ 0 件のとき 1 回だけ待機を許可するか。 */
  readonly allowInitialGrace?: boolean | undefined;
  readonly evaluatedAt?: string | undefined;
}

export type CommitChecksEvaluation =
  | {
      readonly outcome: "awaiting_ci";
      readonly pendingChecks: readonly string[];
      readonly reason: string;
    }
  | {
      readonly outcome: "needs_sandbox_fallback";
      readonly reason:
        | "no_test_ci"
        | "all_test_ci_skipped"
        | "ci_action_required"
        | "ci_permission_denied";
      readonly ciChecks: readonly TestCheckResult[];
      readonly warning?: string | undefined;
    }
  | {
      readonly outcome: "completed";
      readonly report: TestExecutionReport;
      readonly skipSandboxTests: boolean;
    };

/**
 * GitHub から取得した `headSnapshot`（および必要時 `baseSnapshot`）をもとに、
 * Step 1 の遷移先（`awaiting_ci` / `needs_sandbox_fallback` / `completed`）を決定論的に判定する。
 */
export function evaluateCommitChecksSnapshot(
  input: EvaluateCommitChecksInput,
): CommitChecksEvaluation {
  const requiredChecks = input.requiredTestChecks ?? [];
  const requiredSet = new Set(requiredChecks.map((name) => name.trim().toLowerCase()));
  const baseFailedLookup = buildBaseFailedLookup(input.baseSnapshot);

  // 1. 進行中チェック・未出現の必須チェック・進行中 Check Suite の検出
  const pendingNames: string[] = [];
  const seenCheckNamesLower = new Set<string>();
  const checkRunCountByAppId = new Map<number, number>();

  for (const item of input.headSnapshot.checks) {
    const lowerName = item.name.trim().toLowerCase();
    seenCheckNamesLower.add(lowerName);
    if (item.source === "check_run" && item.appId !== null) {
      checkRunCountByAppId.set(item.appId, (checkRunCountByAppId.get(item.appId) ?? 0) + 1);
    }
    const kind = classifyCheckKind(item.name, requiredChecks);
    const isRelevant =
      isRelevantCheckKind(kind, input.earlyRejectPolicy) || requiredSet.has(lowerName);
    if (isRelevant && item.status !== "completed") {
      pendingNames.push(item.name);
    }
  }

  let hasMissingRequiredCheck = false;
  for (const required of requiredChecks) {
    if (!seenCheckNamesLower.has(required.trim().toLowerCase())) {
      hasMissingRequiredCheck = true;
      pendingNames.push(required);
    }
  }

  // 非テスト系外部アプリ（Vercel 等）の進行中 suite で 5 分空待ちしないよう、
  // 「その appId の check_run がまだ 0 件」または「必須チェック未出現」の場合のみ suite 待機する
  for (const suite of input.headSnapshot.checkSuites) {
    if (suite.status === "completed") {
      continue;
    }
    const hasRegisteredRunsForSuite =
      suite.appId !== null && (checkRunCountByAppId.get(suite.appId) ?? 0) > 0;
    if (!hasRegisteredRunsForSuite || hasMissingRequiredCheck) {
      pendingNames.push(`check_suite:${suite.appSlug ?? suite.id}`);
    }
  }

  if (pendingNames.length > 0) {
    return {
      outcome: "awaiting_ci",
      pendingChecks: pendingNames,
      reason: `waiting for in-progress or pending CI checks: ${pendingNames.join(", ")}`,
    };
  }

  if (
    input.headSnapshot.checks.length === 0 &&
    input.headSnapshot.checkSuites.length === 0 &&
    input.allowInitialGrace === true
  ) {
    return {
      outcome: "awaiting_ci",
      pendingChecks: ["(ci_discovery_grace)"],
      reason: "no CI check runs or suites registered yet; waiting initial discovery grace",
    };
  }

  // 2. 全チェックを TestCheckResult へ正規化（baseSha 照合で failed_preexisting 分離）
  const normalizedChecks: TestCheckResult[] = input.headSnapshot.checks.map((item) =>
    normalizeCiCheckItem(item, requiredChecks, baseFailedLookup),
  );

  const relevantChecks = normalizedChecks.filter((check) => {
    const isReq = requiredSet.has(check.name.trim().toLowerCase());
    return isReq || isRelevantCheckKind(check.kind, input.earlyRejectPolicy);
  });

  if (relevantChecks.length === 0) {
    return {
      outcome: "needs_sandbox_fallback",
      reason: "no_test_ci",
      ciChecks: normalizedChecks,
    };
  }

  const hasFailedOrTimedOut = relevantChecks.some(
    (check) =>
      check.status === "failed" ||
      check.status === "failed_preexisting" ||
      check.status === "timed_out",
  );

  const testCategoryChecks = relevantChecks.filter(
    (check) => check.kind === "test" || requiredSet.has(check.name.trim().toLowerCase()),
  );
  const hasPassedTest = testCategoryChecks.some((check) => check.status === "passed");

  // 失敗・タイムアウトもなくテスト通過も無い場合は Sandbox フォールバック候補（build のみ成功・test は skipped を passed 扱いしない）
  if (!hasFailedOrTimedOut && !hasPassedTest) {
    const hasActionRequired = relevantChecks.some((check) => check.status === "env_unavailable");
    if (hasActionRequired) {
      return {
        outcome: "needs_sandbox_fallback",
        reason: "ci_action_required",
        ciChecks: normalizedChecks,
      };
    }
    if (testCategoryChecks.length === 0) {
      return {
        outcome: "needs_sandbox_fallback",
        reason: "no_test_ci",
        ciChecks: normalizedChecks,
      };
    }
    return {
      outcome: "needs_sandbox_fallback",
      reason: "all_test_ci_skipped",
      ciChecks: normalizedChecks,
    };
  }

  // 3. CI 結果を証跡として採用し、earlyRejectPolicy を判定
  const decision = evaluateEarlyReject(normalizedChecks, input.earlyRejectPolicy, requiredChecks);
  const overallStatus = computeOverallStatus(relevantChecks, "ci");

  const report = testExecutionReportSchema.parse({
    headSha: input.headSha,
    ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
    executionMode: input.executionMode,
    ...(input.executionMode === "static_only"
      ? { staticOnlyReason: input.staticOnlyReason ?? "policy" }
      : {}),
    source: "ci",
    overallStatus,
    hasRegressionFailure: decision.hasRegressionFailure,
    shouldEarlyReject: decision.shouldEarlyReject,
    ...(decision.shouldEarlyReject && decision.earlyRejectReason !== undefined
      ? { earlyRejectReason: decision.earlyRejectReason }
      : {}),
    checks: normalizedChecks,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
  });

  return {
    outcome: "completed",
    report,
    skipSandboxTests: true,
  };
}

export interface EvaluateStep1CiInput {
  readonly headSha: string;
  readonly baseSha?: string | undefined;
  readonly executionMode: ExecutionMode;
  readonly staticOnlyReason?: StaticOnlyReason | undefined;
  readonly earlyRejectPolicy: EarlyRejectPolicy;
  readonly requiredTestChecks?: readonly string[] | undefined;
  readonly allowInitialGrace?: boolean | undefined;
  readonly evaluatedAt?: string | undefined;
}

/**
 * GitHub API から `headSha` のチェックを取得し、失敗がある場合のみ `baseSha` と照合して
 * Step 1 の CI 評価を実行する。
 */
export async function evaluateStep1FromCi(
  github: GitHubPort,
  input: EvaluateStep1CiInput,
): Promise<CommitChecksEvaluation> {
  let headSnapshot: CommitChecksSnapshot;
  try {
    headSnapshot = await github.getCommitChecks(input.headSha);
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return {
        outcome: "needs_sandbox_fallback",
        reason: "ci_permission_denied",
        ciChecks: [],
        warning: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }

  // 待機中チェックがある場合は baseSha 照合を行わず即 awaiting_ci を返して不要な API 呼出を抑える
  const preliminary = evaluateCommitChecksSnapshot({
    ...input,
    headSnapshot,
  });
  if (preliminary.outcome === "awaiting_ci") {
    return preliminary;
  }

  const hasFailureOnHead = headSnapshot.checks.some(
    (item) =>
      item.status === "completed" &&
      item.conclusion !== null &&
      FAILURE_CONCLUSIONS.has(item.conclusion),
  );

  if (!hasFailureOnHead || input.baseSha === undefined || input.baseSha.length === 0) {
    return preliminary;
  }

  let baseSnapshot: CommitChecksSnapshot | undefined;
  try {
    baseSnapshot = await github.getCommitChecks(input.baseSha);
  } catch {
    // baseSha 照合に失敗しても変更起因失敗を隠蔽しない（fail-safe: failed を維持）
    return preliminary;
  }

  return evaluateCommitChecksSnapshot({
    ...input,
    headSnapshot,
    baseSnapshot,
  });
}

export interface StaticOnlySkippedReportInput {
  readonly headSha: string;
  readonly baseSha?: string | undefined;
  readonly staticOnlyReason: StaticOnlyReason;
  readonly detail: string;
  readonly existingCiChecks?: readonly TestCheckResult[] | undefined;
  readonly evaluatedAt?: string | undefined;
}

/**
 * `executionMode === "static_only"` で Sandbox フォールバックを全面遮断した際の
 * スキーマ適合 `TestExecutionReport` を構築する。
 */
export function buildStaticOnlySkippedReport(
  input: StaticOnlySkippedReportInput,
): TestExecutionReport {
  const safeCiChecks = (input.existingCiChecks ?? []).filter((check) => check.source !== "sandbox");
  const blockedCheck: TestCheckResult = {
    name: "sandbox-tests",
    kind: "test",
    source: "static",
    status: "skipped",
    summary: `Sandbox execution blocked in static_only mode (${input.staticOnlyReason}): ${input.detail}`,
  };

  return testExecutionReportSchema.parse({
    headSha: input.headSha,
    ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
    executionMode: "static_only",
    staticOnlyReason: input.staticOnlyReason,
    source: "static_only",
    overallStatus: "static_only",
    hasRegressionFailure: false,
    shouldEarlyReject: false,
    checks: [...safeCiChecks, blockedCheck],
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
  });
}

export interface SandboxFallbackInput {
  readonly headSha: string;
  readonly baseSha?: string | undefined;
  readonly executionMode: ExecutionMode;
  readonly staticOnlyReason?: StaticOnlyReason | undefined;
  readonly earlyRejectPolicy: EarlyRejectPolicy;
  readonly requiredTestChecks?: readonly string[] | undefined;
  /** 依存インストール（`egress: install`）に使う SandboxPort。省略時は `sandbox` を使用。 */
  readonly installSandbox?: SandboxPort | undefined;
  /** すでに `setupProject` 済みのコマンド一覧がある場合に再利用する（二重インストール回避）。 */
  readonly preDetectedTestCommands?: readonly string[] | undefined;
  readonly existingCiChecks?: readonly TestCheckResult[] | undefined;
  readonly fallbackReason?: string | undefined;
  readonly commandTimeoutMs?: number | undefined;
  readonly evaluatedAt?: string | undefined;
}

export interface SandboxFallbackResult {
  readonly report: TestExecutionReport;
  readonly detectedTestCommands: readonly string[];
}

/**
 * CI 待機タイムアウトまたは CI 未設定時に、Sandbox 上で決定論的テスト実行へフォールバックする。
 *
 * - `executionMode === "static_only"` の場合は `setupProject` / `exec` を一切呼ばず即座に遮断する。
 * - `merge_base_sha` 側のローカル二重テスト実行は YAGNI として行わない。
 */
export async function runSandboxDeterministicTests(
  sandbox: SandboxPort,
  input: SandboxFallbackInput,
): Promise<SandboxFallbackResult> {
  if (input.executionMode === "static_only") {
    const report = buildStaticOnlySkippedReport({
      headSha: input.headSha,
      baseSha: input.baseSha,
      staticOnlyReason: input.staticOnlyReason ?? "policy",
      detail: input.fallbackReason ?? "sandbox fallback skipped",
      existingCiChecks: input.existingCiChecks,
      evaluatedAt: input.evaluatedAt,
    });
    return { report, detectedTestCommands: [] };
  }

  const existingCiChecks = input.existingCiChecks ?? [];
  const sandboxChecks: TestCheckResult[] = [];
  let testCommands: readonly string[];

  if (input.preDetectedTestCommands !== undefined) {
    testCommands = input.preDetectedTestCommands;
  } else {
    const setupStartedAt = Date.now();
    try {
      const detection = await setupProject(input.installSandbox ?? sandbox);
      testCommands = detection.testCommands;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.toLowerCase().includes("timed out");
      sandboxChecks.push({
        name: "project-setup",
        kind: "build",
        source: "sandbox",
        status: isTimeout ? "timed_out" : "failed",
        summary: truncateSummary(message),
        durationMs: Math.max(0, Date.now() - setupStartedAt),
      });
      const allChecks = [...existingCiChecks, ...sandboxChecks];
      const decision = evaluateEarlyReject(
        allChecks,
        input.earlyRejectPolicy,
        input.requiredTestChecks,
      );
      const report = testExecutionReportSchema.parse({
        headSha: input.headSha,
        ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
        executionMode: "full",
        source: existingCiChecks.length > 0 ? "mixed" : "sandbox",
        overallStatus: computeOverallStatus(allChecks, "sandbox"),
        hasRegressionFailure: decision.hasRegressionFailure,
        shouldEarlyReject: decision.shouldEarlyReject,
        ...(decision.shouldEarlyReject && decision.earlyRejectReason !== undefined
          ? { earlyRejectReason: decision.earlyRejectReason }
          : {}),
        checks: allChecks,
        evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
      });
      return { report, detectedTestCommands: [] };
    }
  }

  if (testCommands.length === 0) {
    sandboxChecks.push({
      name: "project-tests",
      kind: "test",
      source: "sandbox",
      status: "not_configured",
      summary: "no supported project test commands detected",
    });
  } else {
    for (const command of testCommands) {
      const startedAt = Date.now();
      const result =
        input.commandTimeoutMs !== undefined
          ? await sandbox.exec(command, { timeoutMs: input.commandTimeoutMs })
          : await sandbox.exec(command);
      const durationMs = Math.max(0, Date.now() - startedAt);
      const status: TestCheckStatus = result.timedOut
        ? "timed_out"
        : result.exitCode === 0
          ? "passed"
          : "failed";
      const outputDetail = [result.stderr.trim(), result.stdout.trim()]
        .filter((part) => part.length > 0)
        .join("\n");
      sandboxChecks.push({
        name: command,
        kind: classifySandboxCommandKind(command),
        source: "sandbox",
        status,
        command,
        exitCode: result.exitCode,
        ...(outputDetail.length > 0 ? { summary: truncateSummary(outputDetail) } : {}),
        durationMs,
      });
    }
  }

  const allChecks = [...existingCiChecks, ...sandboxChecks];
  const decision = evaluateEarlyReject(
    allChecks,
    input.earlyRejectPolicy,
    input.requiredTestChecks,
  );
  const overallStatus = computeOverallStatus(allChecks, "sandbox");

  const report = testExecutionReportSchema.parse({
    headSha: input.headSha,
    ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
    executionMode: "full",
    source: existingCiChecks.length > 0 ? "mixed" : "sandbox",
    overallStatus,
    hasRegressionFailure: decision.hasRegressionFailure,
    shouldEarlyReject: decision.shouldEarlyReject,
    ...(decision.shouldEarlyReject && decision.earlyRejectReason !== undefined
      ? { earlyRejectReason: decision.earlyRejectReason }
      : {}),
    checks: allChecks,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
  });

  return { report, detectedTestCommands: testCommands };
}

interface BaseFailedLookup {
  readonly byAppAndName: ReadonlySet<string>;
  readonly byNameWithoutApp: ReadonlySet<string>;
  readonly byAnyName: ReadonlySet<string>;
}

function buildBaseFailedLookup(baseSnapshot: CommitChecksSnapshot | undefined): BaseFailedLookup {
  const byAppAndName = new Set<string>();
  const byNameWithoutApp = new Set<string>();
  const byAnyName = new Set<string>();
  if (baseSnapshot === undefined) {
    return { byAppAndName, byNameWithoutApp, byAnyName };
  }
  for (const item of baseSnapshot.checks) {
    if (
      item.status === "completed" &&
      item.conclusion !== null &&
      FAILURE_CONCLUSIONS.has(item.conclusion)
    ) {
      const normalizedName = item.name.trim();
      byAnyName.add(normalizedName);
      if (item.appId !== null) {
        byAppAndName.add(`${item.appId}:${normalizedName}`);
      } else {
        byNameWithoutApp.add(normalizedName);
      }
    }
  }
  return { byAppAndName, byNameWithoutApp, byAnyName };
}

function normalizeCiCheckItem(
  item: CommitCheckItem,
  requiredChecks: readonly string[],
  baseFailed: BaseFailedLookup,
): TestCheckResult {
  const kind = classifyCheckKind(item.name, requiredChecks);
  let status: TestCheckStatus;
  if (item.status !== "completed") {
    status = "pending";
  } else if (item.conclusion === "success") {
    status = "passed";
  } else if (item.conclusion !== null && FAILURE_CONCLUSIONS.has(item.conclusion)) {
    const trimmedName = item.name.trim();
    const isPreexisting =
      item.appId !== null
        ? baseFailed.byAppAndName.has(`${item.appId}:${trimmedName}`) ||
          baseFailed.byNameWithoutApp.has(trimmedName)
        : baseFailed.byAnyName.has(trimmedName);
    status = isPreexisting ? "failed_preexisting" : "failed";
  } else if (item.conclusion === "timed_out") {
    status = "timed_out";
  } else if (item.conclusion === "action_required") {
    status = "env_unavailable";
  } else if (item.conclusion !== null && SKIPPED_CONCLUSIONS.has(item.conclusion)) {
    status = "skipped";
  } else {
    status = "skipped";
  }

  const summaryParts: string[] = [];
  if (item.conclusion === "action_required") {
    summaryParts.push("GitHub check conclusion: action_required (awaiting workflow approval)");
  } else if (item.conclusion === "cancelled" || item.conclusion === "stale") {
    summaryParts.push(`GitHub check conclusion: ${item.conclusion}`);
  }
  if (item.title) {
    summaryParts.push(item.title);
  }
  if (item.summary) {
    summaryParts.push(item.summary);
  }
  const summary = summaryParts.length > 0 ? truncateSummary(summaryParts.join(" — ")) : undefined;

  const failedTests =
    item.annotations.length > 0
      ? item.annotations
          .slice(0, 20)
          .map((ann) => {
            const loc = ann.path ? `${ann.path}:${ann.startLine}` : "";
            return loc ? `${loc} ${ann.message}` : ann.message;
          })
          .filter((entry) => entry.length > 0)
      : undefined;

  return {
    name: item.name,
    kind,
    source: "ci",
    status,
    ...(summary !== undefined ? { summary } : {}),
    ...(failedTests !== undefined && failedTests.length > 0 ? { failedTests } : {}),
  };
}

function isRelevantCheckKind(kind: TestCheckKind, policy: EarlyRejectPolicy): boolean {
  if (kind === "test" || kind === "typecheck" || kind === "build") {
    return true;
  }
  return policy === "strict" && kind === "lint";
}

function computeOverallStatus(
  checks: readonly TestCheckResult[],
  origin: "ci" | "sandbox",
): TestReportOverallStatus {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "timed_out")) {
    return "timed_out";
  }
  if (checks.some((check) => check.status === "failed_preexisting")) {
    return "failed_preexisting";
  }
  if (checks.some((check) => check.status === "pending")) {
    return "pending";
  }
  if (checks.some((check) => check.status === "passed")) {
    return "passed";
  }
  if (origin === "sandbox" && checks.every((check) => check.status === "not_configured")) {
    return "skipped";
  }
  return "skipped";
}

function truncateSummary(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_COMMAND_SUMMARY_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_COMMAND_SUMMARY_LENGTH)}...`;
}

function isPermissionDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const record = error as unknown as Record<string, unknown>;
  return (
    record.code === "GITHUB_PERMISSION_DENIED" ||
    record.status === 401 ||
    record.status === 403 ||
    record.status === 422
  );
}
