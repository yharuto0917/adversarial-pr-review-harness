import { describe, expect, it } from "vitest";

import {
  analyzeProviderDiversity,
  DEFAULT_MAIN_MODEL,
  DEFAULT_REPO_REVIEW_CONFIG,
  DEFAULT_VERIFIER_MODELS,
  extractEffectiveVendor,
  extractModelProvider,
  mergeRepoReviewConfig,
  modelRefSchema,
  repoDeclaredReviewConfigSchema,
  repoReviewConfigSchema,
  validateStrictProviderDiversity,
} from "./config.js";

describe("modelRefSchema / プロバイダ・実ベンダー抽出", () => {
  it("通常のモデル参照とアグリゲータ経由のモデル参照を正しく分解する", () => {
    expect(modelRefSchema.parse("google/gemini-4-neon")).toBe("google/gemini-4-neon");
    expect(extractModelProvider("google/gemini-4-neon")).toBe("google");
    expect(extractEffectiveVendor("google/gemini-4-neon")).toBe("google");

    expect(extractModelProvider("openrouter/google/gemini-4-neon")).toBe("openrouter");
    expect(extractEffectiveVendor("openrouter/google/gemini-4-neon")).toBe("google");
    expect(extractEffectiveVendor("OpenRouter/Google/gemini-4-neon")).toBe("google");
    expect(extractEffectiveVendor("openrouter/~google/gemini-4-neon")).toBe("google");
    expect(extractEffectiveVendor("openrouter/~anthropic/claude-sonnet-5.5")).toBe("anthropic");
    expect(extractEffectiveVendor("openrouter/auto")).toBeNull();
    expect(extractEffectiveVendor("openrouter/openrouter/free")).toBeNull();
    expect(extractModelProvider("Google/gemini-4-neon")).toBe("google");
    expect(extractEffectiveVendor("openrouter/anthropic/claude-sonnet-5.5")).toBe("anthropic");
    expect(extractEffectiveVendor("opencode/gpt-6.2-sol")).toBe("openai");
    expect(extractEffectiveVendor("opencode/claude-opus-5")).toBe("anthropic");
    expect(extractEffectiveVendor("opencode/gemini-3.8-flash")).toBe("google");
    expect(extractEffectiveVendor("opencode/deepseek-v4-pro")).toBe("deepseek");
    expect(extractEffectiveVendor("opencode/grok-4.7")).toBe("x-ai");
    expect(extractEffectiveVendor("opencode/kimi-k3")).toBe("moonshotai");
    expect(extractEffectiveVendor("opencode/qwen3.8-max")).toBe("qwen");
    expect(extractEffectiveVendor("opencode/big-pickle")).toBeNull();
    expect(extractEffectiveVendor("opencode/unknown-custom-model")).toBeNull();
  });

  it.each([
    "",
    "gemini-4-neon",
    "/gemini-4-neon",
    "google/",
    "google//gemini-4-neon",
    "google/gemini 4",
    "google/gemini\nneon",
    "google/../evil",
  ])("不正なモデル参照 %j を拒否する", (invalid) => {
    expect(modelRefSchema.safeParse(invalid).success).toBe(false);
    expect(() => extractModelProvider(invalid)).toThrow();
  });
});

