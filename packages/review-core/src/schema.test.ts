import { describe, expect, it } from "vitest";

import {
  ALLOWED_SEVERITIES_BY_CATEGORY,
  adjudicationResultSchema,
  adversarialVerdictSchema,
  challengedFindingSchema,
  codeHealthVerdictSchema,
  draftFindingSchema,
  evidenceSchema,
  type Finding,
  type FindingCategory,
  finalFindingSchema,
  findingSchema,
  isBlockingFinding,
  isTerminalRunStage,
  isValidCategorySeverity,
  missedFindingSchema,
  RUN_STAGES,
  reviewRunSchema,
  runStageSchema,
  type Severity,
  severitySchema,
  testExecutionReportSchema,
} from "./schema.js";

describe("findingSchema", () => {
  it("最小構成の指摘をパースできる", () => {
    const parsed = findingSchema.parse({
      fingerprint: "abc123",
      path: "src/index.ts",
      line: 10,
      severity: "major",
      title: "境界値が未処理",
      body: "空配列のときに例外になる。",
    });

    expect(parsed.severity).toBe("major");
  });

  it("category を指定した場合は severity との組み合わせを検証する", () => {
    const parsed = findingSchema.parse({
      fingerprint: "fp-1",
      path: "src/index.ts",
      line: 10,
      category: "risk",
      severity: "minor",
      symbol: "parseItems",
      inChangedLines: true,
      evidenceSummary: ["src/index.ts:10 で未チェック"],
      title: "軽微なリスク",
      body: "フォローアップで改善可能。",
    });

    expect(parsed.category).toBe("risk");
    expect(parsed.severity).toBe("minor");

    const invalid = findingSchema.safeParse({
      fingerprint: "fp-2",
      path: "src/index.ts",
      line: 10,
      category: "bug",
      severity: "minor",
      title: "不正組み合わせ",
      body: "bug に minor は不可。",
    });
    expect(invalid.success).toBe(false);
  });

  it("severitySchema は @repo/eval と互換の 4 段階を維持する", () => {
    expect(severitySchema.options).toEqual(["blocker", "major", "minor", "nit"]);
  });
});

describe("runStageSchema", () => {
  it("awaiting_ci を含む全 12 状態を受理する", () => {
    expect(RUN_STAGES).toHaveLength(12);
    expect(RUN_STAGES).toContain("awaiting_ci");
    for (const stage of RUN_STAGES) {
      expect(runStageSchema.parse(stage)).toBe(stage);
    }
    expect(runStageSchema.safeParse("unknown_stage").success).toBe(false);
  });

  it("終了状態のみ isTerminalRunStage が true を返す", () => {
    expect(isTerminalRunStage("completed")).toBe(true);
    expect(isTerminalRunStage("early_rejected")).toBe(true);
    expect(isTerminalRunStage("superseded")).toBe(true);
    expect(isTerminalRunStage("failed")).toBe(true);

    expect(isTerminalRunStage("queued")).toBe(false);
    expect(isTerminalRunStage("awaiting_ci")).toBe(false);
    expect(isTerminalRunStage("testing")).toBe(false);
    expect(isTerminalRunStage("primary_review")).toBe(false);
    expect(isTerminalRunStage("adversarial_verification")).toBe(false);
    expect(isTerminalRunStage("decision_adjudication")).toBe(false);
    expect(isTerminalRunStage("synthesis_and_publish")).toBe(false);
    expect(isTerminalRunStage("awaiting_approval")).toBe(false);
  });
});

