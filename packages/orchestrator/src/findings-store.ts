import type { FindingDraft } from "@repo/harness";

export interface RecordedFinding extends FindingDraft {
  /** この指摘を報告したレビュー実行。 */
  readonly operationId: string;
}

/** モデルが報告した指摘を Durable Object の SQLite に貯める。 */
export class SqlFindingsStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS review_findings (
      operation_id TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    )`);
    // 中断後の再実行で同じ報告が来ても 1 件に保つ。line は NULL になりうるので COALESCE で潰す
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS review_findings_identity
      ON review_findings (operation_id, path, COALESCE(line, 0), title)`);
  }

  record(operationId: string, finding: FindingDraft): void {
    this.#sql.exec(
      `INSERT OR IGNORE INTO review_findings (operation_id, path, line, severity, title, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
      operationId,
      finding.path,
      finding.line,
      finding.severity,
      finding.title,
      finding.body,
    );
  }

  list(operationId: string): RecordedFinding[] {
    return this.#sql
      .exec<{
        operation_id: string;
        path: string;
        line: number | null;
        severity: FindingDraft["severity"];
        title: string;
        body: string;
      }>(
        `SELECT operation_id, path, line, severity, title, body FROM review_findings
         WHERE operation_id = ? ORDER BY rowid`,
        operationId,
      )
      .toArray()
      .map((row) => ({
        operationId: row.operation_id,
        path: row.path,
        line: row.line,
        severity: row.severity,
        title: row.title,
        body: row.body,
      }));
  }
}
