import { z } from "zod";

/** 変更起因テスト失敗時の早期差し戻しポリシー。 */
export const EARLY_REJECT_POLICIES = ["on_test_failure", "never", "strict"] as const;
export const earlyRejectPolicySchema = z.enum(EARLY_REJECT_POLICIES);
export type EarlyRejectPolicy = z.infer<typeof earlyRejectPolicySchema>;

/** GitHub レビュー投稿時のイベント種別。 */
export const POST_EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;
export const postEventSchema = z.enum(POST_EVENTS);
export type PostEvent = z.infer<typeof postEventSchema>;

/** 敵対的検証 Agent のハード上限（体数）。 */
export const HARD_MAX_VERIFIERS = 5;

/** 敵対的検証 Agent の同時実行ハード上限。 */
export const HARD_MAX_CONCURRENT_VERIFIERS = 5;

/** PR 更新跨ぎイテレーション数のハード上限。 */
export const HARD_MAX_ITERATIONS = 20;

/** `requiredTestChecks` 配列のハード上限件数。 */
export const HARD_MAX_REQUIRED_TEST_CHECKS = 50;

/** 既定の Main Agent モデル。 */
export const DEFAULT_MAIN_MODEL = "google/gemini-4-neon";

/** 既定の敵対的検証モデル群（Main と別プロバイダ 2 体）。 */
export const DEFAULT_VERIFIER_MODELS = [
  "openai/gpt-6.2-sol",
  "anthropic/claude-sonnet-5.5",
] as const;

export const DEFAULT_EARLY_REJECT_POLICY: EarlyRejectPolicy = "on_test_failure";
export const DEFAULT_MAX_CONCURRENT_VERIFIERS = 2;
export const DEFAULT_POST_EVENT: PostEvent = "COMMENT";
export const DEFAULT_MAX_ITERATIONS = 5;
export const DEFAULT_BUDGET_USD = 5;

const MAX_MODEL_REF_LENGTH = 200;
const MAX_CHECK_NAME_LENGTH = 200;
const AGGREGATOR_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "opencode"]);

function hasWhitespaceOrControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || /\s/.test(value[i] ?? "")) {
      return true;
    }
  }
  return false;
}

/** `<provider>/<model-id>` 形式として有効かを検証する。 */
export function isValidModelRef(value: string): boolean {
  if (value.length < 3 || value.length > MAX_MODEL_REF_LENGTH) {
    return false;
  }
  if (hasWhitespaceOrControlChar(value)) {
    return false;
  }
  if (value.includes("..") || value.includes("//") || value.endsWith("/")) {
    return false;
  }
  const slashIndex = value.indexOf("/");
  return slashIndex > 0 && slashIndex < value.length - 1;
}

/** `<provider>/<model-id>` 形式のモデル参照スキーマ。 */
export const modelRefSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (!isValidModelRef(value)) {
      ctx.addIssue({
        code: "custom",
        message: `model must be valid "<provider>/<model id>" without whitespace or control chars: "${value}"`,
      });
    }
  });
export type ModelRefString = z.infer<typeof modelRefSchema>;

/** `<provider>/<model-id>` から先頭のプロバイダ名を取り出す（小文字正規化）。不正形式は例外を送出する。 */
export function extractModelProvider(modelRef: string): string {
  const trimmed = modelRef.trim();
  if (!isValidModelRef(trimmed)) {
    throw new Error(`model must be "<provider>/<model id>": ${modelRef}`);
  }
  return trimmed.slice(0, trimmed.indexOf("/")).toLowerCase();
}

/**
 * アグリゲータプロバイダ（`openrouter/<vendor>/<model>` 等）を考慮して実ベンダーを抽出する（小文字正規化）。
 * `openrouter/google/gemini-4-neon` や `OpenRouter/Google/...` を `google` として扱い、同一ベンダー制約迂回を防ぐ。
 */
export function extractEffectiveVendor(modelRef: string): string {
  const trimmed = modelRef.trim();
  const provider = extractModelProvider(trimmed);
  if (!AGGREGATOR_PROVIDERS.has(provider)) {
    return provider;
  }
  const modelId = trimmed.slice(provider.length + 1);
  const nestedSlash = modelId.indexOf("/");
  if (nestedSlash > 0) {
    return modelId.slice(0, nestedSlash).toLowerCase();
  }
  return provider;
}

/** 重複・自己検証判定用の正規化キー（大小文字違いでのバイパスを防ぐ）。 */
function normalizeModelIdentity(modelRef: string): string {
  return modelRef.trim().toLowerCase();
}

export interface DuplicateVendorGroup {
  readonly vendor: string;
  readonly models: readonly string[];
}

