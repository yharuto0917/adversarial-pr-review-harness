import { z } from "zod";

/** 指摘の深刻度。収束判定や `@repo/eval` (`SEVERITY_ORDER`) のしきい値判定に使う。 */
export const severitySchema = z.enum(["blocker", "major", "minor", "nit"]);
export type Severity = z.infer<typeof severitySchema>;

/** 敵対的検証パイプラインのステートマシン状態（12 状態）。 */
export const RUN_STAGES = [
  "queued",
  "awaiting_ci",
  "testing",
  "primary_review",
  "adversarial_verification",
  "decision_adjudication",
  "synthesis_and_publish",
  "completed",
  "early_rejected",
  "awaiting_approval",
  "superseded",
  "failed",
] as const;
export const runStageSchema = z.enum(RUN_STAGES);
export type RunStage = z.infer<typeof runStageSchema>;

/** 終了状態として扱う `RunStage` 一覧。 */
export const TERMINAL_RUN_STAGES: readonly RunStage[] = [
  "completed",
  "early_rejected",
  "superseded",
  "failed",
];

const TERMINAL_RUN_STAGE_SET: ReadonlySet<RunStage> = new Set(TERMINAL_RUN_STAGES);

/** 指定した `RunStage` が終了状態かどうかを返す。 */
export function isTerminalRunStage(stage: RunStage): boolean {
  return TERMINAL_RUN_STAGE_SET.has(stage);
}

/** レビュー指摘の 4 区分。 */
export const FINDING_CATEGORIES = ["bug", "risk", "nit", "question"] as const;
export const findingCategorySchema = z.enum(FINDING_CATEGORIES);
export type FindingCategory = z.infer<typeof findingCategorySchema>;

/** `FindingCategory` ごとに許可される `Severity` の組み合わせ。 */
export const ALLOWED_SEVERITIES_BY_CATEGORY: Readonly<
  Record<FindingCategory, readonly Severity[]>
> = {
  bug: ["blocker", "major"],
  risk: ["major", "minor"],
  nit: ["nit"],
  question: ["nit"],
};

/** `(category, severity)` の組み合わせが有効かを判定する。 */
export function isValidCategorySeverity(category: FindingCategory, severity: Severity): boolean {
  return ALLOWED_SEVERITIES_BY_CATEGORY[category].includes(severity);
}

/**
 * 指摘がブロッキング（Approve 不可）かどうかを判定する。
 * `bug`（`blocker` / `major`）および重大 `risk`（`major`）のみブロッキングとなる。
 */
export function isBlockingFinding(finding: {
  readonly category: FindingCategory;
  readonly severity: Severity;
}): boolean {
  return (
    finding.category === "bug" || (finding.category === "risk" && finding.severity === "major")
  );
}

/** PR 全体の Code Health 判定。 */
export const CODE_HEALTH_VERDICTS = ["approve", "comment", "request_changes"] as const;
export const codeHealthVerdictSchema = z.enum(CODE_HEALTH_VERDICTS);
export type CodeHealthVerdict = z.infer<typeof codeHealthVerdictSchema>;

/** `yharuto-code-review` 準拠の 7 種 diff スメルルール ID。 */
export const SMELL_RULE_IDS = [
  "STRINGIFIED_CODE_OR_EVAL",
  "DUPLICATE_OR_OVERLAPPING_LISTENER",
  "MOCK_DEFENSIVE_GUARD",
  "TYPE_BYPASS_OR_SILENT_FALLBACK",
  "EMPTY_OR_BROAD_CATCH",
  "DEEP_NESTING_OR_COMPLEX_FLOW",
  "MISLEADING_OR_PASS_THROUGH",
] as const;
export const smellRuleIdSchema = z.enum(SMELL_RULE_IDS);
export type SmellRuleId = z.infer<typeof smellRuleIdSchema>;

function addCategorySeverityIssue(
  category: FindingCategory,
  severity: Severity,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (!isValidCategorySeverity(category, severity)) {
    const allowed = ALLOWED_SEVERITIES_BY_CATEGORY[category].join(", ");
    ctx.addIssue({
      code: "custom",
      path,
      message: `invalid category/severity combination: category "${category}" only allows severity [${allowed}], got "${severity}"`,
    });
  }
}