describe("repoReviewConfigSchema", () => {
  it("既定設定が Issue #64 仕様と一致しスキーマを通過する", () => {
    expect(DEFAULT_MAIN_MODEL).toBe("google/gemini-4-neon");
    expect(DEFAULT_VERIFIER_MODELS).toEqual(["openai/gpt-6.2-sol", "anthropic/claude-sonnet-5.5"]);

    const parsed = repoReviewConfigSchema.parse(DEFAULT_REPO_REVIEW_CONFIG);
    expect(parsed.earlyRejectPolicy).toBe("on_test_failure");
    expect(parsed.maxConcurrentVerifiers).toBe(2);
    expect(parsed.postEvent).toBe("COMMENT");
    expect(validateStrictProviderDiversity(parsed).valid).toBe(true);
  });

  it("同一プロバイダのみ構成・アグリゲータ迂回・自己重複・体数上限超過を拒否する", () => {
    // 同一プロバイダのみ
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["google/gemini-3.5-flash"],
      }).success,
    ).toBe(false);

    // アグリゲータ経由の同一ベンダー迂回（大文字混在・openrouter ~ 付き・opencode フラット ID・未知 ID）を拒否
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["openrouter/google/gemini-4-neon"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["OpenRouter/Google/gemini-4-neon"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["openrouter/~google/gemini-4-neon"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "anthropic/claude-sonnet-5.5",
        verifierModels: ["opencode/claude-opus-5"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "anthropic/claude-sonnet-5.5",
        verifierModels: ["openrouter/~anthropic/claude-opus-5"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["opencode/gemini-3.5-flash", "openrouter/~google/gemini-3.8-flash"],
      }).success,
    ).toBe(false);
    // 実ベンダー判定不能な中継 ID は同一ベンダーとみなして拒否
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["opencode/big-pickle"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["openrouter/auto"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "opencode/big-pickle",
        verifierModels: ["openai/gpt-6.2-sol"],
      }).success,
    ).toBe(false);

    // mainModel 自身（大文字小文字違い含む）を verifierModels に含める自己検証を拒否
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "openai/gpt-6.2-sol",
        verifierModels: ["openai/gpt-6.2-sol", "anthropic/claude-sonnet-5.5"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        mainModel: "google/gemini-4-neon",
        verifierModels: ["Google/gemini-4-neon", "openai/gpt-6.2-sol"],
      }).success,
    ).toBe(false);

    // 重複モデル・0 体・6 体を拒否
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        verifierModels: ["openai/gpt-6.2-sol", "openai/gpt-6.2-sol"],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        verifierModels: [],
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        verifierModels: [
          "openai/m1",
          "anthropic/m2",
          "opencode/m3",
          "openrouter/meta/m4",
          "openrouter/mistral/m5",
          "openrouter/deepseek/m6",
        ],
      }).success,
    ).toBe(false);

    // maxConcurrentVerifiers の範囲外を拒否
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        maxConcurrentVerifiers: 0,
      }).success,
    ).toBe(false);
    expect(
      repoReviewConfigSchema.safeParse({
        ...DEFAULT_REPO_REVIEW_CONFIG,
        maxConcurrentVerifiers: 6,
      }).success,
    ).toBe(false);
  });

  it("一部混在・相互プロバイダ重複は analyzeProviderDiversity が警告し厳格検証で検出できる", () => {
    const mixed = {
      ...DEFAULT_REPO_REVIEW_CONFIG,
      mainModel: "google/gemini-4-neon",
      verifierModels: ["google/gemini-3.5-flash", "openai/gpt-6.2-sol", "openai/gpt-6.1-sol"],
    };

    // 別プロバイダが 1 体以上あるためスキーマ自体は通過
    expect(repoReviewConfigSchema.safeParse(mixed).success).toBe(true);

    const analysis = analyzeProviderDiversity(mixed.mainModel, mixed.verifierModels);
    expect(analysis.hasCrossProviderVerifier).toBe(true);
    expect(analysis.sameVendorAsMainModels).toEqual(["google/gemini-3.5-flash"]);
    expect(analysis.duplicateVendorGroups).toEqual([
      { vendor: "openai", models: ["openai/gpt-6.2-sol", "openai/gpt-6.1-sol"] },
    ]);
    expect(analysis.warnings.length).toBe(2);
    expect(validateStrictProviderDiversity(mixed).valid).toBe(false);
  });
});

