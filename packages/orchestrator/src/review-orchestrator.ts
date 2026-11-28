import { DurableObject } from "cloudflare:workers";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import {
  createPullRequestReadClient,
  createPullRequestWriteClient,
  issueInstallationToken,
} from "@repo/github";
import {
  bindSandbox,
  buildStaticOnlySkippedReport,
  createReviewExtension,
  createReviewModels,
  DEFAULT_CI_DISCOVERY_GRACE_MS,
  DEFAULT_CI_POLL_INTERVAL_MS,
  DEFAULT_CI_WAIT_TIMEOUT_MS,
  evaluateStep1FromCi,
  type GitHubPort,
  type GitHubWritePort,
  guardSandboxPort,
  type HarnessPorts,
  parseModelRef,
  runSandboxDeterministicTests,
  runStep0Preprocessing,
  type SandboxPort,
  type SandboxService,
  StaticOnlyPolicyError,
  setupProject,
} from "@repo/harness";
import {
  type AdminReviewConfigPolicy,
  DEFAULT_REPO_REVIEW_CONFIG,
  type EarlyRejectPolicy,
  type ExecutionMode,
  type PartialRepoReviewConfig,
  type RunStage,
  runStageSchema,
  type StaticOnlyReason,
  type TestCheckResult,
  type TestExecutionReport,
  testCheckResultSchema,
  testExecutionReportSchema,
} from "@repo/review-core";
import { PiHarness, type PiOperationResult, type PiReceipt } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";

import { type CredentialVault, VAULT_INSTANCE_NAME } from "./credential-vault.js";
import { type RecordedFinding, SqlFindingsStore } from "./findings-store.js";
import { vaultCredentials } from "./vault-credentials.js";

/** `REVIEW_MODEL` が未設定のときに使うモデル。 */
export const DEFAULT_REVIEW_MODEL = "openai/gpt-6-sol";

/** サンドボックスの最大生存時間（既定 30 分）。異常終了やハングでもこの時間で強制破棄する。 */
export const DEFAULT_SANDBOX_MAX_LIFETIME_MS = 30 * 60 * 1_000;

/** DO 退避などで完了監視が失われた場合にアイドル破棄を救済するポーリング間隔（既定 60 秒）。 */
export const DEFAULT_SANDBOX_CLEANUP_POLL_MS = 60 * 1_000;

/** 破棄 RPC の待機上限（既定 30 秒）。制御プレーン無応答時に次回チェックアウトを止めないための上限。 */
export const DEFAULT_SANDBOX_DESTROY_TIMEOUT_MS = 30_000;

const SANDBOX_CLEANUP_JOB_ID = "sandbox-cleanup";
const SANDBOX_CLEANUP_JOB_FN = "cleanupSandbox";
const SANDBOX_CLEANUP_HUNG_TIMEOUT_SECONDS = 120;

const STEP1_CI_POLL_JOB_PREFIX = "step1-ci-poll:";
const STEP1_CI_POLL_JOB_FN = "pollCommitChecks";
const STEP1_CI_POLL_HUNG_TIMEOUT_SECONDS = 120;

const STEP1_CONTINUE_JOB_PREFIX = "step1-continue:";
const STEP1_CONTINUE_JOB_FN = "continueStep1";
const STEP1_CONTINUE_HUNG_TIMEOUT_SECONDS = 600;

function ciPollJobId(deliveryId: string): string {
  return `${STEP1_CI_POLL_JOB_PREFIX}${deliveryId}`;
}

function step1ContinueJobId(deliveryId: string): string {
  return `${STEP1_CONTINUE_JOB_PREFIX}${deliveryId}`;
}

const DEFAULT_DESTROY_RETRY_BASE_DELAY_MS = 30_000;
const DESTROY_MAX_RETRIES = 5;
const ABORT_WAIT_TIMEOUT_MS = 10_000;

export interface OrchestratorEnv {
  readonly VAULT: DurableObjectNamespace<CredentialVault>;
  readonly RUNNER: SandboxService;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  /** `<provider>/<model id>` 形式。 */
  readonly REVIEW_MODEL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly OPENCODE_API_KEY?: string;
  readonly OPENROUTER_API_KEY?: string;
}

export interface ReviewRequest {
  /** webhook の delivery id。同じ id の再送は同じレビュー実行として扱う。 */
  readonly deliveryId: string;
  /** `owner/name` 形式。 */
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
  /** PR の base SHA（webhook から伝播、Step 0 の PR メタでも確認する）。 */
  readonly baseSha?: string | undefined;
  /** リポジトリのデフォルトブランチ名。 */
  readonly defaultBranch?: string | undefined;
  /** 外部フォーク PR かどうか（不明時は undefined とし Step 0 で fail-closed 判定）。 */
  readonly isFork?: boolean | undefined;
  readonly action?: "opened" | "synchronize" | "reopened" | undefined;
  /** GitHub App の installation id。 */
  readonly installationId?: number | undefined;
}

export interface ReviewStartReceipt {
  readonly operationId: string;
  readonly accepted: boolean;
  readonly session?: PiReceipt["session"] | undefined;
  readonly stage?: RunStage | undefined;
  readonly executionMode?: ExecutionMode | undefined;
}