function addLineRangeIssue(
  line: number | null | undefined,
  endLine: number | null | undefined,
  ctx: z.RefinementCtx,
): void {
  if (endLine === undefined || endLine === null) {
    return;
  }
  if (line === undefined || line === null) {
    ctx.addIssue({
      code: "custom",
      path: ["endLine"],
      message: "endLine cannot be set when line is null or omitted",
    });
    return;
  }
  if (endLine < line) {
    ctx.addIssue({
      code: "custom",
      path: ["endLine"],
      message: `endLine (${endLine}) must be greater than or equal to line (${line})`,
    });
  }
}

/** 既存 `Finding` と `FinalFinding` で共有する基本フィールド。 */
const baseFindingFields = {
  fingerprint: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  severity: severitySchema,
  title: z.string().min(1),
  body: z.string(),
  symbol: z.string().min(1).nullable().optional(),
  evidenceSummary: z.array(z.string().min(1)).optional(),
};

/** レビュー 1 件の指摘。fingerprint で世代をまたいだ同一性を判定する。 */
export const findingSchema = z
  .object({
    ...baseFindingFields,
    category: findingCategorySchema.optional(),
    inChangedLines: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.category !== undefined) {
      addCategorySeverityIssue(data.category, data.severity, ctx, ["severity"]);
    }
  });
export type Finding = z.infer<typeof findingSchema>;

/** 1 イテレーション分のレビュー実行結果。 */
export const reviewRunSchema = z.object({
  runId: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  headSha: z.string().min(1),
  findings: z.array(findingSchema),
  stage: runStageSchema.optional(),
  costUsd: z.number().finite().nonnegative().optional(),
  codeHealth: codeHealthVerdictSchema.optional(),
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;

/** ループを継続するか打ち切るかの判定結果。 */
export const verdictSchema = z.object({
  status: z.enum(["converged", "continue", "oscillating", "budget_exhausted"]),
  reason: z.string(),
});
export type Verdict = z.infer<typeof verdictSchema>;

/** ハーネスによるコマンド再現検証の刻印結果。 */
export const HARNESS_VERIFICATIONS = [
  "confirmed",
  "contradicted",
  "unsafe_command",
  "timed_out",
  "not_applicable",
] as const;
export const harnessVerificationSchema = z.enum(HARNESS_VERIFICATIONS);
export type HarnessVerification = z.infer<typeof harnessVerificationSchema>;

/** 証拠の種別。 */
export const EVIDENCE_KINDS = [
  "code_reference",
  "command_output",
  "ci_check",
  "test_reproduction",
  "diff_smell",
  "comparative_code",
] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/** 指摘・反証を裏付ける証拠 1 件。 */
export const evidenceSchema = z
  .object({
    kind: evidenceKindSchema,
    summary: z.string().trim().min(1),
    path: z.string().trim().min(1).optional(),
    line: z.number().int().positive().nullable().optional(),
    endLine: z.number().int().positive().nullable().optional(),
    excerpt: z.string().optional(),
    command: z.string().trim().min(1).optional(),
    exitCode: z.number().int().nullable().optional(),
    commandOutput: z.string().optional(),
    harnessVerification: harnessVerificationSchema,
  })
  .superRefine((data, ctx) => {
    addLineRangeIssue(data.line, data.endLine, ctx);
    if (
      (data.kind === "command_output" || data.kind === "test_reproduction") &&
      data.command === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: `command is required when evidence kind is "${data.kind}"`,
      });
    }
    if (
      (data.kind === "code_reference" ||
        data.kind === "diff_smell" ||
        data.kind === "comparative_code") &&
      data.path === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: `path is required when evidence kind is "${data.kind}"`,
      });
    }
  });
export type Evidence = z.infer<typeof evidenceSchema>;

/** Step 1〜3 の実行モード。外部フォーク PR やスクリプト改ざん時は `static_only` を強制する。 */
export const EXECUTION_MODES = ["full", "static_only"] as const;
export const executionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

