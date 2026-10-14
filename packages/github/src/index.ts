/** GitHub App の installation token 発行まわりの薄いラッパ。 */

export interface AppCredentials {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId: number;
}

/**
 * installation access token を発行する。
 * TODO: 実装。
 */
export function issueInstallationToken(_credentials: AppCredentials): Promise<string> {
  throw new Error("not implemented: issueInstallationToken");
}

/**
 * webhook の署名（X-Hub-Signature-256）を検証する。
 * TODO: 実装。
 */
export function verifyWebhookSignature(
  _payload: string,
  _signature: string,
  _secret: string,
): Promise<boolean> {
  throw new Error("not implemented: verifyWebhookSignature");
}