export interface ProviderDiversityAnalysis {
  readonly mainVendor: string;
  readonly hasCrossProviderVerifier: boolean;
  readonly sameVendorAsMainModels: readonly string[];
  readonly duplicateVendorGroups: readonly DuplicateVendorGroup[];
  readonly warnings: readonly string[];
}

/** Main モデルと Verifier モデル群のプロバイダ／実ベンダー多様性を診断する。 */
export function analyzeProviderDiversity(
  mainModel: string,
  verifierModels: readonly string[],
): ProviderDiversityAnalysis {
  const mainVendor = extractEffectiveVendor(mainModel);
  const sameVendorAsMainModels: string[] = [];
  const modelsByVendor = new Map<string, string[]>();

  for (const model of verifierModels) {
    const vendor = extractEffectiveVendor(model);
    if (vendor === mainVendor) {
      sameVendorAsMainModels.push(model);
    }
    const group = modelsByVendor.get(vendor);
    if (group !== undefined) {
      group.push(model);
    } else {
      modelsByVendor.set(vendor, [model]);
    }
  }

  const hasCrossProviderVerifier = verifierModels.some(
    (model) => extractEffectiveVendor(model) !== mainVendor,
  );
  const duplicateVendorGroups: DuplicateVendorGroup[] = [];
  for (const [vendor, models] of modelsByVendor) {
    if (models.length > 1) {
      duplicateVendorGroups.push({ vendor, models });
    }
  }

  const warnings: string[] = [];
  if (!hasCrossProviderVerifier) {
    warnings.push(
      `all verifierModels share the same vendor "${mainVendor}" as mainModel "${mainModel}"`,
    );
  } else if (sameVendorAsMainModels.length > 0) {
    warnings.push(
      `verifierModels includes model(s) from the same vendor "${mainVendor}" as mainModel: ${sameVendorAsMainModels.join(", ")}`,
    );
  }
  for (const group of duplicateVendorGroups) {
    warnings.push(
      `multiple verifierModels share the same vendor "${group.vendor}": ${group.models.join(", ")}`,
    );
  }

  return {
    mainVendor,
    hasCrossProviderVerifier,
    sameVendorAsMainModels,
    duplicateVendorGroups,
    warnings,
  };
}

const repoReviewConfigBaseShape = {
  earlyRejectPolicy: earlyRejectPolicySchema,
  mainModel: modelRefSchema,
  verifierModels: z.array(modelRefSchema).min(1).max(HARD_MAX_VERIFIERS),
  maxConcurrentVerifiers: z.number().int().min(1).max(HARD_MAX_CONCURRENT_VERIFIERS),
  postEvent: postEventSchema,
  requiredTestChecks: z
    .array(z.string().trim().min(1).max(MAX_CHECK_NAME_LENGTH))
    .max(HARD_MAX_REQUIRED_TEST_CHECKS),
  maxIterations: z.number().int().min(1).max(HARD_MAX_ITERATIONS),
  budgetUsd: z.number().finite().positive(),
};

/** リポジトリ単位のレビュー設定（確定スキーマ）。 */
export const repoReviewConfigSchema = z
  .object(repoReviewConfigBaseShape)
  .superRefine((data, ctx) => {
    const mainIdentity = normalizeModelIdentity(data.mainModel);
    const seenModels = new Set<string>();
    for (let i = 0; i < data.verifierModels.length; i += 1) {
      const model = data.verifierModels[i];
      if (model === undefined) {
        continue;
      }
      const identity = normalizeModelIdentity(model);
      if (seenModels.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: ["verifierModels", i],
          message: `duplicate model in verifierModels: "${model}"`,
        });
      }
      seenModels.add(identity);

      if (identity === mainIdentity) {
        ctx.addIssue({
          code: "custom",
          path: ["verifierModels", i],
          message: `verifierModels must not contain mainModel "${data.mainModel}"`,
        });
      }
    }

    const diversity = analyzeProviderDiversity(data.mainModel, data.verifierModels);
    if (!diversity.hasCrossProviderVerifier) {
      ctx.addIssue({
        code: "custom",
        path: ["verifierModels"],
        message: `verifierModels must include at least one model from a different provider/vendor than mainModel "${data.mainModel}" (vendor: "${diversity.mainVendor}")`,
      });
    }

    const seenChecks = new Set<string>();
    for (let i = 0; i < data.requiredTestChecks.length; i += 1) {
      const check = data.requiredTestChecks[i];
      if (check === undefined) {
        continue;
      }
      if (seenChecks.has(check)) {
        ctx.addIssue({
          code: "custom",
          path: ["requiredTestChecks", i],
          message: `duplicate requiredTestChecks entry: "${check}"`,
        });
      }
      seenChecks.add(check);
    }
  });
export type RepoReviewConfig = z.infer<typeof repoReviewConfigSchema>;