describe("FindingCategory × Severity 制約", () => {
  const validPairs: ReadonlyArray<readonly [FindingCategory, Severity, boolean]> = [
    ["bug", "blocker", true],
    ["bug", "major", true],
    ["risk", "major", true],
    ["risk", "minor", false],
    ["nit", "nit", false],
    ["question", "nit", false],
  ];

  const invalidPairs: ReadonlyArray<readonly [FindingCategory, Severity]> = [
    ["bug", "minor"],
    ["bug", "nit"],
    ["risk", "blocker"],
    ["risk", "nit"],
    ["nit", "blocker"],
    ["nit", "major"],
    ["nit", "minor"],
    ["question", "blocker"],
    ["question", "major"],
    ["question", "minor"],
  ];

  it("許可 6 通り・禁止 10 通りで全 16 通りを網羅する", () => {
    expect(validPairs.length + invalidPairs.length).toBe(16);
    expect(ALLOWED_SEVERITIES_BY_CATEGORY).toEqual({
      bug: ["blocker", "major"],
      risk: ["major", "minor"],
      nit: ["nit"],
      question: ["nit"],
    });
  });

  it.each(validPairs)(
    "許可ペア (%s, %s) は DraftFinding / FinalFinding を通過し blocking=%s",
    (category, severity, expectedBlocking) => {
      expect(isValidCategorySeverity(category, severity)).toBe(true);
      expect(isBlockingFinding({ category, severity })).toBe(expectedBlocking);

      const draft = draftFindingSchema.safeParse({
        draftId: "F1",
        path: "src/app.ts",
        line: 12,
        category,
        severity,
        title: "検証対象",
        body: "詳細説明",
        inChangedLines: true,
        evidence: [],
      });
      expect(draft.success).toBe(true);

      const finalResult = finalFindingSchema.safeParse({
        fingerprint: "fp-valid",
        path: "src/app.ts",
        line: 12,
        category,
        severity,
        title: "検証対象",
        body: "詳細説明",
        inChangedLines: true,
        evidence: [
          {
            kind: "code_reference",
            summary: "該当行を確認",
            path: "src/app.ts",
            line: 12,
            harnessVerification: "not_applicable",
          },
        ],
      });
      expect(finalResult.success).toBe(true);
    },
  );

  it.each(invalidPairs)(
    "禁止ペア (%s, %s) は DraftFinding / FinalFinding で拒否される",
    (category, severity) => {
      expect(isValidCategorySeverity(category, severity)).toBe(false);

      const draft = draftFindingSchema.safeParse({
        draftId: "F1",
        path: "src/app.ts",
        line: 12,
        category,
        severity,
        title: "不正組み合わせ",
        body: "詳細説明",
        inChangedLines: true,
        evidence: [],
      });
      expect(draft.success).toBe(false);

      const finalResult = finalFindingSchema.safeParse({
        fingerprint: "fp-invalid",
        path: "src/app.ts",
        line: 12,
        category,
        severity,
        title: "不正組み合わせ",
        body: "詳細説明",
        inChangedLines: true,
        evidence: [
          {
            kind: "code_reference",
            summary: "該当行を確認",
            path: "src/app.ts",
            line: 12,
            harnessVerification: "not_applicable",
          },
        ],
      });
      expect(finalResult.success).toBe(false);
    },
  );
});

describe("evidenceSchema", () => {
  it("コマンド出力証拠と 5 種の harnessVerification を検証できる", () => {
    for (const verification of [
      "confirmed",
      "contradicted",
      "unsafe_command",
      "timed_out",
      "not_applicable",
    ] as const) {
      const parsed = evidenceSchema.parse({
        kind: "test_reproduction",
        summary: "再現テストを実行した",
        command: "pnpm test",
        exitCode: 1,
        commandOutput: "FAIL src/app.test.ts",
        harnessVerification: verification,
      });
      expect(parsed.harnessVerification).toBe(verification);
    }
  });

  it("line が null または endLine < line の行範囲矛盾を拒否する", () => {
    expect(
      evidenceSchema.safeParse({
        kind: "code_reference",
        summary: "行番号が null なのに endLine がある",
        path: "src/a.ts",
        line: null,
        endLine: 10,
        harnessVerification: "not_applicable",
      }).success,
    ).toBe(false);

    expect(
      evidenceSchema.safeParse({
        kind: "code_reference",
        summary: "endLine が line より小さい",
        path: "src/a.ts",
        line: 20,
        endLine: 10,
        harnessVerification: "not_applicable",
      }).success,
    ).toBe(false);
  });

  it("kind に応じた必須フィールド（command / path）欠落を拒否する", () => {
    expect(
      evidenceSchema.safeParse({
        kind: "command_output",
        summary: "コマンドなし",
        harnessVerification: "confirmed",
      }).success,
    ).toBe(false);

    expect(
      evidenceSchema.safeParse({
        kind: "code_reference",
        summary: "パスなし",
        harnessVerification: "not_applicable",
      }).success,
    ).toBe(false);
  });
});

