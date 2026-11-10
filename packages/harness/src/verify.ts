import { detectNodeProject } from "./node-project.js";
import type { ExecResult, SandboxPort } from "./ports.js";

export type ClaimExpectation = "passed" | "reproduced";

export interface VerifyCompletionOptions {
  /** 実行する検証コマンド。省略時は宣言文からの抽出、またはプロジェクト設定から自動検出する。 */
  readonly commands?: readonly string[];
  /** 宣言の期待種別。省略時は宣言文から判定する。 */
  readonly expectation?: ClaimExpectation;
  /** 出力（stdout / stderr）に含まれるべき文字列または正規表現。 */
  readonly expectedOutput?: string | RegExp;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly evidence: readonly string[];
}

const MAX_EVIDENCE_OUTPUT_LENGTH = 500;
const SHELL_META_CHARS = /[;&|`$><\r\n\\]/;

const SAFE_COMMAND_PATTERN =
  /^(?:(?:(?:corepack\s+)?(?:pnpm|yarn|npm)(?:@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)?\s+(?:test|run\s+[A-Za-z0-9_.:-]+)|(?:npx|pnpx|bunx)\s+(?:vitest|jest|mocha|ava|tsc)|(?:vitest|jest|mocha|pytest|cargo\s+test|go\s+test|bun\s+test|deno\s+test))(?:\s+[A-Za-z0-9_./:@=-]+)*|(?:(?:npx|pnpx|bunx)\s+tsx|node)(?:\s+[A-Za-z0-9_./:@=-]+)+)$/;

const PASSED_PATTERNS: readonly RegExp[] = [
  /テスト(?:が|は|も)?(?:すべて|全て|全部)?(?:通った|通りました|(?:通過|成功|パス)(?:した|しました|している|しています|を確認))/,
  /(?:すべて|全て|全部)の?テスト(?:が|は)?(?:通った|通りました|(?:通過|成功|パス)(?:した|しました|している|しています|を確認))/,
  /(?<!再現)(?<!失敗が)(?<!エラーが)(?:通った|通りました|(?:通過|成功|パス)(?:した|しました))(?!なかった)/,
  /問題(?:なく(?:完了|終了|通過|動作)|なし|はありません|ありません)/,
  /正常に(?:完了|終了|通過|動作)(?:した|しました|している|しています)/,
  /(?<!not\s)(?<!never\s)\b(?:all\s+)?tests?\s+(?:passed|pass|succeeded|succeed)\b/i,
  /(?<!not\s)\bpassed\s+all\s+tests?\b/i,
];

const EXIT_ZERO_PATTERN = /\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?0\b/i;

const REPRODUCED_DIRECT_PATTERNS: readonly RegExp[] = [
  /再現(?:した|しました|できた|できました|を確認|することを確認|テストが失敗)(?!しなかった|できなかった)/,
  /(?:失敗|エラー|例外|クラッシュ|落ちる|落ちた)(?:した|しました|することを確認|を確認|が発生|になる|になった|を再現)/,
  /テスト(?:が|は|も)?(?:失敗|落ちた|落ちました)/,
  /(?<!not\s)(?<!never\s)\b(?:reproduced|reproduces|reproduction\s+(?:succeeded|confirmed))\b/i,
  /(?<!not\s)\btests?\s+(?:failed|fails|failing)\b/i,
  /\bfails?\s+with\b/i,
  /\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]\d*\b/i,
];

const HEDGED_PATTERN =
  /確認(?:でき(?:なかった|ない|ません|ませんでした)|できず)|かどうか|(?:とは|とも)限らない|不明|わからない|分からない|未確認|確証(?:が|は)ない|\b(?:not\s+all\s+tests?\s+(?:passed|pass|succeeded|succeed)|unclear|unknown|unsure|not\s+sure|(?:cannot|could\s+not|unable\s+to)\s+(?:confirm|verify))\b/i;

const NEGATED_REPRODUCED_PATTERN =
  /再現(?:しなかった|しない|しません|できなかった|できない|できません|せず)|\b(?:not|never|cannot|could\s+not)\s+reproduce(?:d)?\b/i;

const NEGATED_PASSED_PATTERN =
  /通らなかった|通らない|(?:通過|成功|パス)(?:しなかった|しない|しません|せず)|\btests?\s+did\s+not\s+(?:pass|succeed)\b/i;

const TYPECHECK_MENTION_PATTERN = /type-?check|\btsc\b|型チェック|型検査/i;
const LINT_MENTION_PATTERN = /\blint(?:ing)?\b|\beslint\b|\bbiome\s+lint\b|リント/i;
const CHECK_MENTION_PATTERN = /\bcheck(?::ci)?\b|\bbiome\s+check\b/i;

/**
 * 宣言文からモデルが主張している期待結果（「テストが通った」か「問題が再現した」か）を判定する。
 * どちらとも判別できない場合や、不確実な表現・双方の主張が矛盾して含まれる場合は `null` を返す。
 */
export function classifyClaim(claim: string): ClaimExpectation | null {
  const stripped = claim.replace(/`[^`]*`/g, " ").trim();
  if (stripped.length === 0) {
    return null;
  }

  if (HEDGED_PATTERN.test(stripped)) {
    return null;
  }

  const hasNegatedPassed = NEGATED_PASSED_PATTERN.test(stripped);
  const hasNegatedReproduced = NEGATED_REPRODUCED_PATTERN.test(stripped);

  const withoutNegatedPassed = stripped.replace(
    new RegExp(NEGATED_PASSED_PATTERN.source, "gi"),
    " ",
  );
  const withoutNegatedReproduced = stripped.replace(
    new RegExp(NEGATED_REPRODUCED_PATTERN.source, "gi"),
    " ",
  );

  const hasExplicitPassed =
    PASSED_PATTERNS.some((pattern) => pattern.test(withoutNegatedPassed)) ||
    (!hasNegatedPassed && !hasNegatedReproduced && EXIT_ZERO_PATTERN.test(stripped));

  const hasDirectReproduced = REPRODUCED_DIRECT_PATTERNS.some((pattern) =>
    pattern.test(withoutNegatedReproduced),
  );

  if (hasExplicitPassed && hasNegatedPassed) {
    return null;
  }
  if (hasDirectReproduced && hasNegatedReproduced) {
    return null;
  }

  const matchesPassed = !hasNegatedPassed && hasExplicitPassed;
  const matchesReproduced = !hasNegatedReproduced && (hasDirectReproduced || hasNegatedPassed);

  if (matchesPassed && matchesReproduced) {
    return null;
  }
  if (matchesReproduced) {
    return "reproduced";
  }
  if (matchesPassed) {
    return "passed";
  }
  return null;
}