export type ReviewResultOutcome =
  | PiOperationResult
  | {
      readonly status: "early_rejected";
      readonly reason: string;
      readonly testReport: TestExecutionReport | null;
    }
  | {
      readonly status: "superseded";
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export interface PullRequestClosedInput {
  readonly deliveryId: string;
  readonly repository: string;
  readonly pullNumber: number;
}

export interface PullRequestClosedReceipt {
  readonly closed: boolean;
  readonly cancelledCiWait: boolean;
  readonly destroyedSandbox: boolean;
}

export interface CheckSuiteCompletedInput {
  readonly deliveryId: string;
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly checkSuiteId?: number | undefined;
  readonly conclusion?: string | null | undefined;
}

export interface CheckSuiteWakeReceipt {
  readonly woken: boolean;
  readonly stage?: RunStage | undefined;
}

export interface Step1RunState {
  readonly deliveryId: string;
  readonly generation: number;
  readonly headSha: string;
  readonly baseSha: string | null;
  readonly defaultBranch: string | null;
  readonly isFork: boolean;
  readonly executionMode: ExecutionMode;
  readonly staticOnlyReason: StaticOnlyReason | null;
  readonly stage: RunStage;
  readonly ciWaitStartedAt: number | null;
  readonly ciWaitDeadlineAt: number | null;
  readonly ciGraceChecked: boolean;
  readonly earlyRejectPolicy: EarlyRejectPolicy;
  readonly requiredTestChecks: readonly string[];
  readonly reviewGuidelines: string | null;
  readonly testReport: TestExecutionReport | null;
  readonly earlyRejectReason: string | null;
  readonly updatedAt: number;
}

interface ReviewTarget {
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly baseSha: string | null;
  readonly defaultBranch: string | null;
  readonly isFork: boolean;
  readonly executionMode: ExecutionMode;
  readonly staticOnlyReason: StaticOnlyReason | null;
  readonly currentGeneration: number;
  readonly installationId: number;
  readonly checkedOutSha: string | null;
  readonly testCommands: readonly string[];
  readonly sandboxActive: boolean;
  readonly sandboxGeneration: number;
  readonly sandboxExpiresAt: number | null;
}

interface CleanupJobPayload {
  readonly generation: number;
  readonly pendingDestroy?: boolean;
  readonly retryCount?: number;
}

interface CiPollJobPayload {
  readonly deliveryId: string;
  readonly generation: number;
  readonly headSha: string;
}

interface Step1ContinueJobPayload {
  readonly deliveryId: string;
  readonly generation: number;
  readonly fallbackReason?: string | undefined;
  readonly ciChecks?: readonly TestCheckResult[] | undefined;
  readonly completedReport?: TestExecutionReport | undefined;
}

type SandboxDestroyReason =
  | "review_completed"
  | "setup_failed"
  | "ttl_expired"
  | "idle_after_recovery"
  | "early_rejected"
  | "pr_closed"
  | "switched_to_static_only"
  | "superseded_by_new_head";

interface InflightSetup {
  readonly key: string;
  readonly promise: Promise<readonly string[]>;
}

const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * PR 単位のレビューを担う Durable Object。
 *
 * Step 0（安全前処理）および Step 1（CI 読取・待機・Sandbox フォールバック・earlyRejectPolicy）を
 * 非 LLM・決定論的に制御し、エージェントループ・トランスクリプト・中断からの復帰は Pi (PiHarness) に委ねる。
 * アラームは Lifecycle が所有するので、このクラスで alarm() を定義してはいけない。
 */
export class ReviewOrchestrator extends DurableObject<OrchestratorEnv> {
  #findingsStore: SqlFindingsStore | null = null;
  readonly #registry = createRegistry();
  readonly #inflightStarts = new Map<string, Promise<ReviewStartReceipt>>();
  readonly #inflightCiChecks = new Map<string, Promise<void>>();
  readonly #inflightContinuations = new Map<string, Promise<void>>();
  readonly #step1Waiters = new Map<string, Set<() => void>>();
  #admittingStarts = 0;
  #inflightSetup: InflightSetup | null = null;
  #inflightIdleCheck: Promise<void> | null = null;
  #inflightCleanup: Promise<void> | null = null;
  #schemaEnsured = false;

  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.#registry.install(createReviewExtension(this.ports()));
      return Harness.open(
        storage,
        { models: this.createModels(), registry: this.#registry },
        context,
      );
    },
    defaults: { model: parseModelRef(this.env.REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL) },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  /** レビューを開始する。Step 0 / Step 1 を決定論的に評価し、待機・早期差し戻し・本レビューへ遷移する。 */
  async start(request: ReviewRequest): Promise<ReviewStartReceipt> {
    if (!SAFE_REPOSITORY.test(request.repository) || request.repository.includes("..")) {
      throw new Error(`invalid repository: ${request.repository}`);
    }
    if (!SAFE_REF.test(request.headSha) || request.headSha.includes("..")) {
      throw new Error(`invalid headSha: ${request.headSha}`);
    }
    if (
      request.baseSha !== undefined &&
      (!SAFE_REF.test(request.baseSha) || request.baseSha.includes(".."))
    ) {
      throw new Error(`invalid baseSha: ${request.baseSha}`);
    }
    if (!Number.isInteger(request.pullNumber) || request.pullNumber <= 0) {
      throw new Error(`invalid pullNumber: ${request.pullNumber}`);
    }
    this.#ensureSchema();

    // すでに受理済みの deliveryId の再送では、サンドボックスを再起動せずに重複結果を返す
    const duplicate = await this.#duplicateReceiptIfRecorded(request.deliveryId);
    if (duplicate !== null) {
      return duplicate;
    }

    // 同じ deliveryId がセットアップ中に並行到着した場合は先行処理の完了を待ってから判定する
    while (true) {
      const existingInflight = this.#inflightStarts.get(request.deliveryId);
      if (!existingInflight) {
        break;
      }
      try {
        await existingInflight;
      } catch {
        // 先行するセットアップ失敗時は後続リクエストで再試行する
      }
      const afterWait = await this.#duplicateReceiptIfRecorded(request.deliveryId);
      if (afterWait !== null) {
        return afterWait;
      }
    }

    this.#admittingStarts += 1;
    const startPromise = (async (): Promise<ReviewStartReceipt> => {
      let setupFailed = false;
      try {
        // Step 0 を既存 review_target や進行中 awaiting_ci を破壊する前に実行し、
        // 遅延・順不同で届いた古い headSha の webhook で新世代を上書きしないようにする。
        const initialInstallationId =
          request.installationId ?? this.#getTarget()?.installationId ?? 0;
        const readPort = this.#createGitHubReadPortForRequest(
          request.repository,
          request.pullNumber,
          initialInstallationId,
        );
        const managedConfig = await this.managedRepoConfig(request.repository);
        const step0 = await runStep0Preprocessing(readPort, {
          headSha: request.headSha,
          webhookIsFork: request.isFork,
          managedConfig,
          adminPolicy: this.adminConfigPolicy(),
        });

        if (step0.status === "stale") {
          const reason = `stale headSha: requested ${step0.requestedHeadSha}, PR head is ${step0.latestHeadSha}`;
          this.#upsertStep1Run({
            deliveryId: request.deliveryId,
            generation: 0,
            headSha: request.headSha,
            baseSha: step0.meta.baseSha,
            defaultBranch: step0.meta.defaultBranch,
            isFork: step0.meta.isFork,
            executionMode: step0.meta.isFork ? "static_only" : "full",
            staticOnlyReason: step0.meta.isFork ? "fork_pr" : null,
            stage: "superseded",
            ciWaitStartedAt: null,
            ciWaitDeadlineAt: null,
            ciGraceChecked: true,
            earlyRejectPolicy: DEFAULT_REPO_REVIEW_CONFIG.earlyRejectPolicy,
            requiredTestChecks: [],
            reviewGuidelines: null,
            testReport: null,
            earlyRejectReason: reason,
          });
          this.#recordDelivery(request.deliveryId);
          return { operationId: request.deliveryId, accepted: false, stage: "superseded" };
        }

        const previousTarget = this.#getTarget();
        const isHeadChanged = previousTarget !== null && previousTarget.headSha !== request.headSha;
        const generation =
          previousTarget === null
            ? 1
            : isHeadChanged
              ? previousTarget.currentGeneration + 1
              : Math.max(1, previousTarget.currentGeneration);

        if (isHeadChanged) {
          await this.#supersedeActiveStep1Runs("superseded by newer headSha");
        }

        this.#saveTarget(request, generation, {
          baseSha: step0.meta.baseSha,
          defaultBranch: step0.meta.defaultBranch,
          isFork: step0.isFork,
          executionMode: step0.executionMode,
          staticOnlyReason: step0.staticOnlyReason ?? null,
        });

        // 以前の full コミットで作られた Sandbox が残っている状態で static_only へ遷移したら即破棄する。
        // harness.abort() を RUNNER.destroy() より先に単独 await すると、ハング中コマンドが解放されず
        // デッドロックするため、Sandbox 稼働時は常に #destroySandbox(..., { forceAbort: true }) で並行中断する。
        if (step0.executionMode === "static_only" && this.#getTarget()?.sandboxActive) {
          await this.#destroySandbox("switched_to_static_only", {
            forceAbort: true,
            swallowErrors: true,
          });
        } else if (isHeadChanged) {
          const pendingOps = await this.harness.pending().catch(() => []);
          if (pendingOps.length > 0) {
            if (this.#getTarget()?.sandboxActive) {
              await this.#destroySandbox("superseded_by_new_head", {
                forceAbort: true,
                swallowErrors: true,
              });
            } else {
              await waitWithTimeout(
                this.harness.abort().catch(() => {}),
                ABORT_WAIT_TIMEOUT_MS,
              );
            }
          }
        }

        const baseRunFields = {
          deliveryId: request.deliveryId,
          generation,
          headSha: request.headSha,
          baseSha: step0.meta.baseSha,
          defaultBranch: step0.meta.defaultBranch,
          isFork: step0.isFork,
          executionMode: step0.executionMode,
          staticOnlyReason: step0.staticOnlyReason ?? null,
          earlyRejectPolicy: step0.config.earlyRejectPolicy,
          requiredTestChecks: step0.config.requiredTestChecks,
          reviewGuidelines: step0.reviewGuidelines,
        };

        // Step 1: GitHub CI 結果の読み取り・判定（非 LLM）
        const allowInitialGrace = this.ciDiscoveryGraceMs() > 0;
        const ciEval = await evaluateStep1FromCi(readPort, {
          headSha: request.headSha,
          baseSha: step0.meta.baseSha,
          executionMode: step0.executionMode,
          staticOnlyReason: step0.staticOnlyReason,
          earlyRejectPolicy: step0.config.earlyRejectPolicy,
          requiredTestChecks: step0.config.requiredTestChecks,
          allowInitialGrace,
        });

        if (!this.#isCurrentGeneration(generation)) {
          return { operationId: request.deliveryId, accepted: false, stage: "superseded" };
        }

        // Branch A: CI 進行中（または初期待機グレース）→ awaiting_ci へ遷移して 30s ポーリングを予約
        if (ciEval.outcome === "awaiting_ci") {
          const now = Date.now();
          const deadline = now + this.ciWaitTimeoutMs();
          const isGrace =
            ciEval.pendingChecks.length === 1 && ciEval.pendingChecks[0] === "(ci_discovery_grace)";
          const firstPollDelay = isGrace
            ? Math.min(this.ciDiscoveryGraceMs(), this.ciWaitTimeoutMs())
            : Math.min(this.ciPollIntervalMs(), this.ciWaitTimeoutMs());

          this.#upsertStep1Run({
            ...baseRunFields,
            stage: "awaiting_ci",
            ciWaitStartedAt: now,
            ciWaitDeadlineAt: deadline,
            ciGraceChecked: !isGrace,
            testReport: null,
            earlyRejectReason: null,
          });
          this.#recordDelivery(request.deliveryId);

          await this.#scheduleCiPollJob(
            {
              deliveryId: request.deliveryId,
              generation,
              headSha: request.headSha,
            },
            now + firstPollDelay,
          );

          return {
            operationId: request.deliveryId,
            accepted: true,
            stage: "awaiting_ci",
            executionMode: step0.executionMode,
          };
        }

        // Branch B: CI 結果を採用（全通過または失敗確定）
        if (ciEval.outcome === "completed") {
          if (ciEval.report.shouldEarlyReject) {
            this.#upsertStep1Run({
              ...baseRunFields,
              stage: "early_rejected",
              ciWaitStartedAt: null,
              ciWaitDeadlineAt: null,
              ciGraceChecked: true,
              testReport: ciEval.report,
              earlyRejectReason: ciEval.report.earlyRejectReason ?? "early rejected by policy",
            });
            this.#recordDelivery(request.deliveryId);
            const currentTarget = this.#getTarget();
            if (currentTarget?.sandboxActive && currentTarget.currentGeneration === generation) {
              await this.#destroySandbox("early_rejected", {
                expectedGeneration: currentTarget.sandboxGeneration,
                swallowErrors: true,
              });
            }
            return {
              operationId: request.deliveryId,
              accepted: true,
              stage: "early_rejected",
              executionMode: step0.executionMode,
            };
          }

          let testCommands: readonly string[] = [];
          let preparedSandboxGen: number | undefined;
          if (step0.executionMode === "full") {
            try {
              testCommands = await this.#prepareTarget(request);
              preparedSandboxGen = this.#getTarget()?.sandboxGeneration;
            } catch (error) {
              setupFailed = true;
              throw error;
            }
          }

          if (!this.#isCurrentGeneration(generation)) {
            if (preparedSandboxGen !== undefined) {
              await this.#destroySandbox("review_completed", {
                expectedGeneration: preparedSandboxGen,
                swallowErrors: true,
              });
            }
            return { operationId: request.deliveryId, accepted: false, stage: "superseded" };
          }

          // result() が submit() 完了前に harness.wait() を呼ばないよう、submit 完了後に primary_review を記録する
          const receipt = await this.harness.submit(
            buildReviewPrompt(request, testCommands, ciEval.report, step0.reviewGuidelines),
            { operationId: request.deliveryId },
          );
          this.#upsertStep1Run({
            ...baseRunFields,
            stage: "primary_review",
            ciWaitStartedAt: null,
            ciWaitDeadlineAt: null,
            ciGraceChecked: true,
            testReport: ciEval.report,
            earlyRejectReason: null,
          });
          this.#recordDelivery(request.deliveryId);
          if (receipt.accepted) {
            this.#watchOperationCompletion(receipt.operationId);
          } else {
            this.ctx.waitUntil(this.#cleanupSandboxIfIdle());
          }
          return {
            ...receipt,
            stage: "primary_review",
            executionMode: step0.executionMode,
          };
        }

        // Branch C: CI 未設定 / 全 skipped / action_required / 権限不足 → Sandbox フォールバック（または static_only 遮断）
        if (step0.executionMode === "static_only") {
          const report = buildStaticOnlySkippedReport({
            headSha: request.headSha,
            baseSha: step0.meta.baseSha,
            staticOnlyReason: step0.staticOnlyReason ?? "policy",
            detail: ciEval.reason,
            existingCiChecks: ciEval.ciChecks,
          });
          if (!this.#isCurrentGeneration(generation)) {
            return { operationId: request.deliveryId, accepted: false, stage: "superseded" };
          }
          const receipt = await this.harness.submit(
            buildReviewPrompt(request, [], report, step0.reviewGuidelines),
            { operationId: request.deliveryId },
          );
          this.#upsertStep1Run({
            ...baseRunFields,
            stage: "primary_review",
            ciWaitStartedAt: null,
            ciWaitDeadlineAt: null,
            ciGraceChecked: true,
            testReport: report,
            earlyRejectReason: null,
          });
          this.#recordDelivery(request.deliveryId);
          if (receipt.accepted) {
            this.#watchOperationCompletion(receipt.operationId);
          }
          return {
            ...receipt,
            stage: "primary_review",
            executionMode: "static_only",
          };
        }

        let testCommands: readonly string[];
        let preparedSandboxGen: number | undefined;
        try {
          testCommands = await this.#prepareTarget(request);
          preparedSandboxGen = this.#getTarget()?.sandboxGeneration;
        } catch (error) {
          setupFailed = true;
          throw error;
        }

        if (!this.#isCurrentGeneration(generation)) {
          if (preparedSandboxGen !== undefined) {
            await this.#destroySandbox("review_completed", {
              expectedGeneration: preparedSandboxGen,
              swallowErrors: true,
            });
          }
          return { operationId: request.deliveryId, accepted: false, stage: "superseded" };
        }

        const lockedSandbox = bindSandbox(this.env.RUNNER, this.ctx.id.toString());
        const fallback = await runSandboxDeterministicTests(lockedSandbox, {
          headSha: request.headSha,
          baseSha: step0.meta.baseSha,
          executionMode: "full",
          earlyRejectPolicy: step0.config.earlyRejectPolicy,
          requiredTestChecks: step0.config.requiredTestChecks,
          preDetectedTestCommands: testCommands,
          existingCiChecks: ciEval.ciChecks,
          fallbackReason: ciEval.reason,
        });

        if (!this.#isCurrentGeneration(generation)) {
          if (preparedSandboxGen !== undefined) {
            await this.#destroySandbox("review_completed", {
              expectedGeneration: preparedSandboxGen,
              swallowErrors: true,
            });
          }
          return { operationId: request.deliveryId, accepted: false, stage: "superseded" };
        }

        if (fallback.report.shouldEarlyReject) {
          this.#upsertStep1Run({
            ...baseRunFields,
            stage: "early_rejected",
            ciWaitStartedAt: null,
            ciWaitDeadlineAt: null,
            ciGraceChecked: true,
            testReport: fallback.report,
            earlyRejectReason: fallback.report.earlyRejectReason ?? "early rejected by policy",
          });
          this.#recordDelivery(request.deliveryId);
          if (preparedSandboxGen !== undefined) {
            await this.#destroySandbox("early_rejected", {
              expectedGeneration: preparedSandboxGen,
              swallowErrors: true,
            });
          }
          return {
            operationId: request.deliveryId,
            accepted: true,
            stage: "early_rejected",
            executionMode: "full",
          };
        }

        const receipt = await this.harness.submit(
          buildReviewPrompt(request, testCommands, fallback.report, step0.reviewGuidelines),
          { operationId: request.deliveryId },
        );
        this.#upsertStep1Run({
          ...baseRunFields,
          stage: "primary_review",
          ciWaitStartedAt: null,
          ciWaitDeadlineAt: null,
          ciGraceChecked: true,
          testReport: fallback.report,
          earlyRejectReason: null,
        });
        this.#recordDelivery(request.deliveryId);
        if (receipt.accepted) {
          this.#watchOperationCompletion(receipt.operationId);
        } else {
          this.ctx.waitUntil(this.#cleanupSandboxIfIdle());
        }
        return {
          ...receipt,
          stage: "primary_review",
          executionMode: "full",
        };
      } finally {
        this.#admittingStarts -= 1;
        // 共有 #inflightSetup を含め全ての並行 start() が受付を終えた時点で、
        // 他に進行中レビューが無ければ失敗したセットアップのコンテナを即座に破棄する。
        // 元のセットアップエラーを失わないよう後片付けの二次例外はすべて捕捉してログに留める。
        if (setupFailed && this.#admittingStarts === 0 && this.#inflightSetup === null) {
          try {
            const pending = await this.harness.pending().catch(() => null);
            if (pending !== null && pending.length === 0 && this.#admittingStarts === 0) {
              await this.#destroySandbox("setup_failed", { swallowErrors: true });
            }
          } catch (cleanupError) {
            console.error({
              event: "orchestrator.sandbox.cleanup_error",
              sandboxId: this.ctx.id.toString(),
              reason: "setup_failed",
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          }
        }
      }
    })();

    this.#inflightStarts.set(request.deliveryId, startPromise);
    const clearInflightStart = () => {
      if (this.#inflightStarts.get(request.deliveryId) === startPromise) {
        this.#inflightStarts.delete(request.deliveryId);
      }
    };
    startPromise.then(clearInflightStart, clearInflightStart);
    return startPromise;
  }

  /**
   * `pull_request` の `closed` アクションを受理し、待機中の CI ポーリングと進行中実行を停止して
   * 残存 Sandbox の即時破棄を起動する。未初期化 DO には一切書き込みや RUNNER 呼出を行わない。
   */
  async handlePullRequestClosed(input: PullRequestClosedInput): Promise<PullRequestClosedReceipt> {
    if (!this.#hasInitializedTarget()) {
      return { closed: true, cancelledCiWait: false, destroyedSandbox: false };
    }
    this.#ensureSchema();
    const target = this.#getTarget();
    if (!target) {
      return { closed: true, cancelledCiWait: false, destroyedSandbox: false };
    }

    // 世代を進めて進行中の Step 0/1/継続処理を無効化
    const nextGeneration = target.currentGeneration + 1;
    this.ctx.storage.sql.exec(
      "UPDATE review_target SET current_generation = ? WHERE id = 1",
      nextGeneration,
    );

    const cancelledCiWait = await this.#supersedeActiveStep1Runs(
      `pull request ${input.repository}#${input.pullNumber} was closed`,
    );

    let destroyedSandbox = false;
    const latest = this.#getTarget();
    if (latest?.sandboxActive) {
      const res = await this.#destroySandbox("pr_closed", {
        forceAbort: true,
        swallowErrors: true,
      });
      destroyedSandbox = res.destroyed;
    } else {
      // Sandbox が無い場合（static_only 等）も進行中 LLM セッションがあれば上限付きで中断する
      const pending = await this.harness.pending().catch(() => []);
      if (pending.length > 0) {
        await waitWithTimeout(
          this.harness.abort().catch(() => {}),
          ABORT_WAIT_TIMEOUT_MS,
        );
      }
    }

    return { closed: true, cancelledCiWait, destroyedSandbox };
  }

  /**
   * `check_suite` (`action: "completed"`) webhook を受理し、該当 `headSha` で `awaiting_ci` 中の
   * PR DO だけを起床させて即座に Step 1 CI 再判定を行う。未初期化・非待機 DO には副作用を起こさない。
   */
  async notifyCheckSuiteCompleted(input: CheckSuiteCompletedInput): Promise<CheckSuiteWakeReceipt> {
    if (!this.#hasInitializedTarget()) {
      return { woken: false };
    }
    this.#ensureSchema();
    const target = this.#getTarget();
    if (!target) {
      return { woken: false };
    }

    const waitingRuns = this.#listAwaitingCiRuns(target.currentGeneration, input.headSha);
    if (waitingRuns.length === 0) {
      return { woken: false };
    }

    await Promise.all(
      waitingRuns.map((waitingRun) =>
        this.#evaluateAwaitingCiRun(
          waitingRun.deliveryId,
          waitingRun.generation,
          waitingRun.headSha,
        ),
      ),
    );
    const primaryRun = waitingRuns[0];
    const updated = primaryRun ? this.#getStep1Run(primaryRun.deliveryId) : null;
    return {
      woken: true,
      ...(updated !== null ? { stage: updated.stage } : {}),
    };
  }

  /** 指定 deliveryId の Step 1 状態と TestExecutionReport を参照する。 */
  async step1Status(deliveryId: string): Promise<Step1RunState | null> {
    if (!this.#hasInitializedTarget()) {
      return null;
    }
    this.#ensureSchema();
    return this.#getStep1Run(deliveryId);
  }

  /** レビュー実行の完了を待ち、後片付けを反映したうえで結果を返す。 */
  async result(deliveryId: string): Promise<ReviewResultOutcome> {
    if (this.#hasInitializedTarget()) {
      this.#ensureSchema();
      while (true) {
        const run = this.#getStep1Run(deliveryId);
        if (run === null) {
          break;
        }
        if (run.stage === "early_rejected") {
          return {
            status: "early_rejected",
            reason: run.earlyRejectReason ?? "early rejected by policy",
            testReport: run.testReport,
          };
        }
        if (run.stage === "superseded") {
          return {
            status: "superseded",
            reason: run.earlyRejectReason ?? "superseded",
          };
        }
        if (run.stage === "failed") {
          return {
            status: "failed",
            reason: run.earlyRejectReason ?? "step1 execution failed",
          };
        }
        if (run.stage === "awaiting_ci" || run.stage === "testing" || run.stage === "queued") {
          await this.#waitForStep1StateChange(deliveryId);
          continue;
        }
        break;
      }
    }

    const outcome = await this.harness.wait(deliveryId);
    await this.#cleanupSandboxIfIdle();
    return outcome;
  }

  /** あるレビュー実行で報告された指摘を返す。 */
  async findings(deliveryId: string): Promise<RecordedFinding[]> {
    if (!this.#hasInitializedTarget()) {
      return [];
    }
    return this.#getFindingsStore().list(deliveryId);
  }

  /**
   * Lifecycle が管理するホストジョブのディスパッチ入口。
   * - `cleanupSandbox`: サンドボックス TTL 強制破棄・アイドル回収・破棄バックオフ再試行
   * - `pollCommitChecks`: `awaiting_ci` 中の 30 秒ポーリング（上限 5 分で Sandbox フォールバック遷移）
   * - `continueStep1`: タイムアウト後フォールバック等のリカバリ実行
   */
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn === STEP1_CI_POLL_JOB_FN) {
      return this.#onPollCommitChecksJob(context.job.payload);
    }
    if (context.job.fn === STEP1_CONTINUE_JOB_FN) {
      return this.#onContinueStep1Job(context.job.payload);
    }
    if (context.job.fn !== SANDBOX_CLEANUP_JOB_FN) {
      return;
    }
    try {
      this.#ensureSchema();
      const payload = parseCleanupJobPayload(context.job.payload);
      const target = this.#getTarget();
      if (!target) {
        return;
      }

      if (payload !== null && target.sandboxGeneration !== payload.generation) {
        return;
      }

      if (payload?.pendingDestroy) {
        return await this.#retryPendingDestroy(payload.generation, payload.retryCount ?? 0);
      }

      if (!target.sandboxActive) {
        return;
      }

      const now = Date.now();
      if (target.sandboxExpiresAt !== null && now >= target.sandboxExpiresAt) {
        await this.#destroySandbox("ttl_expired", {
          expectedGeneration: target.sandboxGeneration,
          forceAbort: true,
          swallowErrors: true,
        });
        return;
      }

      if (this.#admittingStarts === 0 && this.#inflightSetup === null) {
        const pending = await this.harness.pending();
        if (pending.length === 0 && this.#admittingStarts === 0 && this.#inflightSetup === null) {
          await this.#destroySandbox("idle_after_recovery", {
            expectedGeneration: target.sandboxGeneration,
            swallowErrors: true,
          });
          return;
        }
      }

      const nextCheckAt =
        target.sandboxExpiresAt !== null
          ? Math.min(now + this.sandboxCleanupPollMs(), target.sandboxExpiresAt)
          : now + this.sandboxCleanupPollMs();
      return { rescheduleAt: nextCheckAt };
    } catch (error) {
      // Lifecycle のホスト onJob は未捕捉例外でジョブが消失するため、必ず捕捉して再スケジュールする
      console.error({
        event: "orchestrator.sandbox.cleanup_job_error",
        sandboxId: this.ctx.id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return { rescheduleAt: Date.now() + this.sandboxDestroyRetryBaseDelayMs() };
    }
  }

  /** テストでサンドボックス最大生存時間を差し替えるための継ぎ目。 */
  protected sandboxMaxLifetimeMs(): number {
    return DEFAULT_SANDBOX_MAX_LIFETIME_MS;
  }

  /** テストでアイドル回収ポーリング間隔を差し替えるための継ぎ目。 */
  protected sandboxCleanupPollMs(): number {
    return DEFAULT_SANDBOX_CLEANUP_POLL_MS;
  }

  /** テストで破棄失敗時のリトライ基準待機時間を差し替えるための継ぎ目。 */
  protected sandboxDestroyRetryBaseDelayMs(): number {
    return DEFAULT_DESTROY_RETRY_BASE_DELAY_MS;
  }

  /** テストで破棄 RPC の待機上限を差し替えるための継ぎ目。 */
  protected sandboxDestroyTimeoutMs(): number {
    return DEFAULT_SANDBOX_DESTROY_TIMEOUT_MS;
  }

  /** Step 1 CI 待機ポーリング間隔（既定 30 秒）。テストで短縮可能。 */
  protected ciPollIntervalMs(): number {
    return DEFAULT_CI_POLL_INTERVAL_MS;
  }

  /** Step 1 CI 待機の上限時間（既定 5 分）。テストで短縮可能。 */
  protected ciWaitTimeoutMs(): number {
    return DEFAULT_CI_WAIT_TIMEOUT_MS;
  }

  /** Step 1 PR オープン直後の CI 未登録グレース時間（既定 15 秒）。テストで調整可能。 */
  protected ciDiscoveryGraceMs(): number {
    return DEFAULT_CI_DISCOVERY_GRACE_MS;
  }

  /**
   * 管理ストア由来のリポジトリ設定を取得する継ぎ目（Issue #33 で管理ストア DO へ接続）。
   */
  protected managedRepoConfig(_repository: string): Promise<PartialRepoReviewConfig> {
    return Promise.resolve(DEFAULT_REPO_REVIEW_CONFIG);
  }

  /** 管理ストア側の強制クランプポリシー（Issue #33 で拡張）。 */
  protected adminConfigPolicy(): AdminReviewConfigPolicy | undefined {
    return undefined;
  }

  /**
   * Orchestrator 専用の GitHub Write ポート。
   * `HarnessPorts` や Agent ツールには一切露出しない。
   */
  protected githubWritePort(): GitHubWritePort {
    const client = () => {
      const target = this.#requireTarget();
      const repoName = extractRepositoryName(target.repository);
      return createPullRequestWriteClient({
        repository: target.repository,
        pullNumber: target.pullNumber,
        getToken: () => this.#getWriteToken(target.installationId, repoName),
      });
    };
    return {
      postReview: (input) => client().postReview(input),
      resolveThread: (threadId) => client().resolveThread(threadId),
    };
  }

  /** テストで擬似モデルに差し替えるための継ぎ目。 */
  protected createModels(): MutableModels {
    const env = this.env as unknown as Record<string, string | undefined>;
    return createReviewModels({
      credentials: vaultCredentials(this.env.VAULT.getByName(VAULT_INSTANCE_NAME)),
      env: (name) => env[name],
    });
  }

  /** テストで外部依存を差し替えるための継ぎ目。Agent ツールへ渡す GitHub ポートは Read 専用のみ。 */
  protected ports(): HarnessPorts {
    const rawSandbox = bindSandbox(this.env.RUNNER, this.ctx.id.toString());
    const readGitHub = this.#createGitHubReadPort();
    const assertSandboxUsable = () => {
      const target = this.#getTarget();
      if (!target?.sandboxActive) {
        throw new Error("sandbox is no longer active; it has already been destroyed");
      }
      if (target.sandboxExpiresAt !== null && Date.now() >= target.sandboxExpiresAt) {
        throw new Error("sandbox lifetime expired");
      }
    };
    const baseSandbox: SandboxPort = {
      exec: async (command, options) => {
        assertSandboxUsable();
        return rawSandbox.exec(command, options);
      },
      readFile: async (path) => {
        const target = this.#getTarget();
        if (target?.executionMode === "static_only" && !target.sandboxActive) {
          const normalizedPath = path.replace(/^\.\//, "");
          const content = await readGitHub.getFileContent(normalizedPath, target.headSha);
          if (content === null) {
            throw new Error(`ENOENT: ${path}`);
          }
          return content;
        }
        assertSandboxUsable();
        return rawSandbox.readFile(path);
      },
      writeFile: async (path, content) => {
        assertSandboxUsable();
        return rawSandbox.writeFile(path, content);
      },
      listFiles: async (path) => {
        const target = this.#getTarget();
        if (target?.executionMode === "static_only" && !target.sandboxActive) {
          const filesResult = await readGitHub.listPullRequestFiles();
          return filesResult.files.map((entry) => entry.filename);
        }
        assertSandboxUsable();
        return rawSandbox.listFiles(path);
      },
    };
    const sandbox = guardSandboxPort(
      baseSandbox,
      () => this.#getTarget()?.executionMode ?? "full",
      () => this.#getTarget()?.staticOnlyReason ?? undefined,
    );
    return {
      sandbox,
      github: readGitHub,
      findings: {
        report: async (finding) => {
          this.#getFindingsStore().record(await this.#runningOperation(), finding);
        },
      },
    };
  }

  #createGitHubReadPortForRequest(
    repository: string,
    pullNumber: number,
    installationId: number,
  ): GitHubPort {
    const repoName = extractRepositoryName(repository);
    const client = () =>
      createPullRequestReadClient({
        repository,
        pullNumber,
        getToken: () => this.#getRepoReadToken(installationId, repoName),
        getChecksToken: () => this.#getChecksReadToken(installationId, repoName),
        selfAppId: this.env.GITHUB_APP_ID,
      });
    return {
      getPullRequestMeta: () => client().getPullRequestMeta(),
      getDiff: (range) => client().getDiff(range),
      listPullRequestFiles: () => client().listPullRequestFiles(),
      getCommitChecks: (headSha) => client().getCommitChecks(headSha),
      listReviewThreads: () => client().listReviewThreads(),
      getFileContent: (path, ref) => client().getFileContent(path, ref),
    };
  }

  /**
   * PR ごとの DO が都度最小権限の Read installation token を発行して GitHub Read API を呼ぶ。
   * Write 操作（`postReview` / `resolveThread`）はここには一切含めない。
   */
  #createGitHubReadPort(): GitHubPort {
    const client = () => {
      const target = this.#requireTarget();
      const repoName = extractRepositoryName(target.repository);
      return createPullRequestReadClient({
        repository: target.repository,
        pullNumber: target.pullNumber,
        getToken: () => this.#getRepoReadToken(target.installationId, repoName),
        getChecksToken: () => this.#getChecksReadToken(target.installationId, repoName),
        selfAppId: this.env.GITHUB_APP_ID,
      });
    };
    return {
      getPullRequestMeta: () => client().getPullRequestMeta(),
      getDiff: (range) => client().getDiff(range),
      listPullRequestFiles: () => client().listPullRequestFiles(),
      getCommitChecks: (headSha) => client().getCommitChecks(headSha),
      listReviewThreads: () => client().listReviewThreads(),
      getFileContent: (path, ref) => client().getFileContent(path, ref),
    };
  }

  async #onPollCommitChecksJob(rawPayload: unknown): Promise<LifecycleJobOutcome> {
    const payload = parseCiPollJobPayload(rawPayload);
    if (payload === null) {
      return;
    }
    try {
      this.#ensureSchema();
      const rescheduleAt = await this.#evaluateAwaitingCiRun(
        payload.deliveryId,
        payload.generation,
        payload.headSha,
      );
      if (rescheduleAt !== null) {
        return { rescheduleAt };
      }
      return;
    } catch (error) {
      // Lifecycle の host onJob は未捕捉例外でジョブ消滅するため捕捉し、期限内なら再試行を予約する
      console.error({
        event: "orchestrator.step1.ci_poll_error",
        deliveryId: payload.deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
      const run = this.#getStep1Run(payload.deliveryId);
      if (
        run !== null &&
        run.stage === "awaiting_ci" &&
        run.generation === payload.generation &&
        run.ciWaitDeadlineAt !== null
      ) {
        const now = Date.now();
        if (now < run.ciWaitDeadlineAt) {
          return { rescheduleAt: Math.min(now + this.ciPollIntervalMs(), run.ciWaitDeadlineAt) };
        }
        // 期限超過後の API 障害はタイムアウトとしてフォールバック遷移
        const claimed = this.#claimAwaitingCiTransition(payload.deliveryId, payload.generation);
        if (claimed) {
          await this.#dispatchStep1Continuation({
            deliveryId: payload.deliveryId,
            generation: payload.generation,
            fallbackReason: "ci_wait_timeout",
          });
        }
      }
      return;
    }
  }

  /**
   * `awaiting_ci` 中の 1 実行に対して GitHub CI 状態を再確認する。
   * 待機継続が必要な場合は次回ポーリング時刻（epoch ms）を返し、遷移完了時は `null` を返す。
   */
  async #evaluateAwaitingCiRun(
    deliveryId: string,
    generation: number,
    headSha: string,
  ): Promise<number | null> {
    // 先行チェックが進行中なら完了を待ち、それでも awaiting_ci のままなら最新状態を再評価する
    while (true) {
      const existing = this.#inflightCiChecks.get(deliveryId);
      if (!existing) {
        break;
      }
      await existing;
      const after = this.#getStep1Run(deliveryId);
      if (
        after === null ||
        after.stage !== "awaiting_ci" ||
        after.generation !== generation ||
        !this.#isCurrentGeneration(generation)
      ) {
        return null;
      }
    }

    let nextRescheduleAt: number | null = null;
    const work = (async () => {
      const target = this.#getTarget();
      const run = this.#getStep1Run(deliveryId);
      if (
        !target ||
        !run ||
        run.stage !== "awaiting_ci" ||
        run.generation !== generation ||
        target.currentGeneration !== generation ||
        run.headSha !== headSha
      ) {
        return;
      }

      const readPort = this.#createGitHubReadPort();
      const ciEval = await evaluateStep1FromCi(readPort, {
        headSha: run.headSha,
        baseSha: run.baseSha ?? undefined,
        executionMode: run.executionMode,
        staticOnlyReason: run.staticOnlyReason ?? undefined,
        earlyRejectPolicy: run.earlyRejectPolicy,
        requiredTestChecks: run.requiredTestChecks,
        allowInitialGrace: false,
      });

      // await 中に世代変更や PR クローズが割り込んでいないか再確認
      if (!this.#isCurrentGeneration(generation)) {
        return;
      }

      this.ctx.storage.sql.exec(
        "UPDATE step1_runs SET ci_grace_checked = 1, updated_at = ? WHERE delivery_id = ? AND generation = ?",
        Date.now(),
        deliveryId,
        generation,
      );

      if (ciEval.outcome === "awaiting_ci") {
        const now = Date.now();
        const deadline = run.ciWaitDeadlineAt ?? now;
        if (now < deadline) {
          nextRescheduleAt = Math.min(now + this.ciPollIntervalMs(), deadline);
          return;
        }
        // 上限 5 分超過 → Sandbox 決定論的テスト実行へフォールバック遷移
        if (this.#claimAwaitingCiTransition(deliveryId, generation)) {
          await this.lifecycle.jobs.cancel(ciPollJobId(deliveryId)).catch(() => {});
          await this.#dispatchStep1Continuation({
            deliveryId,
            generation,
            fallbackReason: "ci_wait_timeout",
          });
        }
        return;
      }

      if (!this.#claimAwaitingCiTransition(deliveryId, generation)) {
        return;
      }
      await this.lifecycle.jobs.cancel(ciPollJobId(deliveryId)).catch(() => {});

      if (ciEval.outcome === "completed") {
        await this.#dispatchStep1Continuation({
          deliveryId,
          generation,
          completedReport: ciEval.report,
        });
        return;
      }

      await this.#dispatchStep1Continuation({
        deliveryId,
        generation,
        fallbackReason: ciEval.reason,
        ciChecks: ciEval.ciChecks,
      });
    })();

    this.#inflightCiChecks.set(deliveryId, work);
    try {
      await work;
    } finally {
      if (this.#inflightCiChecks.get(deliveryId) === work) {
        this.#inflightCiChecks.delete(deliveryId);
      }
    }

    return nextRescheduleAt;
  }

  /** `awaiting_ci` → `testing` の遷移を 1 系統だけに限定する SQLite CAS。 */
  #claimAwaitingCiTransition(deliveryId: string, generation: number): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE step1_runs
       SET stage = 'testing', updated_at = ?
       WHERE delivery_id = ? AND generation = ? AND stage = 'awaiting_ci'`,
      Date.now(),
      deliveryId,
      generation,
    );
    return cursor.rowsWritten > 0;
  }

  /**
   * `awaiting_ci` から抜けた後の継続処理（CI 確定後の本レビュー開始、またはタイムアウト後の Sandbox フォールバック）を
   * `pollCommitChecks` ジョブから分離して安全に実行する。
   */
  async #dispatchStep1Continuation(payload: Step1ContinueJobPayload): Promise<void> {
    // DO 退避時のリカバリ安全網として配信単位の継続ジョブも予約しつつ、即座に waitUntil で開始する
    await this.lifecycle.jobs
      .push({
        id: step1ContinueJobId(payload.deliveryId),
        fn: STEP1_CONTINUE_JOB_FN,
        time: Date.now() + 60_000,
        payload,
        singleflight: true,
        hungTimeoutSeconds: STEP1_CONTINUE_HUNG_TIMEOUT_SECONDS,
      })
      .catch(() => {});

    const work = this.#executeStep1Continuation(payload);
    this.ctx.waitUntil(work);
  }

  async #onContinueStep1Job(rawPayload: unknown): Promise<LifecycleJobOutcome> {
    const payload = parseStep1ContinuePayload(rawPayload);
    if (payload === null) {
      return;
    }
    try {
      this.#ensureSchema();
      await this.#executeStep1Continuation(payload);
    } catch (error) {
      console.error({
        event: "orchestrator.step1.continue_job_error",
        deliveryId: payload.deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  async #executeStep1Continuation(payload: Step1ContinueJobPayload): Promise<void> {
    const { deliveryId, generation } = payload;
    const continuationKey = `${deliveryId}:${generation}`;
    const existing = this.#inflightContinuations.get(continuationKey);
    if (existing) {
      await existing;
      return;
    }

    const jobId = step1ContinueJobId(deliveryId);
    const work = (async () => {
      let preparedSandboxGen: number | undefined;
      try {
        const target = this.#getTarget();
        const run = this.#getStep1Run(deliveryId);
        if (
          !target ||
          !run ||
          run.stage !== "testing" ||
          run.generation !== generation ||
          target.currentGeneration !== generation
        ) {
          await this.lifecycle.jobs.cancel(jobId).catch(() => {});
          return;
        }

        const reconstructedRequest: ReviewRequest = {
          deliveryId,
          repository: target.repository,
          pullNumber: target.pullNumber,
          headSha: run.headSha,
          baseSha: run.baseSha ?? undefined,
          defaultBranch: run.defaultBranch ?? undefined,
          isFork: run.isFork,
          installationId: target.installationId,
        };

        // Case 1: CI 結果確定済み（全通過 / 失敗）
        if (payload.completedReport !== undefined) {
          const report = payload.completedReport;
          if (report.shouldEarlyReject) {
            this.#finalizeStep1Terminal(
              deliveryId,
              generation,
              "early_rejected",
              report,
              report.earlyRejectReason ?? "early rejected by policy",
            );
            const cur = this.#getTarget();
            if (cur?.sandboxActive && cur.currentGeneration === generation) {
              await this.#destroySandbox("early_rejected", {
                expectedGeneration: cur.sandboxGeneration,
                swallowErrors: true,
              });
            }
            await this.lifecycle.jobs.cancel(jobId).catch(() => {});
            return;
          }

          let testCommands: readonly string[] = [];
          if (run.executionMode === "full") {
            testCommands = await this.#prepareTarget(reconstructedRequest);
            preparedSandboxGen = this.#getTarget()?.sandboxGeneration;
          }

          if (!this.#isCurrentGeneration(generation)) {
            if (preparedSandboxGen !== undefined) {
              await this.#destroySandbox("review_completed", {
                expectedGeneration: preparedSandboxGen,
                swallowErrors: true,
              });
            }
            await this.lifecycle.jobs.cancel(jobId).catch(() => {});
            return;
          }

          await this.#submitPrimaryReview(
            reconstructedRequest,
            generation,
            testCommands,
            report,
            run.reviewGuidelines,
          );
          await this.lifecycle.jobs.cancel(jobId).catch(() => {});
          return;
        }

        // Case 2: タイムアウトまたは CI 未設定 → static_only は遮断、full は Sandbox 決定論的テスト実行
        if (run.executionMode === "static_only") {
          const report = buildStaticOnlySkippedReport({
            headSha: run.headSha,
            baseSha: run.baseSha ?? undefined,
            staticOnlyReason: run.staticOnlyReason ?? "policy",
            detail: payload.fallbackReason ?? "ci_wait_timeout",
            existingCiChecks: payload.ciChecks,
          });
          if (!this.#isCurrentGeneration(generation)) {
            await this.lifecycle.jobs.cancel(jobId).catch(() => {});
            return;
          }
          await this.#submitPrimaryReview(
            reconstructedRequest,
            generation,
            [],
            report,
            run.reviewGuidelines,
          );
          await this.lifecycle.jobs.cancel(jobId).catch(() => {});
          return;
        }

        const testCommands = await this.#prepareTarget(reconstructedRequest);
        preparedSandboxGen = this.#getTarget()?.sandboxGeneration;
        if (!this.#isCurrentGeneration(generation)) {
          if (preparedSandboxGen !== undefined) {
            await this.#destroySandbox("review_completed", {
              expectedGeneration: preparedSandboxGen,
              swallowErrors: true,
            });
          }
          await this.lifecycle.jobs.cancel(jobId).catch(() => {});
          return;
        }

        const lockedSandbox = bindSandbox(this.env.RUNNER, this.ctx.id.toString());
        const fallback = await runSandboxDeterministicTests(lockedSandbox, {
          headSha: run.headSha,
          baseSha: run.baseSha ?? undefined,
          executionMode: "full",
          earlyRejectPolicy: run.earlyRejectPolicy,
          requiredTestChecks: run.requiredTestChecks,
          preDetectedTestCommands: testCommands,
          existingCiChecks: payload.ciChecks,
          fallbackReason: payload.fallbackReason ?? "ci_wait_timeout",
        });

        if (!this.#isCurrentGeneration(generation)) {
          if (preparedSandboxGen !== undefined) {
            await this.#destroySandbox("review_completed", {
              expectedGeneration: preparedSandboxGen,
              swallowErrors: true,
            });
          }
          await this.lifecycle.jobs.cancel(jobId).catch(() => {});
          return;
        }

        if (fallback.report.shouldEarlyReject) {
          this.#finalizeStep1Terminal(
            deliveryId,
            generation,
            "early_rejected",
            fallback.report,
            fallback.report.earlyRejectReason ?? "early rejected by policy",
          );
          if (preparedSandboxGen !== undefined) {
            await this.#destroySandbox("early_rejected", {
              expectedGeneration: preparedSandboxGen,
              swallowErrors: true,
            });
          }
          await this.lifecycle.jobs.cancel(jobId).catch(() => {});
          return;
        }

        await this.#submitPrimaryReview(
          reconstructedRequest,
          generation,
          testCommands,
          fallback.report,
          run.reviewGuidelines,
        );
        await this.lifecycle.jobs.cancel(jobId).catch(() => {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#finalizeStep1Terminal(deliveryId, generation, "failed", null, message);
        if (preparedSandboxGen !== undefined) {
          await this.#destroySandbox("setup_failed", {
            expectedGeneration: preparedSandboxGen,
            swallowErrors: true,
          });
        }
        await this.lifecycle.jobs.cancel(jobId).catch(() => {});
      }
    })();

    this.#inflightContinuations.set(continuationKey, work);
    try {
      await work;
    } finally {
      if (this.#inflightContinuations.get(continuationKey) === work) {
        this.#inflightContinuations.delete(continuationKey);
      }
    }
  }

  async #submitPrimaryReview(
    request: ReviewRequest,
    generation: number,
    testCommands: readonly string[],
    report: TestExecutionReport,
    reviewGuidelines: string | null,
  ): Promise<void> {
    const receipt = await this.harness.submit(
      buildReviewPrompt(request, testCommands, report, reviewGuidelines),
      { operationId: request.deliveryId },
    );
    this.ctx.storage.sql.exec(
      `UPDATE step1_runs
       SET stage = 'primary_review', test_report_json = ?, early_reject_reason = NULL, updated_at = ?
       WHERE delivery_id = ? AND generation = ? AND stage = 'testing'`,
      JSON.stringify(report),
      Date.now(),
      request.deliveryId,
      generation,
    );
    this.#notifyStep1Waiters(request.deliveryId);
    if (receipt.accepted) {
      this.#watchOperationCompletion(receipt.operationId);
    } else {
      this.ctx.waitUntil(this.#cleanupSandboxIfIdle());
    }
  }

  #finalizeStep1Terminal(
    deliveryId: string,
    generation: number,
    stage: "early_rejected" | "superseded" | "failed",
    report: TestExecutionReport | null,
    reason: string,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE step1_runs
       SET stage = ?, test_report_json = COALESCE(?, test_report_json), early_reject_reason = ?, updated_at = ?
       WHERE delivery_id = ? AND generation = ? AND stage = 'testing'`,
      stage,
      report !== null ? JSON.stringify(report) : null,
      reason,
      Date.now(),
      deliveryId,
      generation,
    );
    this.#notifyStep1Waiters(deliveryId);
  }

  async #supersedeActiveStep1Runs(reason: string): Promise<boolean> {
    const activeRows = this.ctx.storage.sql
      .exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM step1_runs WHERE stage IN ('queued', 'awaiting_ci', 'testing')",
      )
      .toArray();
    if (activeRows.length === 0) {
      return false;
    }

    this.ctx.storage.sql.exec(
      `UPDATE step1_runs
       SET stage = 'superseded', early_reject_reason = ?, updated_at = ?
       WHERE stage IN ('queued', 'awaiting_ci', 'testing')`,
      reason,
      Date.now(),
    );
    for (const row of activeRows) {
      await this.lifecycle.jobs.cancel(ciPollJobId(row.delivery_id)).catch(() => {});
      await this.lifecycle.jobs.cancel(step1ContinueJobId(row.delivery_id)).catch(() => {});
      this.#notifyStep1Waiters(row.delivery_id);
    }
    return true;
  }

  async #duplicateReceiptIfRecorded(deliveryId: string): Promise<ReviewStartReceipt | null> {
    if (!this.#hasDelivery(deliveryId)) {
      return null;
    }
    const run = this.#getStep1Run(deliveryId);
    if (
      run !== null &&
      (run.stage === "awaiting_ci" ||
        run.stage === "testing" ||
        run.stage === "early_rejected" ||
        run.stage === "superseded" ||
        run.stage === "failed")
    ) {
      return {
        operationId: deliveryId,
        accepted: false,
        stage: run.stage,
        executionMode: run.executionMode,
      };
    }
    const receipt = await this.harness.submit("", { operationId: deliveryId });
    return {
      ...receipt,
      ...(run !== null ? { stage: run.stage, executionMode: run.executionMode } : {}),
    };
  }

  async #scheduleCiPollJob(payload: CiPollJobPayload, time: number): Promise<void> {
    await this.lifecycle.jobs.push({
      id: ciPollJobId(payload.deliveryId),
      fn: STEP1_CI_POLL_JOB_FN,
      time,
      payload,
      singleflight: true,
      hungTimeoutSeconds: STEP1_CI_POLL_HUNG_TIMEOUT_SECONDS,
    });
  }

  #waitForStep1StateChange(deliveryId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let waiters = this.#step1Waiters.get(deliveryId);
      if (!waiters) {
        waiters = new Set();
        this.#step1Waiters.set(deliveryId, waiters);
      }
      const onNotify = () => {
        waiters?.delete(onNotify);
        if (waiters && waiters.size === 0) {
          this.#step1Waiters.delete(deliveryId);
        }
        resolve();
      };
      waiters.add(onNotify);
    });
  }

  #notifyStep1Waiters(deliveryId: string): void {
    const waiters = this.#step1Waiters.get(deliveryId);
    if (!waiters) {
      return;
    }
    for (const notify of [...waiters]) {
      notify();
    }
  }

  #hasInitializedTarget(): boolean {
    const table = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_target'",
      )
      .toArray()[0];
    if (!table) {
      return false;
    }
    const row = this.ctx.storage.sql
      .exec<{ id: number }>("SELECT id FROM review_target WHERE id = 1")
      .toArray()[0];
    return row !== undefined;
  }

  #getFindingsStore(): SqlFindingsStore {
    if (this.#findingsStore === null) {
      this.#findingsStore = new SqlFindingsStore(this.ctx.storage.sql);
    }
    return this.#findingsStore;
  }

  #ensureSchema(): void {
    if (this.#schemaEnsured) {
      // テストで DROP TABLE された旧スキーマ移行ケースにも追従するため review_target 列存在は毎回確認しない代わりに
      // テーブルが無い場合だけ再初期化できるよう軽量チェックする
      const hasTable = this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_target'",
        )
        .toArray()[0];
      const cols = hasTable
        ? this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(review_target)").toArray()
        : [];
      if (hasTable && cols.some((col) => col.name === "current_generation")) {
        return;
      }
    }

    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS review_target (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      repository TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT,
      default_branch TEXT,
      is_fork INTEGER NOT NULL DEFAULT 0,
      execution_mode TEXT NOT NULL DEFAULT 'full',
      static_only_reason TEXT,
      current_generation INTEGER NOT NULL DEFAULT 0,
      installation_id INTEGER NOT NULL,
      checked_out_sha TEXT,
      test_commands_json TEXT NOT NULL DEFAULT '[]',
      sandbox_active INTEGER NOT NULL DEFAULT 0,
      sandbox_generation INTEGER NOT NULL DEFAULT 0,
      sandbox_expires_at INTEGER
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS review_deliveries (
      delivery_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS step1_runs (
      delivery_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT,
      default_branch TEXT,
      is_fork INTEGER NOT NULL DEFAULT 0,
      execution_mode TEXT NOT NULL DEFAULT 'full',
      static_only_reason TEXT,
      stage TEXT NOT NULL,
      ci_wait_started_at INTEGER,
      ci_wait_deadline_at INTEGER,
      ci_grace_checked INTEGER NOT NULL DEFAULT 0,
      early_reject_policy TEXT NOT NULL DEFAULT 'on_test_failure',
      required_test_checks_json TEXT NOT NULL DEFAULT '[]',
      review_guidelines TEXT,
      test_report_json TEXT,
      early_reject_reason TEXT,
      updated_at INTEGER NOT NULL
    )`);

    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(review_target)")
      .toArray();
    const hasCol = (name: string) => columns.some((col) => col.name === name);

    if (!hasCol("test_commands_json")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN test_commands_json TEXT NOT NULL DEFAULT '[]'",
      );
      this.ctx.storage.sql.exec("UPDATE review_target SET checked_out_sha = NULL WHERE id = 1");
    }
    if (!hasCol("sandbox_active")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN sandbox_active INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasCol("sandbox_generation")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN sandbox_generation INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasCol("sandbox_expires_at")) {
      this.ctx.storage.sql.exec("ALTER TABLE review_target ADD COLUMN sandbox_expires_at INTEGER");
    }
    if (!hasCol("base_sha")) {
      this.ctx.storage.sql.exec("ALTER TABLE review_target ADD COLUMN base_sha TEXT");
    }
    if (!hasCol("default_branch")) {
      this.ctx.storage.sql.exec("ALTER TABLE review_target ADD COLUMN default_branch TEXT");
    }
    if (!hasCol("is_fork")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN is_fork INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!hasCol("execution_mode")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'full'",
      );
    }
    if (!hasCol("static_only_reason")) {
      this.ctx.storage.sql.exec("ALTER TABLE review_target ADD COLUMN static_only_reason TEXT");
    }
    if (!hasCol("current_generation")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE review_target ADD COLUMN current_generation INTEGER NOT NULL DEFAULT 0",
      );
    }

    this.#schemaEnsured = true;
  }

  /**
   * サンドボックスのセットアップ（チェックアウトと依存インストール）を直列化する。
   * 同じ head のセットアップが進行中であれば、後続の git clean -fdx で node_modules を壊さないよう
   * 実行中の Promise を共有して待つ。
   */
  #prepareTarget(request: ReviewRequest): Promise<readonly string[]> {
    const key = `${request.repository}#${request.pullNumber}@${request.headSha}`;
    if (this.#inflightSetup?.key === key) {
      if (request.installationId !== undefined && request.installationId !== 0) {
        this.ctx.storage.sql.exec(
          "UPDATE review_target SET installation_id = ? WHERE id = 1",
          request.installationId,
        );
      }
      return this.#inflightSetup.promise;
    }

    const previous = this.#inflightSetup?.promise ?? Promise.resolve();
    let current!: InflightSetup;
    const run = async (): Promise<readonly string[]> => {
      try {
        try {
          await previous;
        } catch {
          // 先行する別 head のセットアップ失敗はそちらの呼び出し元に返っているため、後続のセットアップは続行する
        }
        this.#ensureSchema();
        return await this.#checkoutHead();
      } finally {
        // 呼び出し元の catch/finally が走る前に #inflightSetup を確実にクリアする
        if (this.#inflightSetup === current) {
          this.#inflightSetup = null;
        }
      }
    };

    const promise = run();
    current = { key, promise };
    this.#inflightSetup = current;
    return promise;
  }

  /**
   * PR の head をサンドボックスのカレントディレクトリへチェックアウトし、
   * 対応するエコシステム（Node.js / Python / Go / Rust）を検出して依存をインストールする。
   * `executionMode === "static_only"` の場合は即座に拒否する。
   */
  async #checkoutHead(): Promise<readonly string[]> {
    if (this.#inflightCleanup) {
      await waitWithTimeout(this.#inflightCleanup, this.sandboxDestroyTimeoutMs());
    }

    this.#ensureSchema();
    const target = this.#requireTarget();
    if (target.executionMode === "static_only") {
      throw new StaticOnlyPolicyError("setupProject", target.staticOnlyReason ?? undefined);
    }

    const now = Date.now();
    if (
      target.sandboxActive &&
      target.checkedOutSha === target.headSha &&
      target.sandboxExpiresAt !== null &&
      now < target.sandboxExpiresAt
    ) {
      await this.#extendSandboxLifetime(target.sandboxGeneration);
      return target.testCommands;
    }

    const generation = target.sandboxGeneration + 1;
    const expiresAt = now + this.sandboxMaxLifetimeMs();
    this.ctx.storage.sql.exec(
      `UPDATE review_target
       SET checked_out_sha = NULL,
           test_commands_json = '[]',
           sandbox_active = 1,
           sandbox_generation = ?,
           sandbox_expires_at = ?
       WHERE id = 1`,
      generation,
      expiresAt,
    );
    await this.#scheduleCleanupJob(
      generation,
      Math.min(now + this.sandboxCleanupPollMs(), expiresAt),
    );

    const sandboxId = this.ctx.id.toString();
    const repoName = extractRepositoryName(target.repository);
    const token = await this.#getCheckoutToken(target.installationId, repoName);
    const basicAuth = btoa(`x-access-token:${token}`);
    const repoUrl = `https://github.com/${target.repository}.git`;
    // core.symlinks=false でシンボリックリンク展開によるコンテナ内部ファイル覗き見を防止
    const command = [
      "git init -q",
      `GIT_TERMINAL_PROMPT=0 git fetch --depth 1 ${repoUrl} -- ${target.headSha}`,
      "git -c core.symlinks=false checkout -q --force FETCH_HEAD",
      "git clean -fdx -q",
    ].join(" && ");

    const result = await this.env.RUNNER.exec(sandboxId, command, {
      egress: {
        profile: "checkout",
        repository: target.repository,
        githubToken: token,
        resetContainer: true,
      },
    });
    if (result.timedOut || result.exitCode !== 0) {
      const rawOutput = [result.stderr, result.stdout].filter(Boolean).join("\n");
      const detail = redactSecrets(rawOutput, [token, basicAuth]).trim();
      const verb = result.timedOut ? "timed out while checking out" : "failed to checkout";
      throw new Error(
        `${verb} ${target.repository}@${target.headSha} (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }

    const installSandbox = bindSandbox(this.env.RUNNER, sandboxId, {
      egress: { profile: "install" },
    });
    const project = await setupProject(installSandbox);

    const latest = this.#getTarget();
    if (!latest?.sandboxActive || latest.sandboxGeneration !== generation) {
      throw new Error("sandbox was destroyed while preparing target");
    }

    this.ctx.storage.sql.exec(
      "UPDATE review_target SET checked_out_sha = ?, test_commands_json = ? WHERE id = 1 AND sandbox_generation = ?",
      target.headSha,
      JSON.stringify(project.testCommands),
      generation,
    );

    return project.testCommands;
  }

  #watchOperationCompletion(operationId: string): void {
    const work = (async () => {
      try {
        await this.harness.wait(operationId);
      } catch {
        // 待機中断時は永続クリーンアップジョブに委ねる
      }
      await this.#cleanupSandboxIfIdle();
    })();
    this.ctx.waitUntil(work);
  }

  async #cleanupSandboxIfIdle(): Promise<void> {
    if (this.#inflightIdleCheck) {
      return this.#inflightIdleCheck;
    }
    const run = async (): Promise<void> => {
      try {
        if (this.#inflightCleanup) {
          await waitWithTimeout(this.#inflightCleanup, this.sandboxDestroyTimeoutMs());
        }
        const target = this.#getTarget();
        if (!target?.sandboxActive) {
          return;
        }
        if (this.#hasPendingDestroyJob(target.sandboxGeneration)) {
          return;
        }
        if (this.#admittingStarts > 0 || this.#inflightSetup !== null) {
          return;
        }
        const pending = await this.harness.pending();
        if (pending.length > 0) {
          return;
        }
        if (this.#admittingStarts > 0 || this.#inflightSetup !== null) {
          return;
        }
        const latest = this.#getTarget();
        if (!latest?.sandboxActive || latest.sandboxGeneration !== target.sandboxGeneration) {
          if (this.#inflightCleanup) {
            await waitWithTimeout(this.#inflightCleanup, this.sandboxDestroyTimeoutMs());
          }
          return;
        }
        await this.#destroySandbox("review_completed", {
          expectedGeneration: target.sandboxGeneration,
          swallowErrors: true,
        });
      } catch (error) {
        console.error({
          event: "orchestrator.sandbox.cleanup_error",
          sandboxId: this.ctx.id.toString(),
          reason: "review_completed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const check = run();
    this.#inflightIdleCheck = check;
    try {
      await check;
    } finally {
      if (this.#inflightIdleCheck === check) {
        this.#inflightIdleCheck = null;
      }
    }
  }

  async #extendSandboxLifetime(generation: number): Promise<void> {
    const now = Date.now();
    const expiresAt = now + this.sandboxMaxLifetimeMs();
    this.ctx.storage.sql.exec(
      "UPDATE review_target SET sandbox_expires_at = ? WHERE id = 1 AND sandbox_generation = ?",
      expiresAt,
      generation,
    );
    await this.#scheduleCleanupJob(
      generation,
      Math.min(now + this.sandboxCleanupPollMs(), expiresAt),
    );
  }

  async #scheduleCleanupJob(
    generation: number,
    time: number,
    extra?: { readonly pendingDestroy?: boolean; readonly retryCount?: number },
  ): Promise<void> {
    const payload: CleanupJobPayload = {
      generation,
      ...(extra?.pendingDestroy ? { pendingDestroy: true } : {}),
      ...(extra?.retryCount !== undefined ? { retryCount: extra.retryCount } : {}),
    };
    await this.lifecycle.jobs.push({
      id: SANDBOX_CLEANUP_JOB_ID,
      fn: SANDBOX_CLEANUP_JOB_FN,
      time,
      payload,
      singleflight: true,
      hungTimeoutSeconds: SANDBOX_CLEANUP_HUNG_TIMEOUT_SECONDS,
    });
  }

  async #destroySandbox(
    reason: SandboxDestroyReason,
    options: {
      readonly expectedGeneration?: number;
      readonly forceAbort?: boolean;
      readonly swallowErrors?: boolean;
    } = {},
  ): Promise<{ readonly destroyed: boolean }> {
    const previous = this.#inflightCleanup;
    const run = async (): Promise<{ readonly destroyed: boolean }> => {
      const sandboxId = this.ctx.id.toString();
      try {
        if (previous) {
          await waitWithTimeout(previous, this.sandboxDestroyTimeoutMs());
        }

        const target = this.#getTarget();
        if (!target?.sandboxActive) {
          if (!target || !this.#hasPendingDestroyJob(target.sandboxGeneration)) {
            await this.lifecycle.jobs.cancel(SANDBOX_CLEANUP_JOB_ID);
          }
          return { destroyed: false };
        }
        if (
          options.expectedGeneration !== undefined &&
          target.sandboxGeneration !== options.expectedGeneration
        ) {
          return { destroyed: false };
        }
        if (!options.forceAbort && this.#hasPendingDestroyJob(target.sandboxGeneration)) {
          return { destroyed: false };
        }

        const nextGeneration = target.sandboxGeneration + 1;
        if (options.forceAbort) {
          this.ctx.storage.sql.exec(
            `UPDATE review_target
             SET checked_out_sha = NULL,
                 test_commands_json = '[]',
                 sandbox_active = 0,
                 sandbox_generation = ?,
                 sandbox_expires_at = NULL
             WHERE id = 1`,
            nextGeneration,
          );
        } else {
          this.ctx.storage.sql.exec(
            `UPDATE review_target
             SET checked_out_sha = NULL,
                 test_commands_json = '[]',
                 sandbox_generation = ?
             WHERE id = 1`,
            nextGeneration,
          );
        }

        await this.#scheduleCleanupJob(
          nextGeneration,
          Date.now() + this.sandboxDestroyRetryBaseDelayMs(),
          { pendingDestroy: true, retryCount: 0 },
        );

        const abortPromise = options.forceAbort
          ? this.harness.abort().catch((error: unknown) => {
              console.error({
                event: "orchestrator.sandbox.abort_error",
                sandboxId,
                reason,
                error: error instanceof Error ? error.message : String(error),
              });
            })
          : null;

        try {
          await this.#destroyWithTimeout(sandboxId);
        } catch (error) {
          const retryCount = 1;
          console.error({
            event: "orchestrator.sandbox.destroy_failed",
            sandboxId,
            reason,
            retryCount,
            error: error instanceof Error ? error.message : String(error),
          });
          const retryAt = Date.now() + this.sandboxDestroyRetryBaseDelayMs();
          try {
            await this.#scheduleCleanupJob(nextGeneration, retryAt, {
              pendingDestroy: true,
              retryCount,
            });
          } catch (scheduleError) {
            console.error({
              event: "orchestrator.sandbox.cleanup_error",
              sandboxId,
              reason,
              error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError),
            });
          }
          if (abortPromise) {
            await waitWithTimeout(abortPromise, ABORT_WAIT_TIMEOUT_MS);
          }
          if (options.swallowErrors) {
            return { destroyed: false };
          }
          throw error;
        }

        this.ctx.storage.sql.exec(
          "UPDATE review_target SET sandbox_active = 0, sandbox_expires_at = NULL WHERE id = 1 AND sandbox_generation = ?",
          nextGeneration,
        );
        try {
          await this.lifecycle.jobs.cancel(SANDBOX_CLEANUP_JOB_ID);
        } catch (cancelError) {
          console.error({
            event: "orchestrator.sandbox.cleanup_error",
            sandboxId,
            reason,
            error: cancelError instanceof Error ? cancelError.message : String(cancelError),
          });
        }
        if (abortPromise) {
          await waitWithTimeout(abortPromise, ABORT_WAIT_TIMEOUT_MS);
        }
        console.info({
          event: "orchestrator.sandbox.destroyed",
          sandboxId,
          reason,
        });
        return { destroyed: true };
      } catch (error) {
        console.error({
          event: "orchestrator.sandbox.cleanup_error",
          sandboxId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        if (options.swallowErrors) {
          return { destroyed: false };
        }
        throw error;
      }
    };

    const promise = run();
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    this.#inflightCleanup = tracked;
    void tracked.then(() => {
      if (this.#inflightCleanup === tracked) {
        this.#inflightCleanup = null;
      }
    });
    return promise;
  }

  async #retryPendingDestroy(
    expectedGeneration: number,
    previousRetryCount: number,
  ): Promise<LifecycleJobOutcome> {
    const previous = this.#inflightCleanup;
    const run = async (): Promise<LifecycleJobOutcome> => {
      const sandboxId = this.ctx.id.toString();
      try {
        if (previous) {
          await waitWithTimeout(previous, this.sandboxDestroyTimeoutMs());
        }
        const target = this.#getTarget();
        if (!target || target.sandboxGeneration !== expectedGeneration) {
          return;
        }
        try {
          await this.#destroyWithTimeout(sandboxId);
          this.ctx.storage.sql.exec(
            "UPDATE review_target SET sandbox_active = 0, sandbox_expires_at = NULL WHERE id = 1 AND sandbox_generation = ?",
            expectedGeneration,
          );
          console.info({
            event: "orchestrator.sandbox.destroyed",
            sandboxId,
            reason: "retry_succeeded",
          });
          return;
        } catch (error) {
          const retryCount = previousRetryCount + 1;
          console.error({
            event: "orchestrator.sandbox.destroy_failed",
            sandboxId,
            reason: "retry",
            retryCount,
            error: error instanceof Error ? error.message : String(error),
          });
          if (retryCount <= DESTROY_MAX_RETRIES) {
            const backoffMs = this.sandboxDestroyRetryBaseDelayMs() * 2 ** (retryCount - 1);
            await this.#scheduleCleanupJob(expectedGeneration, Date.now() + backoffMs, {
              pendingDestroy: true,
              retryCount,
            });
            return;
          }
          this.ctx.storage.sql.exec(
            "UPDATE review_target SET sandbox_active = 0, sandbox_expires_at = NULL WHERE id = 1 AND sandbox_generation = ?",
            expectedGeneration,
          );
          return;
        }
      } catch (error) {
        console.error({
          event: "orchestrator.sandbox.cleanup_error",
          sandboxId,
          reason: "retry",
          error: error instanceof Error ? error.message : String(error),
        });
        return { rescheduleAt: Date.now() + this.sandboxDestroyRetryBaseDelayMs() };
      }
    };

    const promise = run();
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    this.#inflightCleanup = tracked;
    void tracked.then(() => {
      if (this.#inflightCleanup === tracked) {
        this.#inflightCleanup = null;
      }
    });
    return promise;
  }

  #hasPendingDestroyJob(generation: number): boolean {
    const existingJob = this.lifecycle.jobs.get(SANDBOX_CLEANUP_JOB_ID);
    const existingPayload = parseCleanupJobPayload(existingJob?.payload);
    return existingPayload?.pendingDestroy === true && existingPayload.generation === generation;
  }

  async #destroyWithTimeout(sandboxId: string): Promise<void> {
    const timeoutMs = this.sandboxDestroyTimeoutMs();
    const destroyPromise = this.env.RUNNER.destroy(sandboxId);
    destroyPromise.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        destroyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`sandbox destroy RPC timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  #hasDelivery(deliveryId: string): boolean {
    const row = this.ctx.storage.sql
      .exec<{ delivery_id: string }>(
        "SELECT delivery_id FROM review_deliveries WHERE delivery_id = ?",
        deliveryId,
      )
      .toArray()[0];
    return row !== undefined;
  }

  #recordDelivery(deliveryId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO review_deliveries (delivery_id, created_at) VALUES (?, ?)",
      deliveryId,
      Date.now(),
    );
  }

  #getCheckoutToken(installationId: number, repositoryName: string): Promise<string> {
    return issueInstallationToken(
      {
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      },
      {
        repositories: [repositoryName],
        permissions: { contents: "read" },
      },
    );
  }

  #getRepoReadToken(installationId: number, repositoryName: string): Promise<string> {
    return issueInstallationToken(
      {
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      },
      {
        repositories: [repositoryName],
        permissions: { contents: "read", pull_requests: "read" },
      },
    );
  }

  #getChecksReadToken(installationId: number, repositoryName: string): Promise<string> {
    return issueInstallationToken(
      {
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      },
      {
        repositories: [repositoryName],
        permissions: { checks: "read", statuses: "read" },
      },
    );
  }

  #getWriteToken(installationId: number, repositoryName: string): Promise<string> {
    return issueInstallationToken(
      {
        appId: this.env.GITHUB_APP_ID,
        privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      },
      {
        repositories: [repositoryName],
        permissions: { pull_requests: "write" },
      },
    );
  }

  #isCurrentGeneration(generation: number): boolean {
    const target = this.#getTarget();
    return target !== null && target.currentGeneration === generation;
  }

  #saveTarget(
    request: ReviewRequest,
    generation: number,
    resolved: {
      readonly baseSha: string;
      readonly defaultBranch: string;
      readonly isFork: boolean;
      readonly executionMode: ExecutionMode;
      readonly staticOnlyReason: StaticOnlyReason | null;
    },
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO review_target (
         id, repository, pull_number, head_sha, base_sha, default_branch,
         is_fork, execution_mode, static_only_reason, current_generation,
         installation_id, checked_out_sha
       )
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         repository = excluded.repository,
         pull_number = excluded.pull_number,
         head_sha = excluded.head_sha,
         base_sha = excluded.base_sha,
         default_branch = excluded.default_branch,
         is_fork = excluded.is_fork,
         execution_mode = excluded.execution_mode,
         static_only_reason = excluded.static_only_reason,
         current_generation = excluded.current_generation,
         checked_out_sha = CASE
           WHEN review_target.head_sha != excluded.head_sha THEN NULL
           ELSE review_target.checked_out_sha
         END,
         installation_id = CASE
           WHEN excluded.installation_id != 0 THEN excluded.installation_id
           ELSE review_target.installation_id
         END`,
      request.repository,
      request.pullNumber,
      request.headSha,
      resolved.baseSha,
      resolved.defaultBranch,
      resolved.isFork ? 1 : 0,
      resolved.executionMode,
      resolved.staticOnlyReason,
      generation,
      request.installationId ?? 0,
    );
  }

  #upsertStep1Run(run: Omit<Step1RunState, "updatedAt">): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO step1_runs (
         delivery_id, generation, head_sha, base_sha, default_branch,
         is_fork, execution_mode, static_only_reason, stage,
         ci_wait_started_at, ci_wait_deadline_at, ci_grace_checked,
         early_reject_policy, required_test_checks_json, review_guidelines,
         test_report_json, early_reject_reason, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(delivery_id) DO UPDATE SET
         generation = excluded.generation,
         head_sha = excluded.head_sha,
         base_sha = excluded.base_sha,
         default_branch = excluded.default_branch,
         is_fork = excluded.is_fork,
         execution_mode = excluded.execution_mode,
         static_only_reason = excluded.static_only_reason,
         stage = excluded.stage,
         ci_wait_started_at = excluded.ci_wait_started_at,
         ci_wait_deadline_at = excluded.ci_wait_deadline_at,
         ci_grace_checked = excluded.ci_grace_checked,
         early_reject_policy = excluded.early_reject_policy,
         required_test_checks_json = excluded.required_test_checks_json,
         review_guidelines = excluded.review_guidelines,
         test_report_json = excluded.test_report_json,
         early_reject_reason = excluded.early_reject_reason,
         updated_at = excluded.updated_at`,
      run.deliveryId,
      run.generation,
      run.headSha,
      run.baseSha,
      run.defaultBranch,
      run.isFork ? 1 : 0,
      run.executionMode,
      run.staticOnlyReason,
      run.stage,
      run.ciWaitStartedAt,
      run.ciWaitDeadlineAt,
      run.ciGraceChecked ? 1 : 0,
      run.earlyRejectPolicy,
      JSON.stringify(run.requiredTestChecks),
      run.reviewGuidelines,
      run.testReport !== null ? JSON.stringify(run.testReport) : null,
      run.earlyRejectReason,
      Date.now(),
    );
    this.#notifyStep1Waiters(run.deliveryId);
  }

  #getStep1Run(deliveryId: string): Step1RunState | null {
    const row = this.ctx.storage.sql
      .exec<Step1RunRow>("SELECT * FROM step1_runs WHERE delivery_id = ?", deliveryId)
      .toArray()[0];
    return row ? mapStep1RunRow(row) : null;
  }

  #listAwaitingCiRuns(generation: number, headSha: string): Step1RunState[] {
    return this.ctx.storage.sql
      .exec<Step1RunRow>(
        `SELECT * FROM step1_runs
         WHERE stage = 'awaiting_ci' AND generation = ? AND head_sha = ?
         ORDER BY updated_at ASC`,
        generation,
        headSha,
      )
      .toArray()
      .map(mapStep1RunRow);
  }

  #getTarget(): ReviewTarget | null {
    const row = this.ctx.storage.sql
      .exec<{
        repository: string;
        pull_number: number;
        head_sha: string;
        base_sha: string | null;
        default_branch: string | null;
        is_fork: number;
        execution_mode: string;
        static_only_reason: string | null;
        current_generation: number;
        installation_id: number;
        checked_out_sha: string | null;
        test_commands_json: string;
        sandbox_active: number;
        sandbox_generation: number;
        sandbox_expires_at: number | null;
      }>(
        `SELECT repository, pull_number, head_sha, base_sha, default_branch,
                is_fork, execution_mode, static_only_reason, current_generation,
                installation_id, checked_out_sha, test_commands_json,
                sandbox_active, sandbox_generation, sandbox_expires_at
         FROM review_target WHERE id = 1`,
      )
      .toArray()[0];
    if (!row) {
      return null;
    }
    return {
      repository: row.repository,
      pullNumber: row.pull_number,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      defaultBranch: row.default_branch,
      isFork: row.is_fork === 1,
      executionMode: row.execution_mode === "static_only" ? "static_only" : "full",
      staticOnlyReason: parseStaticOnlyReason(row.static_only_reason),
      currentGeneration: row.current_generation,
      installationId: row.installation_id,
      checkedOutSha: row.checked_out_sha,
      testCommands: parseStringArray(row.test_commands_json),
      sandboxActive: row.sandbox_active === 1,
      sandboxGeneration: row.sandbox_generation,
      sandboxExpiresAt: row.sandbox_expires_at,
    };
  }

  #requireTarget(): ReviewTarget {
    const target = this.#getTarget();
    if (!target) {
      throw new Error("review target is not initialized; call start() first");
    }
    return target;
  }

  /** いま実行中のレビュー。ツールは実行中のレビューからしか呼ばれない。 */
  async #runningOperation(): Promise<string> {
    const running = (await this.harness.pending()).find((op) => op.status === "running");
    if (!running) {
      throw new Error("a finding was reported while no review is running");
    }
    return running.operationId;
  }
}