describe("testExecutionReportSchema", () => {
  it("full モードの正常レポートを受理する", () => {
    const parsed = testExecutionReportSchema.parse({
      headSha: "abc1234",
      baseSha: "def5678",
      executionMode: "full",
      source: "ci",
      overallStatus: "passed",
      hasRegressionFailure: false,
      shouldEarlyReject: false,
      checks: [
        {
          name: "vitest",
          kind: "test",
          source: "ci",
          status: "passed",
          exitCode: 0,
          durationMs: 1200,
        },
      ],
      evaluatedAt: "2026-11-27T14:00:00Z",
    });

    expect(parsed.overallStatus).toBe("passed");
  });

  it("static_only モードでは sandbox 混入・理由欠落・未実行 passed を拒否する", () => {
    // 正常な static_only（外部フォーク PR）
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "static_only",
        staticOnlyReason: "fork_pr",
        source: "static_only",
        overallStatus: "static_only",
        hasRegressionFailure: false,
        shouldEarlyReject: false,
        checks: [{ name: "static-syntax", kind: "other", source: "static", status: "passed" }],
      }).success,
    ).toBe(true);

    // static_only + sandbox check 混入は拒否
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "static_only",
        staticOnlyReason: "fork_pr",
        source: "ci",
        overallStatus: "failed",
        hasRegressionFailure: true,
        shouldEarlyReject: true,
        earlyRejectReason: "CI test failed",
        checks: [{ name: "vitest", kind: "test", source: "sandbox", status: "failed" }],
      }).success,
    ).toBe(false);

    // static_only + source: "static_only" + overallStatus: "passed" は拒否
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "static_only",
        staticOnlyReason: "ci_script_hazard",
        source: "static_only",
        overallStatus: "passed",
        hasRegressionFailure: false,
        shouldEarlyReject: false,
        checks: [],
      }).success,
    ).toBe(false);

    // shouldEarlyReject: true なのに earlyRejectReason 欠落は拒否
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "full",
        source: "sandbox",
        overallStatus: "failed",
        hasRegressionFailure: true,
        shouldEarlyReject: true,
        checks: [],
      }).success,
    ).toBe(false);

    // full モードでの staticOnlyReason / static_only 指定や shouldEarlyReject: false での理由指定を拒否
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "full",
        staticOnlyReason: "fork_pr",
        source: "ci",
        overallStatus: "passed",
        hasRegressionFailure: false,
        shouldEarlyReject: false,
        checks: [],
      }).success,
    ).toBe(false);
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "full",
        source: "static_only",
        overallStatus: "static_only",
        hasRegressionFailure: false,
        shouldEarlyReject: false,
        checks: [],
      }).success,
    ).toBe(false);
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "full",
        source: "ci",
        overallStatus: "passed",
        hasRegressionFailure: false,
        shouldEarlyReject: false,
        earlyRejectReason: "不要な理由",
        checks: [],
      }).success,
    ).toBe(false);

    // オフセット付き ISO-8601 タイムスタンプ（+09:00）も受理する
    expect(
      testExecutionReportSchema.safeParse({
        headSha: "abc1234",
        executionMode: "full",
        source: "ci",
        overallStatus: "passed",
        hasRegressionFailure: false,
        shouldEarlyReject: false,
        checks: [],
        evaluatedAt: "2026-11-27T23:45:00+09:00",
      }).success,
    ).toBe(true);
  });
});

