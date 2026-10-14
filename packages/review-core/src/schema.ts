import { z } from "zod";

/** 指摘の深刻度。収束判定の重み付けに使う。 */
export const severitySchema = z.enum(["blocker", "major", "minor", "nit"]);
export type Severity = z.infer<typeof severitySchema>;

/** レビュー 1 件の指摘。fingerprint で世代をまたいだ同一性を判定する。 */
export const findingSchema = z.object({
  fingerprint: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  severity: severitySchema,
  title: z.string().min(1),
  body: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

/** 1 イテレーション分のレビュー実行結果。 */
export const reviewRunSchema = z.object({
  runId: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  headSha: z.string().min(1),
  findings: z.array(findingSchema),
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;

/** ループを継続するか打ち切るかの判定結果。 */
export const verdictSchema = z.object({
  status: z.enum(["converged", "continue", "oscillating", "budget_exhausted"]),
  reason: z.string(),
});
export type Verdict = z.infer<typeof verdictSchema>;
