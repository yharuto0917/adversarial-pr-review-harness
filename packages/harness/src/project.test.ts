import { describe, expect, it, vi } from "vitest";

import type { SandboxPort } from "./ports.js";
import { detectProjects, inspectProject, setupProject } from "./project.js";

function createFakeSandbox(
  files: Record<string, string>,
  execHandler?: (command: string) => {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
  },
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
      if (execHandler) {
        return execHandler(command);
      }
      return { stdout: "done", stderr: "", exitCode: 0 };
    }),
  };
  return { sandbox, executed };
}

describe("detectProjects", () => {
  it("Python (pyproject.toml + uv.lock) を検出し、uv sync --frozen とオフライン実行コマンド候補を返す", () => {
    const pyproject = `
[project]
name = "sample-py"
version = "0.1.0"
dependencies = []

[dependency-groups]
dev = ["pytest>=8.0", "ruff>=0.6", "mypy>=1.11"]
`;
    const result = detectProjects(["pyproject.toml", "uv.lock", "src"], {
      pyprojectToml: pyproject,
    });

    expect(result).toEqual({
      detected: true,
      projects: [
        {
          ecosystem: "python",
          tool: "uv",
          installCommand: "uv sync --frozen",
          testCommands: [
            "uv run --offline --no-sync pytest",
            "uv run --offline --no-sync ruff check .",
            "uv run --offline --no-sync mypy .",
          ],
        },
      ],
      testCommands: [
        "uv run --offline --no-sync pytest",
        "uv run --offline --no-sync ruff check .",
        "uv run --offline --no-sync mypy .",
      ],
    });
  });

  it("Python (pyproject.toml のみで pytest 未記載) は uv sync と unittest 候補を返す", () => {
    const pyproject = `
[project]
name = "minimal-py"
version = "0.1.0"
`;
    const result = detectProjects(["./pyproject.toml"], { pyprojectToml: pyproject });

    expect(result).toEqual({
      detected: true,
      projects: [
        {
          ecosystem: "python",
          tool: "uv",
          installCommand: "uv sync",
          testCommands: ["uv run --offline --no-sync python -m unittest"],
        },
      ],
      testCommands: ["uv run --offline --no-sync python -m unittest"],
    });
  });

  it("Python (requirements.txt + requirements-dev.txt) は uv venv / uv pip install と .venv/bin コマンドを返す", () => {
    const result = detectProjects(["requirements.txt", "requirements-dev.txt", "conftest.py"], {
      requirementsFiles: {
        "requirements.txt": "fastapi==0.115.0\n",
        "requirements-dev.txt": "pytest==8.3.0\nruff==0.7.0\n",
      },
    });

    expect(result).toEqual({
      detected: true,
      projects: [
        {
          ecosystem: "python",
          tool: "uv",
          installCommand:
            "uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt -r requirements-dev.txt",
          testCommands: [".venv/bin/pytest", ".venv/bin/ruff check ."],
        },
      ],
      testCommands: [".venv/bin/pytest", ".venv/bin/ruff check ."],
    });
  });

  it("pyproject.toml に [project] が無く requirements.txt がある場合は requirements を優先する", () => {
    const result = detectProjects(["pyproject.toml", "requirements.txt", "pytest.ini"], {
      pyprojectToml: "[tool.ruff]\nline-length = 100\n",
      requirementsFiles: {
        "requirements.txt": "requests>=2.32\n",
      },
    });

    expect(result).toEqual({
      detected: true,
      projects: [
        {
          ecosystem: "python",
          tool: "uv",
          installCommand:
            "uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt",
          testCommands: [".venv/bin/pytest", ".venv/bin/ruff check ."],
        },
      ],
      testCommands: [".venv/bin/pytest", ".venv/bin/ruff check ."],
    });
  });

  it("pyproject.toml が [build-system] のみを持つ場合は editable install を選ぶ", () => {
    const result = detectProjects(["pyproject.toml"], {
      pyprojectToml: '[build-system]\nrequires = ["setuptools"]\n',
    });

    expect(result.projects).toEqual([
      {
        ecosystem: "python",
        tool: "uv",
        installCommand: "uv venv .venv && uv pip install --python .venv/bin/python -e .",
        testCommands: [".venv/bin/python -m unittest"],
      },
    ]);
  });

  it("pyproject.toml に [project] / [build-system] / requirements いずれも無い場合は uv venv のみ行う", () => {
    const result = detectProjects(["pyproject.toml"], {
      pyprojectToml: "[tool.mypy]\nstrict = true\n",
    });

    expect(result.projects).toEqual([
      {
        ecosystem: "python",
        tool: "uv",
        installCommand: "uv venv .venv",
        testCommands: [".venv/bin/python -m unittest", ".venv/bin/mypy ."],
      },
    ]);
  });

  it("Go (go.mod) を検出し、go mod download と go test / go vet 候補を返す", () => {
    const result = detectProjects(["go.mod", "go.sum", "main.go"]);

    expect(result).toEqual({
      detected: true,
      projects: [
        {
          ecosystem: "go",
          tool: "go",
          installCommand: "go mod download",
          testCommands: ["go test ./...", "go vet ./..."],
        },
      ],
      testCommands: ["go test ./...", "go vet ./..."],
    });
  });

  it("Rust (Cargo.toml) は Cargo.lock の有無に応じて cargo fetch --locked / cargo fetch を選ぶ", () => {
    const locked = detectProjects(["Cargo.toml", "Cargo.lock", "src"]);
    expect(locked).toEqual({
      detected: true,
      projects: [
        {
          ecosystem: "rust",
          tool: "cargo",
          installCommand: "cargo fetch --locked",
          testCommands: ["cargo test --offline", "cargo clippy --offline --all-targets"],
        },
      ],
      testCommands: ["cargo test --offline", "cargo clippy --offline --all-targets"],
    });

    const unlocked = detectProjects(["Cargo.toml", "src"]);
    expect(unlocked.projects[0]?.installCommand).toBe("cargo fetch");
  });

  it("複数言語が共存するリポジトリで全エコシステムを検出しテストコマンドを統合する", () => {
    const result = detectProjects(
      ["package.json", "pnpm-lock.yaml", "pyproject.toml", "uv.lock", "go.mod", "Cargo.toml"],
      {
        packageJson: JSON.stringify({
          name: "polyglot",
          scripts: { test: "vitest run" },
        }),
        pyprojectToml: '[project]\nname = "api"\ndependencies = ["pytest"]\n',
      },
    );

    expect(result.detected).toBe(true);
    expect(result.projects.map((p) => p.ecosystem)).toEqual(["node", "python", "go", "rust"]);
    expect(result.testCommands).toEqual([
      "pnpm test",
      "uv run --offline --no-sync pytest",
      "go test ./...",
      "go vet ./...",
      "cargo test --offline",
      "cargo clippy --offline --all-targets",
    ]);
  });

  it("対応マニフェストが無い場合は detected: false を返す", () => {
    expect(detectProjects(["README.md", "Makefile"])).toEqual({
      detected: false,
      projects: [],
      testCommands: [],
    });
  });
});