describe("adversarialVerdictSchema", () => {
  it("challengeNonce なしでパースでき、revise の整合性を検証する", () => {
    const parsed = adversarialVerdictSchema.parse({
      conversationId: "conv-verifier-1",
      verifierModel: "openai/gpt-6.2-sol",
      challengedFindings: [
        {
          draftId: "F1",
          verdict: "revise",
          reason: "実コードを確認したところ軽微リスク相当であり minor への調整が妥当",
          evidence: [],
          revisedCategory: "risk",
          revisedSeverity: "minor",
        },
      ],
      missedFindings: [
        {
          path: "src/auth.ts",
          line: 42,
          category: "bug",
          severity: "blocker",
          title: "認可チェック漏れ",
          body: "管理者ルートでロール検証が抜けている。",
          inChangedLines: true,
          evidence: [],
        },
      ],
      checkedFiles: ["src/auth.ts"],
      auditNotes: "認証モジュールと同種ハンドラを突き合わせて境界条件を確認済み。",
    });

    expect(parsed.conversationId).toBe("conv-verifier-1");
    expect("challengeNonce" in parsed).toBe(false);
  });

  it("文字数不足・重複 draftId・revise 以外の revised* 指定を拒否する", () => {
    // reason 9 文字は拒否
    expect(
      adversarialVerdictSchema.safeParse({
        conversationId: "conv-1",
        verifierModel: "openai/gpt-6.2-sol",
        challengedFindings: [{ draftId: "F1", verdict: "keep", reason: "123456789", evidence: [] }],
        missedFindings: [],
        checkedFiles: [],
        auditNotes: "12345678901234567890",
      }).success,
    ).toBe(false);

    // auditNotes 19 文字は拒否
    expect(
      adversarialVerdictSchema.safeParse({
        conversationId: "conv-1",
        verifierModel: "openai/gpt-6.2-sol",
        challengedFindings: [],
        missedFindings: [],
        checkedFiles: [],
        auditNotes: "1234567890123456789",
      }).success,
    ).toBe(false);

    // keep に revisedSeverity を付けると拒否
    expect(
      adversarialVerdictSchema.safeParse({
        conversationId: "conv-1",
        verifierModel: "openai/gpt-6.2-sol",
        challengedFindings: [
          {
            draftId: "F1",
            verdict: "keep",
            reason: "実コードで再現手順と該当行を確認済み",
            evidence: [],
            revisedCategory: "bug",
            revisedSeverity: "major",
          },
        ],
        missedFindings: [],
        checkedFiles: [],
        auditNotes: "十分な長さの独立監査メモをここに記載する。",
      }).success,
    ).toBe(false);

    // 重複 draftId は拒否
    expect(
      adversarialVerdictSchema.safeParse({
        conversationId: "conv-1",
        verifierModel: "openai/gpt-6.2-sol",
        challengedFindings: [
          {
            draftId: "F1",
            verdict: "keep",
            reason: "実コードで問題を確認した根拠あり",
            evidence: [],
          },
          {
            draftId: "F1",
            verdict: "dismiss",
            reason: "重複する draftId のエントリは拒否",
            evidence: [],
          },
        ],
        missedFindings: [],
        checkedFiles: [],
        auditNotes: "十分な長さの独立監査メモをここに記載する。",
      }).success,
    ).toBe(false);
  });

  it("challengedFindingSchema の revise 異常系・revisedRemedy と missedFindingSchema 異常系を検証する", () => {
    // revise で revised* が 1 つも無い場合は拒否
    expect(
      challengedFindingSchema.safeParse({
        draftId: "F1",
        verdict: "revise",
        reason: "修正案が何も指定されていない revise は不可",
        evidence: [],
      }).success,
    ).toBe(false);

    // revisedCategory のみ片側指定は拒否
    expect(
      challengedFindingSchema.safeParse({
        draftId: "F1",
        verdict: "revise",
        reason: "カテゴリのみで深刻度が欠落している場合は拒否",
        evidence: [],
        revisedCategory: "risk",
      }).success,
    ).toBe(false);

    // 不正な revisedCategory × revisedSeverity は拒否
    expect(
      challengedFindingSchema.safeParse({
        draftId: "F1",
        verdict: "revise",
        reason: "bug と nit の不正な修正後組み合わせは拒否",
        evidence: [],
        revisedCategory: "bug",
        revisedSeverity: "nit",
      }).success,
    ).toBe(false);

    // revisedRemedy のみの revise は受理
    expect(
      challengedFindingSchema.safeParse({
        draftId: "F1",
        verdict: "revise",
        reason: "修正方針を既存の共通ヘルパー利用へ変更する",
        evidence: [],
        revisedRemedy: "parseModelRef を再利用して重複実装を削除する",
      }).success,
    ).toBe(true);

    // missedFindingSchema: 行範囲矛盾・空白のみ symbol・不正組み合わせを拒否
    expect(
      missedFindingSchema.safeParse({
        path: "src/a.ts",
        line: null,
        endLine: 5,
        category: "bug",
        severity: "major",
        title: "行範囲矛盾",
        body: "line が null で endLine あり",
        inChangedLines: true,
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      missedFindingSchema.safeParse({
        path: "src/a.ts",
        line: 5,
        symbol: "   ",
        category: "bug",
        severity: "major",
        title: "空白 symbol",
        body: "symbol が空白のみ",
        inChangedLines: true,
        evidence: [],
      }).success,
    ).toBe(false);
  });
});

describe("adjudicationResultSchema", () => {
  it("Decision 1 の usage.totalInputTokens と各種決定分岐を検証できる", () => {
    const parsed = adjudicationResultSchema.parse({
      decisions: [
        {
          draftId: "F1",
          decision: "dismiss",
          decidedBy: "deterministic_rule",
          ruleId: "D-01",
          dismissReason: "repro_contradicted",
          rationale: "verifyCompletionClaim の再実行で矛盾が確定した",
        },
        {
          draftId: "F2",
          decision: "accept",
          decidedBy: "gemini_decision_1",
          finalCategory: "bug",
          finalSeverity: "blocker",
          validProbability: 0.94,
          confidence: 0.91,
          rationale: "実コードの境界違反と再現テストで確定",
        },
      ],
      codeHealth: "request_changes",
      engine: "gemini_decision_1",
      usage: { totalInputTokens: 18420, batchCount: 1 },
    });

    expect(parsed.usage.totalInputTokens).toBe(18420);
    expect(codeHealthVerdictSchema.parse(parsed.codeHealth)).toBe("request_changes");
  });

  it("deterministic_rule の ruleId 欠落や不正 finalCategory×finalSeverity を拒否する", () => {
    expect(
      adjudicationResultSchema.safeParse({
        decisions: [
          {
            draftId: "F1",
            decision: "dismiss",
            decidedBy: "deterministic_rule",
            dismissReason: "out_of_scope_meta",
            rationale: "ruleId なしは拒否されるべき",
          },
        ],
        codeHealth: "approve",
        engine: "deterministic_only",
        usage: { totalInputTokens: 0 },
      }).success,
    ).toBe(false);

    expect(
      adjudicationResultSchema.safeParse({
        decisions: [
          {
            draftId: "F1",
            decision: "revise",
            decidedBy: "majority_vote",
            finalCategory: "nit",
            finalSeverity: "major",
            rationale: "nit に major は不可",
          },
        ],
        codeHealth: "comment",
        engine: "majority_vote",
        usage: { totalInputTokens: 0 },
      }).success,
    ).toBe(false);

    // 非 deterministic_rule に ruleId 付与・ruleId 形式違反・draftId 重複を拒否
    expect(
      adjudicationResultSchema.safeParse({
        decisions: [
          {
            draftId: "F1",
            decision: "accept",
            decidedBy: "gemini_decision_1",
            ruleId: "D-01",
            finalCategory: "bug",
            finalSeverity: "major",
            rationale: "Decision 1 裁定に ruleId は不要",
          },
        ],
        codeHealth: "request_changes",
        engine: "gemini_decision_1",
        usage: { totalInputTokens: 100 },
      }).success,
    ).toBe(false);

    expect(
      adjudicationResultSchema.safeParse({
        decisions: [
          {
            draftId: "F1",
            decision: "dismiss",
            decidedBy: "deterministic_rule",
            ruleId: "X-1",
            dismissReason: "out_of_scope_meta",
            rationale: "不正な ruleId 形式",
          },
        ],
        codeHealth: "approve",
        engine: "deterministic_only",
        usage: { totalInputTokens: 0 },
      }).success,
    ).toBe(false);

    expect(
      adjudicationResultSchema.safeParse({
        decisions: [
          {
            draftId: "F1",
            decision: "dismiss",
            decidedBy: "majority_vote",
            dismissReason: "majority_vote_rejected",
            rationale: "1 件目",
          },
          {
            draftId: "F1",
            decision: "needs_recheck",
            decidedBy: "fallback_llm_judge",
            finalCategory: "risk",
            finalSeverity: "minor",
            rationale: "重複 draftId",
          },
        ],
        codeHealth: "comment",
        engine: "fallback_llm_judge",
        usage: { totalInputTokens: 50 },
      }).success,
    ).toBe(false);
  });
});

describe("finalFindingSchema と Finding / ReviewRun 互換性", () => {
  it("nit / question は inChangedLines === false で拒否される（DraftFinding は許容）", () => {
    const draftNitOutOfDiff = draftFindingSchema.safeParse({
      draftId: "F9",
      path: "src/old.ts",
      line: 5,
      category: "nit",
      severity: "nit",
      title: "変更外ファイルの命名提案",
      body: "Step 4 D-02 で棄却される候補。",
      inChangedLines: false,
      evidence: [],
    });
    expect(draftNitOutOfDiff.success).toBe(true);

    const finalNitOutOfDiff = finalFindingSchema.safeParse({
      fingerprint: "fp-nit-out",
      path: "src/old.ts",
      line: 5,
      category: "nit",
      severity: "nit",
      title: "変更外ファイルの命名提案",
      body: "最終確定指摘では禁止。",
      inChangedLines: false,
      evidence: [
        {
          kind: "code_reference",
          summary: "確認箇所",
          path: "src/old.ts",
          line: 5,
          harnessVerification: "not_applicable",
        },
      ],
    });
    expect(finalNitOutOfDiff.success).toBe(false);

    const finalQuestionOutOfDiff = finalFindingSchema.safeParse({
      fingerprint: "fp-q-out",
      path: "src/old.ts",
      line: 5,
      category: "question",
      severity: "nit",
      title: "変更外の確認質問",
      body: "最終確定指摘では禁止。",
      inChangedLines: false,
      evidence: [
        {
          kind: "code_reference",
          summary: "確認箇所",
          path: "src/old.ts",
          line: 5,
          harnessVerification: "not_applicable",
        },
      ],
    });
    expect(finalQuestionOutOfDiff.success).toBe(false);
  });

  it("FinalFinding は既存 Finding へ代入互換であり ReviewRun 拡張も後方互換である", () => {
    const finalFinding = finalFindingSchema.parse({
      fingerprint: "fp-final-1",
      path: "src/calc.ts",
      line: 10,
      endLine: 15,
      symbol: "calcDiscount",
      category: "bug",
      severity: "major",
      title: "ゼロ除算の可能性",
      body: "divisor が 0 のときに Infinity になる。",
      remedy: "divisor === 0 を早期ガードする。",
      inChangedLines: true,
      evidence: [
        {
          kind: "code_reference",
          summary: "10 行目で未検証の除算を確認",
          path: "src/calc.ts",
          line: 10,
          harnessVerification: "not_applicable",
        },
      ],
      sourceDraftIds: ["F1"],
    });

    // exactOptionalPropertyTypes: true 下での構造的代入互換を型レベルで検証
    const asLegacyFinding: Finding = finalFinding;
    expect(asLegacyFinding.fingerprint).toBe("fp-final-1");

    const run = reviewRunSchema.parse({
      runId: "run-1",
      iteration: 1,
      headSha: "abc1234",
      stage: "completed",
      costUsd: 0.42,
      codeHealth: "request_changes",
      findings: [asLegacyFinding],
    });
    expect(run.stage).toBe("completed");
    expect(run.costUsd).toBe(0.42);
  });
});