/**
 * 宣言文中のインラインコード（`` `...` ``）から、安全に実行可能なテスト・検証コマンドを抽出する。
 */
export function extractClaimCommands(claim: string): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  const regex = /`([^`]+)`/g;

  for (const match of claim.matchAll(regex)) {
    const candidate = match[1]?.trim() ?? "";
    if (candidate.length === 0 || !isSafeVerificationCommand(candidate)) {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      commands.push(candidate);
    }
  }

  return commands;
}

/**
 * モデルの「テストが通った」「再現した」という宣言を、
 * サンドボックス上の客観的な事実（終了コードや出力）で検証する。
 */
export async function verifyCompletionClaim(
  sandbox: SandboxPort,
  claim: string,
  options: VerifyCompletionOptions = {},
): Promise<VerificationResult> {
  if (claim.trim().length === 0) {
    return {
      passed: false,
      evidence: ["claim is empty"],
    };
  }

  const expectation = options.expectation ?? classifyClaim(claim);
  if (!expectation) {
    return {
      passed: false,
      evidence: [
        "could not determine claim expectation (neither clearly 'passed' nor 'reproduced')",
      ],
    };
  }

  const evidence: string[] = [`claim expectation: ${expectation}`];

  const resolved = await resolveVerificationCommands(sandbox, claim, options.commands);
  if (!resolved.ok) {
    return {
      passed: false,
      evidence: [...evidence, resolved.reason],
    };
  }

  const executions: Array<{ readonly command: string; readonly result: ExecResult }> = [];
  for (const command of resolved.commands) {
    const result = await sandbox.exec(command);
    executions.push({ command, result });
    evidence.push(formatExecutionEvidence(command, result));
  }

  let passed = true;

  if (expectation === "passed") {
    for (const { command, result } of executions) {
      if (result.exitCode !== 0) {
        passed = false;
        evidence.push(
          `mismatch: claim states tests passed, but "${command}" exited with code ${result.exitCode}`,
        );
      }
    }
  } else {
    const anyFailed = executions.some(({ result }) => result.exitCode !== 0);
    if (!anyFailed) {
      passed = false;
      evidence.push(
        "mismatch: claim states issue was reproduced, but all verification commands exited with code 0",
      );
    }
  }

  if (options.expectedOutput !== undefined) {
    const combinedOutput = executions
      .map(({ result }) => [result.stdout, result.stderr].filter(Boolean).join("\n"))
      .join("\n");
    if (!matchesExpectedOutput(combinedOutput, options.expectedOutput)) {
      passed = false;
      evidence.push(
        `mismatch: expected output ${formatExpectedOutput(options.expectedOutput)} was not found in command output`,
      );
    }
  }

  return {
    passed,
    evidence,
  };
}

function isSafeVerificationCommand(command: string): boolean {
  if (SHELL_META_CHARS.test(command)) {
    return false;
  }
  return SAFE_COMMAND_PATTERN.test(command);
}

type ResolvedCommands =
  | { readonly ok: true; readonly commands: readonly string[] }
  | { readonly ok: false; readonly reason: string };

async function resolveVerificationCommands(
  sandbox: SandboxPort,
  claim: string,
  explicitCommands: readonly string[] | undefined,
): Promise<ResolvedCommands> {
  if (explicitCommands !== undefined) {
    if (explicitCommands.length === 0) {
      return { ok: false, reason: "no verification command was provided in options.commands" };
    }
    const normalized: string[] = [];
    for (const raw of explicitCommands) {
      const trimmed = raw.trim();
      if (trimmed.length === 0 || !isSafeVerificationCommand(trimmed)) {
        return {
          ok: false,
          reason: `rejected unsafe or empty verification command: "${raw}"`,
        };
      }
      normalized.push(trimmed);
    }
    return { ok: true, commands: normalized };
  }

  const fromClaim = extractClaimCommands(claim);
  if (fromClaim.length > 0) {
    return { ok: true, commands: fromClaim };
  }

  try {
    const rootFiles = await sandbox.listFiles(".");
    const normalizedFiles = rootFiles.map((file) => file.replace(/^\.\//, ""));
    if (normalizedFiles.includes("package.json")) {
      const packageJsonContent = await sandbox.readFile("package.json");
      const project = detectNodeProject(packageJsonContent, normalizedFiles);
      const selectedCommands = filterProjectVerificationCommands(project.testCommands, claim);
      if (selectedCommands.length > 0) {
        return { ok: true, commands: selectedCommands };
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `failed to inspect project: ${reason}`,
    };
  }

  return {
    ok: false,
    reason: "no verification command could be determined from claim or project",
  };
}

function filterProjectVerificationCommands(
  testCommands: readonly string[],
  claim: string,
): string[] {
  const includeTypecheck = TYPECHECK_MENTION_PATTERN.test(claim);
  const includeLint = LINT_MENTION_PATTERN.test(claim);
  const includeCheck = CHECK_MENTION_PATTERN.test(claim);

  return testCommands.filter((command) => {
    if (command.endsWith(" test") || /\srun\s+test:/.test(command)) {
      return true;
    }
    if (command.endsWith(" run typecheck") || command.endsWith(" run type-check")) {
      return includeTypecheck;
    }
    if (command.endsWith(" run lint")) {
      return includeLint;
    }
    if (command.endsWith(" run check") || command.endsWith(" run check:ci")) {
      return includeCheck;
    }
    return false;
  });
}

function formatExecutionEvidence(command: string, result: ExecResult): string {
  const parts = [`command: ${command} (exit code: ${result.exitCode})`];
  const stdout = truncateOutput(result.stdout.trim());
  const stderr = truncateOutput(result.stderr.trim());
  if (stdout.length > 0) {
    parts.push(`stdout: ${stdout}`);
  }
  if (stderr.length > 0) {
    parts.push(`stderr: ${stderr}`);
  }
  return parts.join("\n");
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_EVIDENCE_OUTPUT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_EVIDENCE_OUTPUT_LENGTH)}...`;
}

function matchesExpectedOutput(output: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") {
    return output.includes(expected);
  }
  const flags = expected.flags.replace(/[gy]/g, "");
  return new RegExp(expected.source, flags).test(output);
}

function formatExpectedOutput(expected: string | RegExp): string {
  return typeof expected === "string" ? `"${expected}"` : String(expected);
}