/** 厳格な別プロバイダ制約（Main と同ベンダーの混在および Verifier 相互間の重複も拒否）を検証する。 */
export function validateStrictProviderDiversity(config: {
  readonly mainModel: string;
  readonly verifierModels: readonly string[];
}): { readonly valid: boolean; readonly errors: readonly string[] } {
  const diversity = analyzeProviderDiversity(config.mainModel, config.verifierModels);
  return {
    valid: diversity.warnings.length === 0,
    errors: diversity.warnings,
  };
}

/** リポジトリ単位設定の既定値。 */
export const DEFAULT_REPO_REVIEW_CONFIG: RepoReviewConfig = {
  earlyRejectPolicy: DEFAULT_EARLY_REJECT_POLICY,
  mainModel: DEFAULT_MAIN_MODEL,
  verifierModels: [...DEFAULT_VERIFIER_MODELS],
  maxConcurrentVerifiers: DEFAULT_MAX_CONCURRENT_VERIFIERS,
  postEvent: DEFAULT_POST_EVENT,
  requiredTestChecks: [],
  maxIterations: DEFAULT_MAX_ITERATIONS,
  budgetUsd: DEFAULT_BUDGET_USD,
};

/**
 * リポジトリ内宣言ファイル（`default_branch` 由来）の部分スキーマ。
 * 課金・回数・体数上限を超える正値はクランプ対象として受理し、`.default()` や `superRefine` を持たない。
 */
export const repoDeclaredReviewConfigSchema = z.object({
  earlyRejectPolicy: earlyRejectPolicySchema.optional(),
  mainModel: modelRefSchema.optional(),
  verifierModels: z.array(modelRefSchema).optional(),
  maxConcurrentVerifiers: z.number().int().min(1).optional(),
  postEvent: postEventSchema.optional(),
  requiredTestChecks: z.array(z.string().trim().min(1).max(MAX_CHECK_NAME_LENGTH)).optional(),
  maxIterations: z.number().int().min(1).optional(),
  budgetUsd: z.number().finite().positive().optional(),
});
export type RepoDeclaredReviewConfig = z.infer<typeof repoDeclaredReviewConfigSchema>;

/** `exactOptionalPropertyTypes: true` 互換の部分設定型。 */
export type PartialRepoReviewConfig = {
  readonly [K in keyof RepoReviewConfig]?: RepoReviewConfig[K] | undefined;
};

/** 管理ストア側の強制クランプ・権限ポリシー。 */
export interface AdminReviewConfigPolicy {
  /** リポジトリ宣言による `mainModel` / `verifierModels` 上書きを許可するか（既定: `false`）。 */
  readonly allowRepoModelOverride?: boolean | undefined;
  /** リポジトリ宣言による `postEvent` 上書きを許可するか（既定: `false`）。 */
  readonly allowRepoPostEventOverride?: boolean | undefined;
  /** 許可モデル完全一致リスト。`undefined` = 制限なし、`[]` = 全拒否（fail-closed）。 */
  readonly allowedModels?: readonly string[] | undefined;
  /** 許可プロバイダ／実ベンダー一覧。`undefined` = 制限なし、`[]` = 全拒否（fail-closed）。 */
  readonly allowedProviders?: readonly string[] | undefined;
  /** `budgetUsd` の強制上限。未指定時は管理ストア設定の `budgetUsd`。 */
  readonly maxBudgetUsd?: number | undefined;
  /** `maxIterations` の強制上限（1〜20）。未指定時は管理ストア設定の `maxIterations`。 */
  readonly maxIterationsCap?: number | undefined;
  /** `verifierModels` 体数の強制上限（1〜5）。未指定時は `HARD_MAX_VERIFIERS` (5)。 */
  readonly maxVerifiersCap?: number | undefined;
  /** `maxConcurrentVerifiers` の強制上限（1〜5）。未指定時は管理ストア設定の `maxConcurrentVerifiers`。 */
  readonly maxConcurrentVerifiersCap?: number | undefined;
}

export interface ClampedConfigField {
  readonly field: keyof RepoReviewConfig;
  readonly declared: unknown;
  readonly applied: unknown;
  readonly reason: string;
}

