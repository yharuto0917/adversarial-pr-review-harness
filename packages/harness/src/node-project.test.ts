import { describe, expect, it, vi } from "vitest";

import { detectNodeProject, setupNodeProject } from "./node-project.js";
import type { SandboxPort } from "./ports.js";

function createFakeSandbox(
  files: Record<string, string>,
  execExitCode = 0,
): {
  sandbox: SandboxPort;
  executed: string[];
} {
  const executed: string[] = [];
  const sandbox: SandboxPort = {
    listFiles: vi.fn(async () => Object.keys(files)),
    readFile: vi.fn(async (path: string) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    }),
    writeFile: vi.fn(async () => {}),
    exec: vi.fn(async (command: string) => {
      executed.push(command);
      return execExitCode === 0
        ? { stdout: "done", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "ERR_PNPM_FETCH_404", exitCode: execExitCode };
    }),
  };
  return { sandbox, executed };
}

describe("detectNodeProject", () => {
  it("packageManager フィールドが指定されていれば指定バージョンを corepack 経由で起動し、lockfile の有無に応じてインストールコマンドを決める", () => {
    const pkg = JSON.stringify({
      name: "sample",
      packageManager: "pnpm@11.25.0",
      scripts: {
        test: "vitest run",
        "test:unit": "vitest run src/unit",
        "test:watch": "vitest",
        typecheck: "tsc --noEmit",
      },
    });

    expect(detectNodeProject(pkg, ["package.json", "pnpm-lock.yaml"])).toEqual({
      packageManager: "pnpm",
      installCommand: "corepack pnpm@11.25.0 install --frozen-lockfile",
      testCommands: [
        "corepack pnpm@11.25.0 test",
        "corepack pnpm@11.25.0 run test:unit",
        "corepack pnpm@11.25.0 run typecheck",
      ],
    });

    expect(detectNodeProject(pkg, ["package.json"])).toEqual({
      packageManager: "pnpm",
      installCommand: "corepack pnpm@11.25.0 install",
      testCommands: [
        "corepack pnpm@11.25.0 test",
        "corepack pnpm@11.25.0 run test:unit",
        "corepack pnpm@11.25.0 run typecheck",
      ],
    });
  });

  it("Yarn 4 やハッシュ付きの packageManager 指定でもバージョンを保持して起動コマンドを組み立てる", () => {
    const pkg = JSON.stringify({
      name: "yarn4-sample",
      packageManager: "yarn@4.5.0+sha512.837566d24eec14ec0f5f1411adb544e892b3454255e61fdef8fd",
      scripts: {
        test: "jest",
        "test:integration": "jest --selectProjects integration",
      },
    });

    expect(detectNodeProject(pkg, ["package.json", "yarn.lock"])).toEqual({
      packageManager: "yarn",
      installCommand: "corepack yarn@4.5.0 install --frozen-lockfile",
      testCommands: ["corepack yarn@4.5.0 test", "corepack yarn@4.5.0 run test:integration"],
    });
  });

  it("packageManager フィールドに不正なバージョン文字列が含まれる場合はエラーを投げる", () => {
    const pkg = JSON.stringify({
      name: "bad",
      packageManager: "yarn@4.5.0; rm -rf /",
    });

    expect(() => detectNodeProject(pkg, ["package.json"])).toThrow(
      /invalid packageManager version in package\.json/,
    );
  });

  it("packageManager フィールドが無い場合は lockfile から pnpm / yarn / npm を判定する", () => {
    const pkg = JSON.stringify({
      name: "sample",
      scripts: { test: "jest", lint: "eslint ." },
    });

    expect(detectNodeProject(pkg, ["package.json", "pnpm-lock.yaml"])).toEqual({
      packageManager: "pnpm",
      installCommand: "pnpm install --frozen-lockfile",
      testCommands: ["pnpm test", "pnpm run lint"],
    });

    expect(detectNodeProject(pkg, ["package.json", "yarn.lock"])).toEqual({
      packageManager: "yarn",
      installCommand: "yarn install --frozen-lockfile",
      testCommands: ["yarn test", "yarn run lint"],
    });

    expect(detectNodeProject(pkg, ["package.json", "package-lock.json"])).toEqual({
      packageManager: "npm",
      installCommand: "npm ci",
      testCommands: ["npm test", "npm run lint"],
    });

    expect(detectNodeProject(pkg, ["package.json", "npm-shrinkwrap.json"])).toEqual({
      packageManager: "npm",
      installCommand: "npm ci",
      testCommands: ["npm test", "npm run lint"],
    });
  });

  it("packageManager も lockfile も無い場合は npm install にフォールバックし、npm init 既定のダミー test は除外する", () => {
    const pkg = JSON.stringify({
      name: "sample",
      scripts: {
        test: 'echo "Error: no test specified" && exit 1',
        check: "biome check .",
      },
    });

    expect(detectNodeProject(pkg, ["package.json"])).toEqual({
      packageManager: "npm",
      installCommand: "npm install",
      testCommands: ["npm run check"],
    });
  });

  it("watch 系スクリプトやシェルメタ文字を含む不正なスクリプト名は候補から除外する", () => {
    const pkg = JSON.stringify({
      name: "sample",
      scripts: {
        test: "vitest run",
        "test:watch:unit": "vitest",
        "test:evil; rm -rf /": "echo nope",
        "test:e2e": "playwright test",
      },
    });

    expect(detectNodeProject(pkg, ["package.json", "pnpm-lock.yaml"]).testCommands).toEqual([
      "pnpm test",
      "pnpm run test:e2e",
    ]);
  });

  it("不正な JSON の場合は意味のあるエラーメッセージを投げる", () => {
    expect(() => detectNodeProject("{broken", ["package.json"])).toThrow(
      /failed to parse package\.json/,
    );
  });
});

describe("setupNodeProject", () => {
  it("ルートに package.json が無ければ exec を呼ばずにスキップする", async () => {
    const { sandbox, executed } = createFakeSandbox({ "README.md": "# hello" });

    const result = await setupNodeProject(sandbox);

    expect(result).toEqual({ detected: false, testCommands: [] });
    expect(executed).toEqual([]);
  });

  it("package.json があれば依存インストールコマンドを実行し、テストコマンド候補を返す", async () => {
    const { sandbox, executed } = createFakeSandbox({
      "package.json": JSON.stringify({
        name: "app",
        scripts: { test: "vitest run", typecheck: "tsc -p tsconfig.json" },
      }),
      "yarn.lock": "# yarn lockfile v1",
    });

    const result = await setupNodeProject(sandbox);

    expect(result).toEqual({
      detected: true,
      packageManager: "yarn",
      installCommand: "yarn install --frozen-lockfile",
      testCommands: ["yarn test", "yarn run typecheck"],
    });
    expect(executed).toEqual(["yarn install --frozen-lockfile"]);
  });

  it("依存インストールが非0で失敗した場合はコマンド名と出力を含むエラーを投げる", async () => {
    const { sandbox } = createFakeSandbox(
      {
        "package.json": JSON.stringify({ name: "app", packageManager: "pnpm@11.25.0" }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      },
      1,
    );

    await expect(setupNodeProject(sandbox)).rejects.toThrow(
      'failed to install dependencies with "corepack pnpm@11.25.0 install --frozen-lockfile" (exit 1): ERR_PNPM_FETCH_404',
    );
  });
});