type Step1RunRow = {
  delivery_id: string;
  generation: number;
  head_sha: string;
  base_sha: string | null;
  default_branch: string | null;
  is_fork: number;
  execution_mode: string;
  static_only_reason: string | null;
  stage: string;
  ci_wait_started_at: number | null;
  ci_wait_deadline_at: number | null;
  ci_grace_checked: number;
  early_reject_policy: string;
  required_test_checks_json: string;
  review_guidelines: string | null;
  test_report_json: string | null;
  early_reject_reason: string | null;
  updated_at: number;
};

function mapStep1RunRow(row: Step1RunRow): Step1RunState {
  let testReport: TestExecutionReport | null = null;
  if (row.test_report_json !== null) {
    try {
      const parsed = testExecutionReportSchema.safeParse(JSON.parse(row.test_report_json));
      if (parsed.success) {
        testReport = parsed.data;
      }
    } catch {
      testReport = null;
    }
  }
  const policy: EarlyRejectPolicy =
    row.early_reject_policy === "never" || row.early_reject_policy === "strict"
      ? row.early_reject_policy
      : "on_test_failure";

  const parsedStage = runStageSchema.safeParse(row.stage);
  const stage: RunStage = parsedStage.success ? parsedStage.data : "failed";

  return {
    deliveryId: row.delivery_id,
    generation: row.generation,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    defaultBranch: row.default_branch,
    isFork: row.is_fork === 1,
    executionMode: row.execution_mode === "static_only" ? "static_only" : "full",
    staticOnlyReason: parseStaticOnlyReason(row.static_only_reason),
    stage,
    ciWaitStartedAt: row.ci_wait_started_at,
    ciWaitDeadlineAt: row.ci_wait_deadline_at,
    ciGraceChecked: row.ci_grace_checked === 1,
    earlyRejectPolicy: policy,
    requiredTestChecks: parseStringArray(row.required_test_checks_json),
    reviewGuidelines: row.review_guidelines,
    testReport,
    earlyRejectReason: row.early_reject_reason,
    updatedAt: row.updated_at,
  };
}

