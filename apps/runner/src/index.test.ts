import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxStub = {
  exec: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listFiles: vi.fn(),
};
const getSandboxMock = vi.fn((..._args: unknown[]) => sandboxStub);

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_ctx?: unknown, env?: unknown) {
      this.env = env;
    }
  },
}));

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox: (...args: unknown[]) => getSandboxMock(...args),
}));

const { SandboxEntrypoint } = await import("./index.js");

describe("SandboxEntrypoint", () => {
  const namespace = {} as Env["Sandbox"];
  const entrypoint = new SandboxEntrypoint({} as ExecutionContext, { Sandbox: namespace });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writeFile / readFile / listFiles / exec を Sandbox に委譲し、戻り値を SandboxService の形に整える", async () => {
    sandboxStub.writeFile.mockResolvedValue({ success: true, path: "repro.txt" });
    sandboxStub.readFile.mockResolvedValue({
      success: true,
      path: "repro.txt",
      content: "hello",
    });
    sandboxStub.listFiles.mockResolvedValue({
      success: true,
      path: ".",
      files: [{ name: "repro.txt" }, { name: "README.md" }],
    });
    sandboxStub.exec.mockResolvedValue({
      success: true,
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });

    await entrypoint.writeFile("sandbox-1", "repro.txt", "hello");
    const content = await entrypoint.readFile("sandbox-1", "repro.txt");
    const files = await entrypoint.listFiles("sandbox-1", ".");
    const execResult = await entrypoint.exec("sandbox-1", "cat repro.txt");

    expect(content).toBe("hello");
    expect(files).toEqual(["repro.txt", "README.md"]);
    expect(execResult).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });
  });

  it("64 文字の DurableObjectId を @cloudflare/sandbox の上限である 63 文字に切り詰めて渡す", async () => {
    sandboxStub.listFiles.mockResolvedValue({ success: true, path: ".", files: [] });
    const durableObjectId = "a".repeat(64);

    await entrypoint.listFiles(durableObjectId, ".");

    expect(getSandboxMock).toHaveBeenCalledWith(namespace, "a".repeat(63), {
      normalizeId: true,
    });
  });
});