/** `static_only` 強制の理由。 */
export const STATIC_ONLY_REASONS = ["fork_pr", "ci_script_hazard", "policy"] as const;
export const staticOnlyReasonSchema = z.enum(STATIC_ONLY_REASONS);
export type StaticOnlyReason = z.infer<typeof staticOnlyReasonSchema>;

/** Step 1 個別チェックの種別。 */
export const TEST_CHECK_KINDS = ["test", "typecheck", "build", "lint", "other"] as const;
export const testCheckKindSchema = z.enum(TEST_CHECK_KINDS);
export type TestCheckKind = z.infer<typeof testCheckKindSchema>;

/** Step 1 個別チェックの取得元。 */
export const TEST_CHECK_SOURCES = ["ci", "sandbox", "static"] as const;
export const testCheckSourceSchema = z.enum(TEST_CHECK_SOURCES);
export type TestCheckSource = z.infer<typeof testCheckSourceSchema>;

/** Step 1 個別チェックの状態。 */
export const TEST_CHECK_STATUSES = [
  "passed",
  "failed",
  "failed_preexisting",
  "pending",
  "timed_out",
  "skipped",
  "not_configured",
  "env_unavailable",
] as const;
export const testCheckStatusSchema = z.enum(TEST_CHECK_STATUSES);
export type TestCheckStatus = z.infer<typeof testCheckStatusSchema>;

/** Step 1 個別チェック結果。 */
export const testCheckResultSchema = z.object({
  name: z.string().trim().min(1),
  kind: testCheckKindSchema,
  source: testCheckSourceSchema,
  status: testCheckStatusSchema,
  command: z.string().trim().min(1).optional(),
  exitCode: z.number().int().nullable().optional(),
  summary: z.string().optional(),
  failedTests: z.array(z.string().min(1)).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
});
export type TestCheckResult = z.infer<typeof testCheckResultSchema>;

/** Step 1 レポートの取得元区分。 */
export const TEST_REPORT_SOURCES = ["ci", "sandbox", "mixed", "static_only"] as const;
export const testReportSourceSchema = z.enum(TEST_REPORT_SOURCES);
export type TestReportSource = z.infer<typeof testReportSourceSchema>;

/** Step 1 レポート全体の総合状態。 */
export const TEST_REPORT_OVERALL_STATUSES = [
  "passed",
  "failed",
  "failed_preexisting",
  "pending",
  "timed_out",
  "skipped",
  "static_only",
] as const;
export const testReportOverallStatusSchema = z.enum(TEST_REPORT_OVERALL_STATUSES);
export type TestReportOverallStatus = z.infer<typeof testReportOverallStatusSchema>;

/** Step 1 のテスト実施・CI 読取結果レポート。 */
export const testExecutionReportSchema = z
  .object({
    headSha: z.string().trim().min(1),
    baseSha: z.string().trim().min(1).optional(),
    executionMode: executionModeSchema,
    staticOnlyReason: staticOnlyReasonSchema.optional(),
    source: testReportSourceSchema,
    overallStatus: testReportOverallStatusSchema,
    hasRegressionFailure: z.boolean(),
    shouldEarlyReject: z.boolean(),
    earlyRejectReason: z.string().trim().min(1).optional(),
    checks: z.array(testCheckResultSchema),
    evaluatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.executionMode === "static_only") {
      if (data.staticOnlyReason === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["staticOnlyReason"],
          message: 'staticOnlyReason is required when executionMode is "static_only"',
        });
      }
      if (data.source === "sandbox" || data.source === "mixed") {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: `source "${data.source}" is prohibited when executionMode is "static_only"`,
        });
      }
      for (let i = 0; i < data.checks.length; i += 1) {
        if (data.checks[i]?.source === "sandbox") {
          ctx.addIssue({
            code: "custom",
            path: ["checks", i, "source"],
            message: 'sandbox check results are prohibited when executionMode is "static_only"',
          });
        }
      }
      if (data.source === "static_only" && data.overallStatus === "passed") {
        ctx.addIssue({
          code: "custom",
          path: ["overallStatus"],
          message: 'overallStatus cannot be "passed" when source is "static_only"',
        });
      }
    } else {
      if (data.staticOnlyReason !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["staticOnlyReason"],
          message: 'staticOnlyReason is only allowed when executionMode is "static_only"',
        });
      }
      if (data.source === "static_only") {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: 'source cannot be "static_only" when executionMode is "full"',
        });
      }
      if (data.overallStatus === "static_only") {
        ctx.addIssue({
          code: "custom",
          path: ["overallStatus"],
          message: 'overallStatus cannot be "static_only" when executionMode is "full"',
        });
      }
    }

    if (data.shouldEarlyReject && data.earlyRejectReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["earlyRejectReason"],
        message: "earlyRejectReason is required when shouldEarlyReject is true",
      });
    }
    if (!data.shouldEarlyReject && data.earlyRejectReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["earlyRejectReason"],
        message: "earlyRejectReason must be omitted when shouldEarlyReject is false",
      });
    }
  });