function parseStaticOnlyReason(raw: string | null): StaticOnlyReason | null {
  if (raw === "fork_pr" || raw === "ci_script_hazard" || raw === "policy") {
    return raw;
  }
  return null;
}

function buildReviewPrompt(
  request: ReviewRequest,
  testCommands: readonly string[],
  testReport: TestExecutionReport,
  reviewGuidelines: string | null,
): string {
  const lines = [
    `${request.repository} の Pull Request #${request.pullNumber}（head: ${request.headSha}）をレビューしてください。`,
  ];
  if (testCommands.length > 0) {
    lines.push(`テストコマンドの候補: ${testCommands.join(", ")}`);
  }
  lines.push(
    `Step 1 実行モード: ${testReport.executionMode}${testReport.staticOnlyReason ? ` (${testReport.staticOnlyReason})` : ""} / テスト判定: ${testReport.overallStatus} (source: ${testReport.source})`,
  );
  if (testReport.checks.length > 0) {
    const checkSummary = testReport.checks
      .slice(0, 15)
      .map((check) => `- [${check.kind}] ${check.name}: ${check.status}`)
      .join("\n");
    lines.push(`Step 1 チェック結果:\n${checkSummary}`);
  }
  if (reviewGuidelines !== null && reviewGuidelines.trim().length > 0) {
    lines.push(
      `リポジトリ規約（default_branch 由来 REVIEW.md）:\n${reviewGuidelines.slice(0, 4_000)}`,
    );
  }
  return lines.join("\n");
}

