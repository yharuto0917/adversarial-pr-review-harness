import { SEVERITY_ORDER } from "./gate.js";

/** ゴールデン PR を replay して回帰を検出する CLI エントリ。 */
async function main(): Promise<void> {
  console.log(`@repo/eval: replay gate scaffold (severities: ${SEVERITY_ORDER.join(" > ")})`);
}

await main();
