import { WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { ExecResult, SandboxService } from "@repo/harness";

/**
 * レビュー実行用の Sandbox サブクラス。
 * Container を持つ Durable Object なので、Worker エントリから re-export する。
 *
 * TODO: 外向き通信を監査するため HTTPS インターセプトを有効化する
 *       (@cloudflare/sandbox 0.12.9 の公開型には該当 API が無いため、
 *        採用するバージョンで API を確認してから実装する)
 */
export class ReviewSandbox extends Sandbox {}

export interface RunnerEnv {
  readonly Sandbox: DurableObjectNamespace<ReviewSandbox>;
}

/**
 * gateway の Durable Object から service binding 経由で呼ばれる RPC の入口。
 * Pi のツール（exec / read_file / write_file / list_files）の実体がここになる。
 */
export class SandboxEntrypoint extends WorkerEntrypoint<RunnerEnv> implements SandboxService {
  async exec(sandboxId: string, command: string): Promise<ExecResult> {
    const { stdout, stderr, exitCode } = await this.#sandbox(sandboxId).exec(command);
    return { stdout, stderr, exitCode };
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const file = await this.#sandbox(sandboxId).readFile(path);
    return file.content;
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await this.#sandbox(sandboxId).writeFile(path, content);
  }

  async listFiles(sandboxId: string, path: string): Promise<string[]> {
    const listing = await this.#sandbox(sandboxId).listFiles(path);
    return listing.files.map((file) => file.name);
  }

  #sandbox(sandboxId: string) {
    // DurableObjectId.toString() は 64 文字だが、@cloudflare/sandbox は
    // DNS ラベル長に合わせて 63 文字までしか受け付けない。
    return getSandbox(this.env.Sandbox, sandboxId.slice(0, 63), { normalizeId: true });
  }
}

export default {
  // 公開する HTTP の口は無い。呼び出しはすべて SandboxEntrypoint への RPC で受ける
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<RunnerEnv>;
