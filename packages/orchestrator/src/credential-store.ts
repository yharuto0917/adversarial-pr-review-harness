import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * Durable Object の SQLite に認証情報を保存する CredentialStore。
 * OAuth のトークン更新は `modify` の中で走るため、同じプロバイダへの `modify` は直列化する。
 * 並行して更新すると、ローテーション済みのリフレッシュトークンを二重に使って失効させてしまう。
 */
export class SqlCredentialStore implements CredentialStore {
  readonly #sql: SqlStorage;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS credentials (provider_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.#get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.#sql
      .exec<{ provider_id: string; body: string }>("SELECT provider_id, body FROM credentials")
      .toArray()
      .map((row) => ({
        providerId: row.provider_id,
        type: (JSON.parse(row.body) as Credential).type,
      }));
  }

  /**
   * `fn` が undefined を返したら「変更なし」で、保存済みの内容はそのまま残す
   * （他の呼び出しが先に更新を済ませていた場合に pi-ai がそう返す）。
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#enqueue(providerId, async () => {
      const current = this.#get(providerId);
      const next = await fn(current);
      if (next !== undefined) {
        this.#sql.exec(
          "INSERT OR REPLACE INTO credentials (provider_id, body) VALUES (?, ?)",
          providerId,
          JSON.stringify(next),
        );
      }
      return next ?? current;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#enqueue(providerId, async () => {
      this.#sql.exec("DELETE FROM credentials WHERE provider_id = ?", providerId);
    });
  }

  /** 同じプロバイダへの操作を、前の操作が終わってから順に実行する。 */
  #enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(providerId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(task);
    this.#queues.set(providerId, queued);
    return queued;
  }

  #get(providerId: string): Credential | undefined {
    const row = this.#sql
      .exec<{ body: string }>("SELECT body FROM credentials WHERE provider_id = ?", providerId)
      .toArray()[0];
    return row ? (JSON.parse(row.body) as Credential) : undefined;
  }
}