function parseStringArray(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

function extractRepositoryName(fullRepository: string): string {
  const slashIndex = fullRepository.indexOf("/");
  if (slashIndex === -1 || slashIndex === fullRepository.length - 1) {
    throw new Error(`invalid repository: ${fullRepository}`);
  }
  return fullRepository.slice(slashIndex + 1);
}

function parseCleanupJobPayload(raw: unknown): CleanupJobPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.generation !== "number" || !Number.isInteger(record.generation)) {
    return null;
  }
  return {
    generation: record.generation,
    ...(record.pendingDestroy === true ? { pendingDestroy: true } : {}),
    ...(typeof record.retryCount === "number" && Number.isInteger(record.retryCount)
      ? { retryCount: record.retryCount }
      : {}),
  };
}

function parseCiPollJobPayload(raw: unknown): CiPollJobPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.deliveryId !== "string" ||
    record.deliveryId.length === 0 ||
    typeof record.generation !== "number" ||
    !Number.isInteger(record.generation) ||
    typeof record.headSha !== "string" ||
    record.headSha.length === 0
  ) {
    return null;
  }
  return {
    deliveryId: record.deliveryId,
    generation: record.generation,
    headSha: record.headSha,
  };
}

function parseStep1ContinuePayload(raw: unknown): Step1ContinueJobPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.deliveryId !== "string" ||
    record.deliveryId.length === 0 ||
    typeof record.generation !== "number" ||
    !Number.isInteger(record.generation)
  ) {
    return null;
  }

  let completedReport: TestExecutionReport | undefined;
  if (record.completedReport !== undefined) {
    const parsedReport = testExecutionReportSchema.safeParse(record.completedReport);
    if (!parsedReport.success) {
      // 不正な completedReport を握りつぶしてフォールバック側へ誤遷移させない
      return null;
    }
    completedReport = parsedReport.data;
  }

  let ciChecks: TestCheckResult[] | undefined;
  if (record.ciChecks !== undefined) {
    if (!Array.isArray(record.ciChecks)) {
      return null;
    }
    ciChecks = [];
    for (const item of record.ciChecks) {
      const parsedItem = testCheckResultSchema.safeParse(item);
      if (!parsedItem.success) {
        return null;
      }
      ciChecks.push(parsedItem.data);
    }
  }

  return {
    deliveryId: record.deliveryId,
    generation: record.generation,
    ...(typeof record.fallbackReason === "string" ? { fallbackReason: record.fallbackReason } : {}),
    ...(ciChecks !== undefined ? { ciChecks } : {}),
    ...(completedReport !== undefined ? { completedReport } : {}),
  };
}

async function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function redactSecrets(input: string, secrets: readonly string[]): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length > 0) {
      output = output.replaceAll(secret, "[REDACTED]");
    }
  }
  return output;
}