export interface MergeRepoReviewConfigResult {
  readonly config: RepoReviewConfig;
  readonly clampedFields: readonly ClampedConfigField[];
  readonly warnings: readonly string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePolicy(policy: AdminReviewConfigPolicy | undefined): {
  readonly allowRepoModelOverride: boolean;
  readonly allowRepoPostEventOverride: boolean;
  readonly allowedModels: ReadonlySet<string> | undefined;
  readonly allowedProviders: ReadonlySet<string> | undefined;
  readonly maxBudgetUsd: number | undefined;
  readonly maxIterationsCap: number | undefined;
  readonly maxVerifiersCap: number;
  readonly maxConcurrentVerifiersCap: number | undefined;
} {
  if (policy === undefined) {
    return {
      allowRepoModelOverride: false,
      allowRepoPostEventOverride: false,
      allowedModels: undefined,
      allowedProviders: undefined,
      maxBudgetUsd: undefined,
      maxIterationsCap: undefined,
      maxVerifiersCap: HARD_MAX_VERIFIERS,
      maxConcurrentVerifiersCap: undefined,
    };
  }

  if (
    policy.maxBudgetUsd !== undefined &&
    (!Number.isFinite(policy.maxBudgetUsd) || policy.maxBudgetUsd <= 0)
  ) {
    throw new Error(`policy.maxBudgetUsd must be a positive finite number: ${policy.maxBudgetUsd}`);
  }
  if (
    policy.maxIterationsCap !== undefined &&
    (!Number.isInteger(policy.maxIterationsCap) ||
      policy.maxIterationsCap < 1 ||
      policy.maxIterationsCap > HARD_MAX_ITERATIONS)
  ) {
    throw new Error(
      `policy.maxIterationsCap must be an integer between 1 and ${HARD_MAX_ITERATIONS}: ${policy.maxIterationsCap}`,
    );
  }
  if (
    policy.maxVerifiersCap !== undefined &&
    (!Number.isInteger(policy.maxVerifiersCap) ||
      policy.maxVerifiersCap < 1 ||
      policy.maxVerifiersCap > HARD_MAX_VERIFIERS)
  ) {
    throw new Error(
      `policy.maxVerifiersCap must be an integer between 1 and ${HARD_MAX_VERIFIERS}: ${policy.maxVerifiersCap}`,
    );
  }
  if (
    policy.maxConcurrentVerifiersCap !== undefined &&
    (!Number.isInteger(policy.maxConcurrentVerifiersCap) ||
      policy.maxConcurrentVerifiersCap < 1 ||
      policy.maxConcurrentVerifiersCap > HARD_MAX_CONCURRENT_VERIFIERS)
  ) {
    throw new Error(
      `policy.maxConcurrentVerifiersCap must be an integer between 1 and ${HARD_MAX_CONCURRENT_VERIFIERS}: ${policy.maxConcurrentVerifiersCap}`,
    );
  }

  return {
    allowRepoModelOverride: policy.allowRepoModelOverride === true,
    allowRepoPostEventOverride: policy.allowRepoPostEventOverride === true,
    allowedModels:
      policy.allowedModels !== undefined
        ? new Set(policy.allowedModels.map((m) => normalizeModelIdentity(m)))
        : undefined,
    allowedProviders:
      policy.allowedProviders !== undefined
        ? new Set(policy.allowedProviders.map((p) => p.trim().toLowerCase()))
        : undefined,
    maxBudgetUsd: policy.maxBudgetUsd,
    maxIterationsCap: policy.maxIterationsCap,
    maxVerifiersCap: policy.maxVerifiersCap ?? HARD_MAX_VERIFIERS,
    maxConcurrentVerifiersCap: policy.maxConcurrentVerifiersCap,
  };
}

function isModelAllowedByPolicy(
  modelRef: string,
  allowedModels: ReadonlySet<string> | undefined,
  allowedProviders: ReadonlySet<string> | undefined,
): boolean {
  if (allowedModels !== undefined && !allowedModels.has(normalizeModelIdentity(modelRef))) {
    return false;
  }
  if (allowedProviders !== undefined) {
    const provider = extractModelProvider(modelRef);
    const vendor = extractEffectiveVendor(modelRef);
    if (!allowedProviders.has(provider) || !allowedProviders.has(vendor)) {
      return false;
    }
  }
  return true;
}

/** 別ベンダーのモデルを優先残存させながら `maxVerifiersCap` 件以内へクランプする。 */
function clampVerifiersPreservingDiversity(
  mainModel: string,
  verifierModels: readonly string[],
  maxVerifiersCap: number,
): string[] {
  if (verifierModels.length <= maxVerifiersCap) {
    return [...verifierModels];
  }
  const mainVendor = extractEffectiveVendor(mainModel);
  const crossVendor = verifierModels.filter((m) => extractEffectiveVendor(m) !== mainVendor);
  const sameVendor = verifierModels.filter((m) => extractEffectiveVendor(m) === mainVendor);
  return [...crossVendor, ...sameVendor].slice(0, maxVerifiersCap);
}

/**
 * 管理ストア設定とリポジトリ内宣言設定を安全にマージ・クランプする。
 * 課金上限・イテレーション上限・同時検証上限・モデル選択権限・投稿イベント権限は管理ストア側で強制クランプする。
 */
export function mergeRepoReviewConfig(
  adminConfig: PartialRepoReviewConfig,
  repoDeclared?: unknown,
  policy?: AdminReviewConfigPolicy | undefined,
): MergeRepoReviewConfigResult {
  const normalizedPolicy = validatePolicy(policy);
  const clampedFields: ClampedConfigField[] = [];
  const warnings: string[] = [];

  const adminMergedInput = {
    earlyRejectPolicy:
      adminConfig.earlyRejectPolicy ?? DEFAULT_REPO_REVIEW_CONFIG.earlyRejectPolicy,
    mainModel: adminConfig.mainModel ?? DEFAULT_REPO_REVIEW_CONFIG.mainModel,
    verifierModels:
      adminConfig.verifierModels !== undefined
        ? [...adminConfig.verifierModels]
        : [...DEFAULT_REPO_REVIEW_CONFIG.verifierModels],
    maxConcurrentVerifiers:
      adminConfig.maxConcurrentVerifiers ?? DEFAULT_REPO_REVIEW_CONFIG.maxConcurrentVerifiers,
    postEvent: adminConfig.postEvent ?? DEFAULT_REPO_REVIEW_CONFIG.postEvent,
    requiredTestChecks:
      adminConfig.requiredTestChecks !== undefined
        ? [...adminConfig.requiredTestChecks]
        : [...DEFAULT_REPO_REVIEW_CONFIG.requiredTestChecks],
    maxIterations: adminConfig.maxIterations ?? DEFAULT_REPO_REVIEW_CONFIG.maxIterations,
    budgetUsd: adminConfig.budgetUsd ?? DEFAULT_REPO_REVIEW_CONFIG.budgetUsd,
  };

  let adminBaseline = repoReviewConfigSchema.parse(adminMergedInput);

  // 管理ストア設定自体がポリシー上限を超えている場合も安全側へクランプする
  const effectiveMaxBudgetUsd =
    normalizedPolicy.maxBudgetUsd !== undefined
      ? Math.min(adminBaseline.budgetUsd, normalizedPolicy.maxBudgetUsd)
      : adminBaseline.budgetUsd;
  const effectiveMaxIterationsCap =
    normalizedPolicy.maxIterationsCap !== undefined
      ? Math.min(adminBaseline.maxIterations, normalizedPolicy.maxIterationsCap)
      : adminBaseline.maxIterations;
  const effectiveMaxConcurrentCap =
    normalizedPolicy.maxConcurrentVerifiersCap !== undefined
      ? Math.min(adminBaseline.maxConcurrentVerifiers, normalizedPolicy.maxConcurrentVerifiersCap)
      : adminBaseline.maxConcurrentVerifiers;

  const effectiveAdminVerifiers = clampVerifiersPreservingDiversity(
    adminBaseline.mainModel,
    adminBaseline.verifierModels,
    normalizedPolicy.maxVerifiersCap,
  );

  if (
    effectiveMaxBudgetUsd < adminBaseline.budgetUsd ||
    effectiveMaxIterationsCap < adminBaseline.maxIterations ||
    effectiveMaxConcurrentCap < adminBaseline.maxConcurrentVerifiers ||
    effectiveAdminVerifiers.length < adminBaseline.verifierModels.length
  ) {
    warnings.push("adminConfig values exceeded policy caps and were clamped to policy limits");
    adminBaseline = repoReviewConfigSchema.parse({
      ...adminBaseline,
      verifierModels: effectiveAdminVerifiers,
      budgetUsd: effectiveMaxBudgetUsd,
      maxIterations: effectiveMaxIterationsCap,
      maxConcurrentVerifiers: effectiveMaxConcurrentCap,
    });
  }

  if (repoDeclared === undefined || repoDeclared === null) {
    const diversity = analyzeProviderDiversity(
      adminBaseline.mainModel,
      adminBaseline.verifierModels,
    );
    return {
      config: adminBaseline,
      clampedFields,
      warnings: [...warnings, ...diversity.warnings],
    };
  }

  if (!isPlainRecord(repoDeclared)) {
    warnings.push("repoDeclared config must be a JSON object; ignoring repository declaration");
    const diversity = analyzeProviderDiversity(
      adminBaseline.mainModel,
      adminBaseline.verifierModels,
    );
    return {
      config: adminBaseline,
      clampedFields,
      warnings: [...warnings, ...diversity.warnings],
    };
  }

  let earlyRejectPolicy = adminBaseline.earlyRejectPolicy;
  if (repoDeclared.earlyRejectPolicy !== undefined) {
    const parsed = earlyRejectPolicySchema.safeParse(repoDeclared.earlyRejectPolicy);
    if (parsed.success) {
      earlyRejectPolicy = parsed.data;
    } else {
      clampedFields.push({
        field: "earlyRejectPolicy",
        declared: repoDeclared.earlyRejectPolicy,
        applied: earlyRejectPolicy,
        reason: "invalid earlyRejectPolicy in repository config; kept admin setting",
      });
      warnings.push("ignored invalid repoDeclared.earlyRejectPolicy");
    }
  }

  let postEvent = adminBaseline.postEvent;
  if (repoDeclared.postEvent !== undefined) {
    const parsed = postEventSchema.safeParse(repoDeclared.postEvent);
    if (!parsed.success) {
      clampedFields.push({
        field: "postEvent",
        declared: repoDeclared.postEvent,
        applied: postEvent,
        reason: "invalid postEvent in repository config; kept admin setting",
      });
      warnings.push("ignored invalid repoDeclared.postEvent");
    } else if (!normalizedPolicy.allowRepoPostEventOverride) {
      if (parsed.data !== postEvent) {
        clampedFields.push({
          field: "postEvent",
          declared: parsed.data,
          applied: postEvent,
          reason: "repository postEvent override is disabled by admin policy",
        });
        warnings.push(
          "repoDeclared.postEvent was ignored because allowRepoPostEventOverride is false",
        );
      }
    } else {
      postEvent = parsed.data;
    }
  }

  let budgetUsd = adminBaseline.budgetUsd;
  if (repoDeclared.budgetUsd !== undefined) {
    const parsed = z.number().finite().positive().safeParse(repoDeclared.budgetUsd);
    if (!parsed.success) {
      clampedFields.push({
        field: "budgetUsd",
        declared: repoDeclared.budgetUsd,
        applied: budgetUsd,
        reason: "invalid budgetUsd (must be positive finite number); kept admin setting",
      });
      warnings.push("ignored invalid repoDeclared.budgetUsd");
    } else if (parsed.data > effectiveMaxBudgetUsd) {
      budgetUsd = effectiveMaxBudgetUsd;
      clampedFields.push({
        field: "budgetUsd",
        declared: parsed.data,
        applied: budgetUsd,
        reason: `clamped to admin budgetUsd cap (${effectiveMaxBudgetUsd})`,
      });
      warnings.push(
        `clamped repoDeclared.budgetUsd (${parsed.data}) to admin cap (${effectiveMaxBudgetUsd})`,
      );
    } else {
      budgetUsd = parsed.data;
    }
  }

  let maxIterations = adminBaseline.maxIterations;
  if (repoDeclared.maxIterations !== undefined) {
    const parsed = z.number().int().min(1).safeParse(repoDeclared.maxIterations);
    if (!parsed.success) {
      clampedFields.push({
        field: "maxIterations",
        declared: repoDeclared.maxIterations,
        applied: maxIterations,
        reason: "invalid maxIterations (must be positive integer); kept admin setting",
      });
      warnings.push("ignored invalid repoDeclared.maxIterations");
    } else if (parsed.data > effectiveMaxIterationsCap) {
      maxIterations = effectiveMaxIterationsCap;
      clampedFields.push({
        field: "maxIterations",
        declared: parsed.data,
        applied: maxIterations,
        reason: `clamped to admin maxIterations cap (${effectiveMaxIterationsCap})`,
      });
      warnings.push(
        `clamped repoDeclared.maxIterations (${parsed.data}) to admin cap (${effectiveMaxIterationsCap})`,
      );
    } else {
      maxIterations = parsed.data;
    }
  }

  let maxConcurrentVerifiers = adminBaseline.maxConcurrentVerifiers;
  if (repoDeclared.maxConcurrentVerifiers !== undefined) {
    const parsed = z.number().int().min(1).safeParse(repoDeclared.maxConcurrentVerifiers);
    const hardEffectiveCap = Math.min(effectiveMaxConcurrentCap, HARD_MAX_CONCURRENT_VERIFIERS);
    if (!parsed.success) {
      clampedFields.push({
        field: "maxConcurrentVerifiers",
        declared: repoDeclared.maxConcurrentVerifiers,
        applied: maxConcurrentVerifiers,
        reason: "invalid maxConcurrentVerifiers (must be positive integer); kept admin setting",
      });
      warnings.push("ignored invalid repoDeclared.maxConcurrentVerifiers");
    } else if (parsed.data > hardEffectiveCap) {
      maxConcurrentVerifiers = hardEffectiveCap;
      clampedFields.push({
        field: "maxConcurrentVerifiers",
        declared: parsed.data,
        applied: maxConcurrentVerifiers,
        reason: `clamped to admin maxConcurrentVerifiers cap (${hardEffectiveCap})`,
      });
      warnings.push(
        `clamped repoDeclared.maxConcurrentVerifiers (${parsed.data}) to cap (${hardEffectiveCap})`,
      );
    } else {
      maxConcurrentVerifiers = parsed.data;
    }
  }

  // requiredTestChecks は管理ストア側の必須項目を削除不可とし、和集合で統合する
  const requiredChecksSet = new Set<string>(adminBaseline.requiredTestChecks);
  if (repoDeclared.requiredTestChecks !== undefined) {
    if (!Array.isArray(repoDeclared.requiredTestChecks)) {
      clampedFields.push({
        field: "requiredTestChecks",
        declared: repoDeclared.requiredTestChecks,
        applied: [...requiredChecksSet],
        reason: "invalid requiredTestChecks (must be string array); kept admin setting",
      });
      warnings.push("ignored invalid repoDeclared.requiredTestChecks");
    } else {
      let truncated = false;
      let ignoredInvalidEntry = false;
      for (const rawCheck of repoDeclared.requiredTestChecks) {
        const parsed = z.string().trim().min(1).max(MAX_CHECK_NAME_LENGTH).safeParse(rawCheck);
        if (!parsed.success) {
          ignoredInvalidEntry = true;
          continue;
        }
        if (requiredChecksSet.has(parsed.data)) {
          continue;
        }
        if (requiredChecksSet.size >= HARD_MAX_REQUIRED_TEST_CHECKS) {
          truncated = true;
          break;
        }
        requiredChecksSet.add(parsed.data);
      }
      if (ignoredInvalidEntry || truncated) {
        const reasons: string[] = [];
        if (ignoredInvalidEntry) {
          reasons.push("ignored invalid entries in repoDeclared.requiredTestChecks");
          warnings.push("ignored invalid entries in repoDeclared.requiredTestChecks");
        }
        if (truncated) {
          reasons.push(`capped requiredTestChecks at ${HARD_MAX_REQUIRED_TEST_CHECKS} entries`);
          warnings.push(
            `capped merged requiredTestChecks to ${HARD_MAX_REQUIRED_TEST_CHECKS} entries`,
          );
        }
        clampedFields.push({
          field: "requiredTestChecks",
          declared: repoDeclared.requiredTestChecks,
          applied: [...requiredChecksSet],
          reason: reasons.join("; "),
        });
      }
    }
  }

  let mainModel = adminBaseline.mainModel;
  let verifierModels: string[] = [...adminBaseline.verifierModels];
  let repoAttemptedMainModel = false;
  let repoAttemptedVerifiers = false;
  let pendingMainModelClamp: ClampedConfigField | undefined;
  let pendingVerifiersClamp: ClampedConfigField | undefined;

  if (repoDeclared.mainModel !== undefined) {
    repoAttemptedMainModel = true;
    const parsed = modelRefSchema.safeParse(repoDeclared.mainModel);
    if (!normalizedPolicy.allowRepoModelOverride) {
      const sameAsAdmin =
        parsed.success && normalizeModelIdentity(parsed.data) === normalizeModelIdentity(mainModel);
      if (!sameAsAdmin) {
        pendingMainModelClamp = {
          field: "mainModel",
          declared: repoDeclared.mainModel,
          applied: mainModel,
          reason: "repository model override is disabled by admin policy",
        };
        warnings.push("repoDeclared.mainModel was ignored because allowRepoModelOverride is false");
      }
    } else if (!parsed.success) {
      pendingMainModelClamp = {
        field: "mainModel",
        declared: repoDeclared.mainModel,
        applied: mainModel,
        reason: "invalid mainModel format in repository config; kept admin setting",
      };
      warnings.push("ignored invalid repoDeclared.mainModel");
    } else if (
      !isModelAllowedByPolicy(
        parsed.data,
        normalizedPolicy.allowedModels,
        normalizedPolicy.allowedProviders,
      )
    ) {
      pendingMainModelClamp = {
        field: "mainModel",
        declared: parsed.data,
        applied: mainModel,
        reason: "declared mainModel is not permitted by admin model/provider allowlist",
      };
      warnings.push(`repoDeclared.mainModel "${parsed.data}" is not permitted by admin allowlist`);
    } else {
      mainModel = parsed.data;
    }
  }

  if (repoDeclared.verifierModels !== undefined) {
    repoAttemptedVerifiers = true;
    if (!normalizedPolicy.allowRepoModelOverride) {
      const sameAsAdmin =
        Array.isArray(repoDeclared.verifierModels) &&
        repoDeclared.verifierModels.length === verifierModels.length &&
        repoDeclared.verifierModels.every((raw, idx) => {
          const parsed = modelRefSchema.safeParse(raw);
          const expected = verifierModels[idx];
          return (
            parsed.success &&
            expected !== undefined &&
            normalizeModelIdentity(parsed.data) === normalizeModelIdentity(expected)
          );
        });
      if (!sameAsAdmin) {
        pendingVerifiersClamp = {
          field: "verifierModels",
          declared: repoDeclared.verifierModels,
          applied: verifierModels,
          reason: "repository model override is disabled by admin policy",
        };
        warnings.push(
          "repoDeclared.verifierModels was ignored because allowRepoModelOverride is false",
        );
      }
    } else if (!Array.isArray(repoDeclared.verifierModels)) {
      pendingVerifiersClamp = {
        field: "verifierModels",
        declared: repoDeclared.verifierModels,
        applied: verifierModels,
        reason: "invalid verifierModels (must be model string array); kept admin setting",
      };
      warnings.push("ignored invalid repoDeclared.verifierModels");
    } else {
      const deduped: string[] = [];
      const seen = new Set<string>();
      const mainIdentity = normalizeModelIdentity(mainModel);
      let droppedAny = false;
      for (const rawModel of repoDeclared.verifierModels) {
        const parsed = modelRefSchema.safeParse(rawModel);
        if (!parsed.success) {
          droppedAny = true;
          continue;
        }
        const identity = normalizeModelIdentity(parsed.data);
        if (seen.has(identity)) {
          droppedAny = true;
          continue;
        }
        seen.add(identity);
        if (identity === mainIdentity) {
          droppedAny = true;
          continue;
        }
        if (
          !isModelAllowedByPolicy(
            parsed.data,
            normalizedPolicy.allowedModels,
            normalizedPolicy.allowedProviders,
          )
        ) {
          droppedAny = true;
          continue;
        }
        deduped.push(parsed.data);
      }

      const capped = deduped.slice(0, normalizedPolicy.maxVerifiersCap);
      if (deduped.length > normalizedPolicy.maxVerifiersCap) {
        droppedAny = true;
      }

      if (capped.length === 0) {
        pendingVerifiersClamp = {
          field: "verifierModels",
          declared: repoDeclared.verifierModels,
          applied: adminBaseline.verifierModels,
          reason:
            "no permitted verifierModels remained after validation/allowlist; reverted to admin setting",
        };
        warnings.push("no valid permitted repoDeclared.verifierModels remained; reverted to admin");
      } else {
        verifierModels = capped;
        if (droppedAny) {
          pendingVerifiersClamp = {
            field: "verifierModels",
            declared: repoDeclared.verifierModels,
            applied: verifierModels,
            reason: `filtered/capped verifierModels to permitted unique models (max ${normalizedPolicy.maxVerifiersCap})`,
          };
          warnings.push("filtered or capped repoDeclared.verifierModels per admin policy");
        }
      }
    }
  }

  // 片側上書き（例: mainModel のみ変更）で自己重複や同一ベンダーのみ構成になった場合は両方管理側へ安全フォールバック
  const mainIdentityFinal = normalizeModelIdentity(mainModel);
  const hasSelfMatch = verifierModels.some((m) => normalizeModelIdentity(m) === mainIdentityFinal);
  const pairDiversity = analyzeProviderDiversity(mainModel, verifierModels);
  if (hasSelfMatch || !pairDiversity.hasCrossProviderVerifier) {
    const reason = hasSelfMatch
      ? "merged mainModel and verifierModels collided on the same model; reverted model pair to admin setting"
      : "merged mainModel and verifierModels violated cross-provider diversity; reverted model pair to admin setting";
    if (
      repoAttemptedMainModel &&
      normalizeModelIdentity(mainModel) !== normalizeModelIdentity(adminBaseline.mainModel)
    ) {
      pendingMainModelClamp = {
        field: "mainModel",
        declared: repoDeclared.mainModel,
        applied: adminBaseline.mainModel,
        reason,
      };
    }
    if (repoAttemptedVerifiers) {
      pendingVerifiersClamp = {
        field: "verifierModels",
        declared: repoDeclared.verifierModels,
        applied: adminBaseline.verifierModels,
        reason,
      };
    }
    warnings.push(reason);
    mainModel = adminBaseline.mainModel;
    verifierModels = [...adminBaseline.verifierModels];
  }

  if (pendingMainModelClamp !== undefined) {
    clampedFields.push(pendingMainModelClamp);
  }
  if (pendingVerifiersClamp !== undefined) {
    clampedFields.push(pendingVerifiersClamp);
  }

  const finalConfig = repoReviewConfigSchema.parse({
    earlyRejectPolicy,
    mainModel,
    verifierModels,
    maxConcurrentVerifiers,
    postEvent,
    requiredTestChecks: [...requiredChecksSet],
    maxIterations,
    budgetUsd,
  });

  const finalDiversity = analyzeProviderDiversity(
    finalConfig.mainModel,
    finalConfig.verifierModels,
  );

  return {
    config: finalConfig,
    clampedFields,
    warnings: [...warnings, ...finalDiversity.warnings],
  };
}