export type TestExecutionReport = z.infer<typeof testExecutionReportSchema>;

/** Step 2 Main Agent が作成するドラフト指摘候補。 */
export const draftFindingSchema = z
  .object({
    draftId: z.string().trim().min(1),
    path: z.string().trim().min(1),
    line: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable().optional(),
    symbol: z.string().trim().min(1).nullable().optional(),
    category: findingCategorySchema,
    severity: severitySchema,
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    remedy: z.string().trim().min(1).optional(),
    inChangedLines: z.boolean(),
    evidence: z.array(evidenceSchema),
    smellRuleId: smellRuleIdSchema.optional(),
    authorModel: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    addCategorySeverityIssue(data.category, data.severity, ctx, ["severity"]);
    addLineRangeIssue(data.line, data.endLine, ctx);
  });
export type DraftFinding = z.infer<typeof draftFindingSchema>;

/** Step 3 敵対的検証における各ドラフト候補への判定。 */
export const CHALLENGED_VERDICTS = ["keep", "dismiss", "revise"] as const;
export const challengedVerdictSchema = z.enum(CHALLENGED_VERDICTS);
export type ChallengedVerdict = z.infer<typeof challengedVerdictSchema>;

/** Step 3 課題 A: 既存ドラフト候補 1 件に対する反証結果。 */
export const challengedFindingSchema = z
  .object({
    draftId: z.string().trim().min(1),
    verdict: challengedVerdictSchema,
    reason: z.string().trim().min(10),
    evidence: z.array(evidenceSchema),
    revisedCategory: findingCategorySchema.optional(),
    revisedSeverity: severitySchema.optional(),
    revisedTitle: z.string().trim().min(1).optional(),
    revisedBody: z.string().trim().min(1).optional(),
    revisedRemedy: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const hasRevisedField =
      data.revisedCategory !== undefined ||
      data.revisedSeverity !== undefined ||
      data.revisedTitle !== undefined ||
      data.revisedBody !== undefined ||
      data.revisedRemedy !== undefined;

    if (data.verdict !== "revise") {
      if (hasRevisedField) {
        ctx.addIssue({
          code: "custom",
          path: ["verdict"],
          message: `revised* fields are only allowed when verdict is "revise", got "${data.verdict}"`,
        });
      }
      return;
    }

    if (!hasRevisedField) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: 'verdict "revise" requires at least one revised* field',
      });
    }

    if (
      (data.revisedCategory !== undefined && data.revisedSeverity === undefined) ||
      (data.revisedCategory === undefined && data.revisedSeverity !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: data.revisedSeverity === undefined ? ["revisedSeverity"] : ["revisedCategory"],
        message: "revisedCategory and revisedSeverity must be provided together",
      });
      return;
    }

    if (data.revisedCategory !== undefined && data.revisedSeverity !== undefined) {
      addCategorySeverityIssue(data.revisedCategory, data.revisedSeverity, ctx, [
        "revisedSeverity",
      ]);
    }
  });