describe("inspectProject / setupProject", () => {
  it("対応マニフェストが無ければ exec を呼ばずにスキップする", async () => {
    const { sandbox, executed } = createFakeSandbox({ "README.md": "# docs" });

    const result = await setupProject(sandbox);

    expect(result).toEqual({ detected: false, projects: [], testCommands: [] });
    expect(executed).toEqual([]);
  });

  it("inspectProject はコマンドを実行せずに構成のみ検出する", async () => {
    const { sandbox, executed } = createFakeSandbox({
      "go.mod": "module example.com/app\n\ngo 1.24\n",
    });

    const result = await inspectProject(sandbox);

    expect(result.detected).toBe(true);
    expect(result.testCommands).toEqual(["go test ./...", "go vet ./..."]);
    expect(executed).toEqual([]);
  });

  it("複数エコシステムが共存する場合は順番に依存をインストールする", async () => {
    const { sandbox, executed } = createFakeSandbox({
      "pyproject.toml": '[project]\nname = "svc"\ndependencies = ["pytest"]\n',
      "uv.lock": "version = 1\n",
      "Cargo.toml": '[package]\nname = "core"\nversion = "0.1.0"\n',
      "Cargo.lock": "# lock\n",
    });

    const result = await setupProject(sandbox);

    expect(result.detected).toBe(true);
    expect(executed).toEqual(["uv sync --frozen", "cargo fetch --locked"]);
    expect(result.testCommands).toEqual([
      "uv run --offline --no-sync pytest",
      "cargo test --offline",
      "cargo clippy --offline --all-targets",
    ]);
  });

  it("依存インストールが非0終了した場合はコマンドと出力詳細を含むエラーを投げる", async () => {
    const { sandbox } = createFakeSandbox({ "go.mod": "module example.com/app\n" }, () => ({
      stdout: "",
      stderr: "go: example.com/missing@v1.0.0: 404 Not Found",
      exitCode: 1,
    }));

    await expect(setupProject(sandbox)).rejects.toThrow(
      'failed to install dependencies with "go mod download" (exit 1): go: example.com/missing@v1.0.0: 404 Not Found',
    );
  });

  it("依存インストールがタイムアウトした場合はタイムアウトを示すエラーを投げる", async () => {
    const { sandbox } = createFakeSandbox(
      { "Cargo.toml": '[package]\nname = "core"\n', "Cargo.lock": "" },
      () => ({
        stdout: "",
        stderr: "command timed out after 300000ms",
        exitCode: 124,
        timedOut: true,
      }),
    );

    await expect(setupProject(sandbox)).rejects.toThrow(
      'timed out while installing dependencies with "cargo fetch --locked" (exit 124): command timed out after 300000ms',
    );
  });
});