describe("mergeRepoReviewConfig", () => {
  it("既定ポリシーでは課金・回数・並列上限をクランプしモデル・postEvent 上書きを拒否する", () => {
    const result = mergeRepoReviewConfig(
      {
        budgetUsd: 4,
        maxIterations: 3,
        maxConcurrentVerifiers: 2,
        postEvent: "COMMENT",
        requiredTestChecks: ["ci/unit"],
      },
      {
        earlyRejectPolicy: "never",
        mainModel: "anthropic/claude-opus-5-5",
        verifierModels: ["openai/gpt-6.1-sol"],
        maxConcurrentVerifiers: 5,
        postEvent: "APPROVE",
        requiredTestChecks: ["ci/e2e"],
        maxIterations: 10,
        budgetUsd: 50,
      },
    );

    expect(result.config.earlyRejectPolicy).toBe("never");
    expect(result.config.mainModel).toBe(DEFAULT_MAIN_MODEL);
    expect(result.config.verifierModels).toEqual([...DEFAULT_VERIFIER_MODELS]);
    expect(result.config.postEvent).toBe("COMMENT");
    expect(result.config.budgetUsd).toBe(4);
    expect(result.config.maxIterations).toBe(3);
    expect(result.config.maxConcurrentVerifiers).toBe(2);
    expect(result.config.requiredTestChecks).toEqual(["ci/unit", "ci/e2e"]);

    const clampedFieldNames = result.clampedFields.map((c) => c.field);
    expect(clampedFieldNames).toEqual(
      expect.arrayContaining([
        "mainModel",
        "verifierModels",
        "postEvent",
        "budgetUsd",
        "maxIterations",
        "maxConcurrentVerifiers",
      ]),
    );
  });

  it("リポジトリ宣言による安全な引き下げ（budgetUsd / maxIterations 削減）は許可する", () => {
    const result = mergeRepoReviewConfig(
      { budgetUsd: 10, maxIterations: 5, maxConcurrentVerifiers: 3 },
      { budgetUsd: 2.5, maxIterations: 2, maxConcurrentVerifiers: 1 },
    );

    expect(result.config.budgetUsd).toBe(2.5);
    expect(result.config.maxIterations).toBe(2);
    expect(result.config.maxConcurrentVerifiers).toBe(1);
    expect(result.clampedFields).toEqual([]);
  });

  it("NaN / Infinity / 負値 / 非整数などの不正値でクラッシュや上限突破を起こさない", () => {
    const result = mergeRepoReviewConfig(
      { budgetUsd: 5, maxIterations: 4, maxConcurrentVerifiers: 2 },
      {
        budgetUsd: Number.NaN,
        maxIterations: 1.5,
        maxConcurrentVerifiers: -1,
        earlyRejectPolicy: "invalid_mode",
        postEvent: "INVALID",
      },
    );

    expect(result.config.budgetUsd).toBe(5);
    expect(result.config.maxIterations).toBe(4);
    expect(result.config.maxConcurrentVerifiers).toBe(2);
    expect(result.config.earlyRejectPolicy).toBe("on_test_failure");
    expect(result.clampedFields.length).toBe(5);
  });

  it("allowRepoModelOverride=true でも空ホワイトリスト・アグリゲータ迂回・片側衝突を安全制御する", () => {
    // 空ホワイトリスト [] は全拒否（fail-closed）
    const emptyAllowlist = mergeRepoReviewConfig(
      {},
      {
        mainModel: "openai/gpt-6.2-sol",
        verifierModels: ["anthropic/claude-sonnet-5.5"],
      },
      { allowRepoModelOverride: true, allowedModels: [] },
    );
    expect(emptyAllowlist.config.mainModel).toBe(DEFAULT_MAIN_MODEL);
    expect(emptyAllowlist.config.verifierModels).toEqual([...DEFAULT_VERIFIER_MODELS]);

    // allowedProviders が実ベンダーも検査し openrouter/google/...・openrouter/~google/...・opencode/claude-...・未知 ID を弾く
    const aggregatorBypass = mergeRepoReviewConfig(
      {},
      {
        verifierModels: [
          "openrouter/google/gemini-4-neon",
          "openrouter/~google/gemini-3.5-flash",
          "opencode/claude-opus-5",
          "opencode/big-pickle",
          "opencode/gpt-6.1-sol",
        ],
      },
      { allowRepoModelOverride: true, allowedProviders: ["openrouter", "opencode", "openai"] },
    );
    expect(aggregatorBypass.config.verifierModels).toEqual(["opencode/gpt-6.1-sol"]);

    // 既定 Google 主モデルに対し Google 系中継モデル 2 件を宣言しても拒否し管理ストア値へ戻す
    const googleRelaySelfApprove = mergeRepoReviewConfig(
      {},
      {
        verifierModels: ["opencode/gemini-3.5-flash", "openrouter/~google/gemini-3.8-flash"],
      },
      { allowRepoModelOverride: true },
    );
    expect(googleRelaySelfApprove.config.verifierModels).toEqual([...DEFAULT_VERIFIER_MODELS]);
    expect(
      googleRelaySelfApprove.clampedFields.filter((c) => c.field === "verifierModels"),
    ).toHaveLength(1);
    expect(googleRelaySelfApprove.warnings.length).toBeGreaterThan(0);

    // allowedProviders に opencode 単体のみ許可しても配下の全ベンダーは許可しない
    const opencodeOnlyAllowlist = mergeRepoReviewConfig(
      {},
      {
        verifierModels: ["opencode/claude-opus-5", "opencode/gpt-6-sol"],
      },
      { allowRepoModelOverride: true, allowedProviders: ["opencode"] },
    );
    expect(opencodeOnlyAllowlist.config.verifierModels).toEqual([...DEFAULT_VERIFIER_MODELS]);
    expect(opencodeOnlyAllowlist.clampedFields.some((c) => c.field === "verifierModels")).toBe(
      true,
    );

    // 片側上書き（mainModel のみ変更）で管理側 verifier と自己衝突したらペアごと管理値へ戻す
    const oneSideCollision = mergeRepoReviewConfig(
      {
        mainModel: "google/gemini-4-neon",
        verifierModels: ["openai/gpt-6.2-sol"],
      },
      {
        mainModel: "openai/gpt-6.2-sol",
      },
      { allowRepoModelOverride: true },
    );
    expect(oneSideCollision.config.mainModel).toBe("google/gemini-4-neon");
    expect(oneSideCollision.config.verifierModels).toEqual(["openai/gpt-6.2-sol"]);
    expect(oneSideCollision.clampedFields.some((c) => c.field === "mainModel")).toBe(true);

    // 重複除去後に maxVerifiersCap で切り詰める
    const dedupeAndCap = mergeRepoReviewConfig(
      {},
      {
        verifierModels: [
          "openai/gpt-6.2-sol",
          "openai/gpt-6.2-sol",
          "anthropic/claude-sonnet-5.5",
          "opencode/gpt-6-sol",
        ],
      },
      { allowRepoModelOverride: true, maxVerifiersCap: 2 },
    );
    expect(dedupeAndCap.config.verifierModels).toEqual([
      "openai/gpt-6.2-sol",
      "anthropic/claude-sonnet-5.5",
    ]);
  });

  it("adminConfig 自体が policy 上限（maxVerifiersCap 含む）を超えている場合もクランプされる", () => {
    const result = mergeRepoReviewConfig(
      {
        mainModel: "google/gemini-4-neon",
        verifierModels: ["google/gemini-3.5-flash", "openai/gpt-6.2-sol"],
        budgetUsd: 20,
        maxIterations: 10,
        maxConcurrentVerifiers: 5,
      },
      undefined,
      {
        maxBudgetUsd: 8,
        maxIterationsCap: 4,
        maxVerifiersCap: 1,
        maxConcurrentVerifiersCap: 3,
      },
    );

    expect(result.config.budgetUsd).toBe(8);
    expect(result.config.maxIterations).toBe(4);
    expect(result.config.maxConcurrentVerifiers).toBe(3);
    // maxVerifiersCap=1 のとき異種ベンダー（openai）を優先残存させる
    expect(result.config.verifierModels).toEqual(["openai/gpt-6.2-sol"]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("verifierModels 一部除外後にペアフォールバックしても clampedFields に二重記録されない", () => {
    const result = mergeRepoReviewConfig(
      {},
      {
        verifierModels: [
          "google/gemini-3.5-flash",
          "invalid-model-without-slash",
          "OpenRouter/Google/gemini-3.5-flash",
        ],
      },
      { allowRepoModelOverride: true },
    );

    expect(result.config.verifierModels).toEqual([...DEFAULT_VERIFIER_MODELS]);
    const verifierClamps = result.clampedFields.filter((c) => c.field === "verifierModels");
    expect(verifierClamps).toHaveLength(1);
    expect(verifierClamps[0]?.applied).toEqual([...DEFAULT_VERIFIER_MODELS]);
  });

  it("repoDeclaredReviewConfigSchema・allowRepoPostEventOverride・requiredTestChecks 上限・異常 policy を検証する", () => {
    // 超過正値はクランプ前提で repoDeclaredReviewConfigSchema を通過する
    const declared = repoDeclaredReviewConfigSchema.parse({
      budgetUsd: 100,
      maxIterations: 50,
      verifierModels: ["openai/m1", "anthropic/m2", "opencode/m3", "a/m4", "b/m5", "c/m6"],
    });
    expect(declared.budgetUsd).toBe(100);

    // allowRepoPostEventOverride: true で postEvent 上書きを許可
    const postOverride = mergeRepoReviewConfig(
      { postEvent: "COMMENT" },
      { postEvent: "REQUEST_CHANGES" },
      { allowRepoPostEventOverride: true },
    );
    expect(postOverride.config.postEvent).toBe("REQUEST_CHANGES");
    expect(postOverride.clampedFields).toEqual([]);

    // requiredTestChecks の 50 件上限打ち切り・重複排除・不正要素除外
    const manyChecks = Array.from({ length: 55 }, (_, i) => `check-${i}`);
    const checksResult = mergeRepoReviewConfig(
      { requiredTestChecks: ["check-0"] },
      { requiredTestChecks: ["", "   ", ...manyChecks] },
    );
    expect(checksResult.config.requiredTestChecks).toHaveLength(50);
    expect(checksResult.clampedFields.some((c) => c.field === "requiredTestChecks")).toBe(true);

    // repoDeclared が非オブジェクトなら管理ストア値へフォールバック
    const nonObj = mergeRepoReviewConfig({}, "not-an-object");
    expect(nonObj.config).toEqual(DEFAULT_REPO_REVIEW_CONFIG);
    expect(nonObj.warnings.length).toBeGreaterThan(0);

    // 不正 policy は fail-fast 例外
    expect(() => mergeRepoReviewConfig({}, undefined, { maxBudgetUsd: 0 })).toThrow();
    expect(() => mergeRepoReviewConfig({}, undefined, { maxIterationsCap: 21 })).toThrow();
    expect(() => mergeRepoReviewConfig({}, undefined, { maxVerifiersCap: 6 })).toThrow();
    expect(() => mergeRepoReviewConfig({}, undefined, { maxConcurrentVerifiersCap: 0 })).toThrow();
  });
});