export type ChallengedFinding = z.infer<typeof challengedFindingSchema>;

/** Step 3 課題 B: Negative Space 監査で検出した新規見落とし候補。 */
export const missedFindingSchema = z
  .object({
    missedId: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1),
    line: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable().optional(),
    symbol: z.string().trim().min(1).nullable().optional(),
    category: findingCategorySchema,
    severity: severitySchema,
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    remedy: z.string().trim().min(1).optional(),
    inChangedLines: z.boolean(),
    evidence: z.array(evidenceSchema),
  })
  .superRefine((data, ctx) => {
    addCategorySeverityIssue(data.category, data.severity, ctx, ["severity"]);
    addLineRangeIssue(data.line, data.endLine, ctx);
  });
export type MissedFinding = z.infer<typeof missedFindingSchema>;

/**
 * Step 3 敵対的検証 Agent 1 体分の出力契約。
 * セッション紐付けは DO 側の `api.conversationId` で担保するため `challengeNonce` は廃止している。
 */
export const adversarialVerdictSchema = z
  .object({
    conversationId: z.string().trim().min(1),
    verifierModel: z.string().trim().min(1),
    challengedFindings: z.array(challengedFindingSchema),
    missedFindings: z.array(missedFindingSchema),
    checkedFiles: z.array(z.string().trim().min(1)),
    auditNotes: z.string().trim().min(20),
  })
  .superRefine((data, ctx) => {
    const seenDraftIds = new Set<string>();
    for (let i = 0; i < data.challengedFindings.length; i += 1) {
      const draftId = data.challengedFindings[i]?.draftId;
      if (draftId === undefined) {
        continue;
      }
      if (seenDraftIds.has(draftId)) {
        ctx.addIssue({
          code: "custom",
          path: ["challengedFindings", i, "draftId"],
          message: `duplicate draftId in challengedFindings: "${draftId}"`,
        });
      }
      seenDraftIds.add(draftId);
    }
  });
export type AdversarialVerdict = z.infer<typeof adversarialVerdictSchema>;

/** Step 4 精査エンジンの種別。 */
export const ADJUDICATION_ENGINES = [
  "gemini_decision_1",
  "fallback_llm_judge",
  "majority_vote",
  "deterministic_only",
] as const;
export const adjudicationEngineSchema = z.enum(ADJUDICATION_ENGINES);
export type AdjudicationEngine = z.infer<typeof adjudicationEngineSchema>;

/** Step 4 各候補裁定の決定元。 */
export const ADJUDICATION_SOURCES = [
  "deterministic_rule",
  "gemini_decision_1",
  "fallback_llm_judge",
  "majority_vote",
] as const;
export const adjudicationSourceSchema = z.enum(ADJUDICATION_SOURCES);
export type AdjudicationSource = z.infer<typeof adjudicationSourceSchema>;

/** Step 4 棄却理由の標準分類。 */
export const DISMISS_REASONS = [
  "repro_contradicted",
  "out_of_scope_meta",
  "upstream_guarded",
  "unreachable_data",
  "false_premise",
  "framework_guaranteed",
  "invariant_violation",
  "low_confidence",
  "majority_vote_rejected",
  "other",
] as const;
export const dismissReasonSchema = z.enum(DISMISS_REASONS);
export type DismissReason = z.infer<typeof dismissReasonSchema>;

/** Layer 1 決定論的ハードルール ID（例: `D-01`, `D-02`, `D-03`）。 */
export const deterministicRuleIdSchema = z.string().regex(/^D-\d{2,}$/);
export type DeterministicRuleId = z.infer<typeof deterministicRuleIdSchema>;

/** Decision 1 / フォールバック精査のトークン使用量。 */
export const decisionUsageSchema = z.object({
  totalInputTokens: z.number().int().nonnegative(),
  batchCount: z.number().int().nonnegative().optional(),
});
export type DecisionUsage = z.infer<typeof decisionUsageSchema>;

const candidateAdjudicationCommonFields = {
  draftId: z.string().trim().min(1),
  decidedBy: adjudicationSourceSchema,
  ruleId: deterministicRuleIdSchema.optional(),
  validProbability: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().trim().min(1),
};

