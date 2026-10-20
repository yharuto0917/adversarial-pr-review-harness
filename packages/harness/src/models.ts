import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export interface ReviewModelsOptions {
  /** 保存済みの認証情報。ここに無いプロバイダは `env` の API キーにフォールバックする。 */
  readonly credentials: CredentialStore;
  /** API キーを引く環境変数（`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENCODE_API_KEY` / `OPENROUTER_API_KEY` など）の参照先。 */
  readonly env: (name: string) => string | undefined;
}

/** レビューに使えるプロバイダを登録した Models を作る。 */
export function createReviewModels(options: ReviewModelsOptions): MutableModels {
  const models = createModels({
    credentials: options.credentials,
    authContext: {
      env: async (name) => options.env(name),
      // 認証情報をファイルから読む経路（gcloud ADC など）は使わない
      fileExists: async () => false,
    },
  });
  models.setProvider(openaiProvider());
  models.setProvider(googleProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(opencodeProvider());
  models.setProvider(openrouterProvider());
  return models;
}

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

/** `openai/gpt-6-sol` のような `<provider>/<model id>` 表記を分解する。 */
export function parseModelRef(value: string): ModelRef {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`model must be "<provider>/<model id>": ${value}`);
  }
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}