const candidateAdjudicationAcceptedFields = {
  finalCategory: findingCategorySchema,
  finalSeverity: severitySchema,
  finalTitle: z.string().trim().min(1).optional(),
  finalBody: z.string().trim().min(1).optional(),
  finalRemedy: z.string().trim().min(1).optional(),
};

/** Step 4 候補 1 件に対する裁定結果。 */
export const candidateAdjudicationSchema = z
  .discriminatedUnion("decision", [
    z.object({
      ...candidateAdjudicationCommonFields,
      decision: z.literal("dismiss"),
      dismissReason: dismissReasonSchema,
    }),
    z.object({
      ...candidateAdjudicationCommonFields,
      ...candidateAdjudicationAcceptedFields,
      decision: z.literal("accept"),
    }),
    z.object({
      ...candidateAdjudicationCommonFields,
      ...candidateAdjudicationAcceptedFields,
      decision: z.literal("revise"),
    }),
    z.object({
      ...candidateAdjudicationCommonFields,
      ...candidateAdjudicationAcceptedFields,
      decision: z.literal("needs_recheck"),
    }),
  ])
  .superRefine((data, ctx) => {
    if (data.decidedBy === "deterministic_rule" && data.ruleId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ruleId"],
        message: 'ruleId is required when decidedBy is "deterministic_rule"',
      });
    }
    if (data.decidedBy !== "deterministic_rule" && data.ruleId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ruleId"],
        message: 'ruleId is only allowed when decidedBy is "deterministic_rule"',
      });
    }
    if (data.decision !== "dismiss") {
      addCategorySeverityIssue(data.finalCategory, data.finalSeverity, ctx, ["finalSeverity"]);
    }
  });
export type CandidateAdjudication = z.infer<typeof candidateAdjudicationSchema>;

/** Step 4 2 層精査エンジン（決定論的ルール ＋ Decision 1）の全体結果。 */
export const adjudicationResultSchema = z
  .object({
    decisions: z.array(candidateAdjudicationSchema),
    codeHealth: codeHealthVerdictSchema,
    engine: adjudicationEngineSchema,
    usage: decisionUsageSchema,
    degradedReason: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const seenDraftIds = new Set<string>();
    for (let i = 0; i < data.decisions.length; i += 1) {
      const draftId = data.decisions[i]?.draftId;
      if (draftId === undefined) {
        continue;
      }
      if (seenDraftIds.has(draftId)) {
        ctx.addIssue({
          code: "custom",
          path: ["decisions", i, "draftId"],
          message: `duplicate draftId in decisions: "${draftId}"`,
        });
      }
      seenDraftIds.add(draftId);
    }
  });
export type AdjudicationResult = z.infer<typeof adjudicationResultSchema>;

/** Step 4〜5 を通過した最終確定指摘。既存 `Finding` との構造互換を保つ。 */
export const finalFindingSchema = z
  .object({
    ...baseFindingFields,
    fingerprint: z.string().trim().min(1),
    path: z.string().trim().min(1),
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    symbol: z.string().trim().min(1).nullable().optional(),
    evidenceSummary: z.array(z.string().trim().min(1)).optional(),
    endLine: z.number().int().positive().nullable().optional(),
    category: findingCategorySchema,
    inChangedLines: z.boolean(),
    remedy: z.string().trim().min(1).optional(),
    evidence: z.array(evidenceSchema).min(1),
    sourceDraftIds: z.array(z.string().trim().min(1)).optional(),
  })
  .superRefine((data, ctx) => {
    addCategorySeverityIssue(data.category, data.severity, ctx, ["severity"]);
    addLineRangeIssue(data.line, data.endLine, ctx);
    if ((data.category === "nit" || data.category === "question") && !data.inChangedLines) {
      ctx.addIssue({
        code: "custom",
        path: ["inChangedLines"],
        message: `category "${data.category}" is restricted to changed lines (inChangedLines must be true)`,
      });
    }
  });
export type FinalFinding = z.infer<typeof finalFindingSchema>;
