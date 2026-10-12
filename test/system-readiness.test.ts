/**
 * test/system-readiness.test.ts
 * Comprehensive unit and integration test suite for SystemReadinessService.
 * Validates Node.js engine boundary, Git/Antigravity probes (with Windows fallback paths),
 * Docker container mappings, Zero-Exposure OpenAI presence checks & masking,
 * concurrent refresh deduplication, and lifecycle cleanup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SystemReadinessService } from "../src/main/services/SystemReadinessService.js";
import { DockerStatusService } from "../src/main/services/DockerStatusService.js";
import type { DockerSandboxStatus } from "../src/shared/contracts.js";
import type { SystemReadinessSnapshot } from "../src/shared/systemReadiness.js";

class MockDockerStatusService extends DockerStatusService {
  private mockStatus: DockerSandboxStatus;
  private readonly mockListeners = new Set<(status: DockerSandboxStatus) => void>();

  constructor(initialStatus: DockerSandboxStatus) {
    super("mock_sandbox_container");
    this.mockStatus = initialStatus;
  }

  override getStatus(): DockerSandboxStatus {
    return this.mockStatus;
  }

  override async checkStatus(): Promise<DockerSandboxStatus> {
    return this.mockStatus;
  }

  override subscribe(listener: (status: DockerSandboxStatus) => void): () => void {
    this.mockListeners.add(listener);
    listener(this.mockStatus);
    return () => this.mockListeners.delete(listener);
  }

  setStatus(newStatus: DockerSandboxStatus): void {
    this.mockStatus = newStatus;
    for (const listener of this.mockListeners) {
      listener(newStatus);
    }
  }
}

test("SystemReadinessService: evaluates all 6 prerequisites as ready when local tools and credentials satisfy requirements", async () => {
  const mockDocker = new MockDockerStatusService("Active");

  const execMock = async (file: string) => {
    if (file === "git") {
      return { stdout: "git version 2.44.0.windows.1\n", stderr: "" };
    }
    if (file === "node") {
      return { stdout: "v22.11.0\n", stderr: "" };
    }
    if (file === "agy") {
      return { stdout: "1.3.3\n", stderr: "" };
    }
    if (file === "codegraph") {
      return { stdout: "1.0.1\n", stderr: "" };
    }
    throw new Error(`Unexpected binary: ${file}`);
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: { OPENAI_API_KEY: "sk-proj-1234567890abcdefAtoA" }
  });

  const snapshot = await service.refresh();

  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.prerequisites.length, 6);

  const git = snapshot.prerequisites.find((p) => p.id === "git");
  assert.equal(git?.state, "ready");
  assert.match(git?.version ?? "", /git 2\.44\.0/);

  const node = snapshot.prerequisites.find((p) => p.id === "node");
  assert.equal(node?.state, "ready");
  assert.equal(node?.version, "v22.11.0");

  const docker = snapshot.prerequisites.find((p) => p.id === "docker");
  assert.equal(docker?.state, "ready");
  assert.equal(docker?.version, "Container Active");

  const antigravity = snapshot.prerequisites.find((p) => p.id === "antigravity");
  assert.equal(antigravity?.state, "ready");
  assert.equal(antigravity?.version, "agy 1.3.3");

  const openai = snapshot.prerequisites.find((p) => p.id === "openai");
  assert.equal(openai?.state, "ready");
  assert.equal(openai?.maskedPreview, "sk-proj-****...****AtoA");
  assert.ok(!JSON.stringify(snapshot).includes("1234567890abcdef"), "Raw API key must never be serialized");

  const codegraph = snapshot.prerequisites.find((p) => p.id === "codegraph");
  assert.equal(codegraph?.state, "ready");
  assert.equal(codegraph?.version, "codegraph 1.0.1");

  // Verify stable prerequisite ordering
  assert.deepEqual(
    snapshot.prerequisites.map((p) => p.id),
    ["git", "node", "docker", "antigravity", "openai", "codegraph"]
  );

  service.dispose();
});

test("Golden Assertion 1: Windows PATH misses; fallback agy.exe succeeds -> antigravity ready", async () => {
  const mockDocker = new MockDockerStatusService("Active");
  const probedPaths: string[] = [];

  const execMock = async (file: string) => {
    probedPaths.push(file);
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    if (file === "git") return { stdout: "git version 2.40.0\n", stderr: "" };
    if (file === "agy" || file === "antigravity") {
      throw new Error(`spawn ${file} ENOENT`);
    }
    if (file.includes("AppData") && file.includes("agy.exe")) {
      return { stdout: "1.3.3\n", stderr: "" };
    }
    throw new Error(`spawn ${file} ENOENT`);
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    platform: "win32",
    homedir: "C:\\Users\\MockUser",
    env: {
      LOCALAPPDATA: "C:\\Users\\MockUser\\AppData\\Local",
      OPENAI_API_KEY: "sk-valid-key-12345678"
    }
  });

  const snapshot = await service.refresh();
  const ag = snapshot.prerequisites.find((p) => p.id === "antigravity");

  assert.equal(ag?.state, "ready");
  assert.equal(ag?.version, "agy 1.3.3");
  assert.ok(probedPaths.includes("agy"));
  assert.ok(probedPaths.includes("antigravity"));
  assert.ok(probedPaths.some((p) => p.includes("agy.exe")));

  service.dispose();
});

test("Antigravity probe: non-Windows discovery does not probe Windows fallback locations", async () => {
  const mockDocker = new MockDockerStatusService("Active");
  const probedPaths: string[] = [];

  const execMock = async (file: string) => {
    probedPaths.push(file);
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    if (file === "git") return { stdout: "git version 2.40.0\n", stderr: "" };
    throw new Error(`spawn ${file} ENOENT`);
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    platform: "linux",
    homedir: "/home/mockuser",
    env: { OPENAI_API_KEY: "sk-valid-key-12345678" }
  });

  const snapshot = await service.refresh();
  const ag = snapshot.prerequisites.find((p) => p.id === "antigravity");

  assert.equal(ag?.state, "missing");
  assert.deepEqual(probedPaths.filter((p) => p === "agy" || p === "antigravity"), ["agy", "antigravity"]);
  assert.ok(!probedPaths.some((p) => p.endsWith(".exe")));

  service.dispose();
});

test("Golden Assertion 3 & 4: OpenAI environment precedence and masking contracts", async () => {
  const mockDocker = new MockDockerStatusService("Active");
  const execMock = async (file: string) => {
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    return { stdout: "mock\n", stderr: "" };
  };

  // Case A: env key present; malformed MCP JSON -> openai ready; no raw key emitted
  const serviceA = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: { OPENAI_API_KEY: "sk-proj-mysecretkeyvalue9999" },
    readFileFn: async () => "{ this is invalid json }"
  });

  const snapA = await serviceA.refresh();
  const openAiA = snapA.prerequisites.find((p) => p.id === "openai");
  assert.equal(openAiA?.state, "ready");
  assert.equal(openAiA?.maskedPreview, "sk-proj-****...****9999");
  assert.ok(!JSON.stringify(snapA).includes("mysecretkeyvalue"));

  // Case B: OPENAI_API_KEY=abc (short key < 8 chars) -> maskedPreview=****
  const serviceB = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: { OPENAI_API_KEY: "abc" },
    readFileFn: async () => ""
  });

  const snapB = await serviceB.refresh();
  const openAiB = snapB.prerequisites.find((p) => p.id === "openai");
  assert.equal(openAiB?.state, "ready");
  assert.equal(openAiB?.maskedPreview, "****");

  // Case C: No env key, valid MCP JSON
  const validMcp = JSON.stringify({
    mcpServers: {
      gpt_architect: {
        env: { OPENAI_API_KEY: "sk-proj-mcpsecretkey1111" }
      }
    }
  });

  const serviceC = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: {},
    readFileFn: async () => validMcp
  });

  const snapC = await serviceC.refresh();
  const openAiC = snapC.prerequisites.find((p) => p.id === "openai");
  assert.equal(openAiC?.state, "ready");
  assert.equal(openAiC?.maskedPreview, "sk-proj-****...****1111");

  // Case D: Conflicting MCP keys -> unavailable
  const conflictingMcp = JSON.stringify({
    mcpServers: {
      server1: { env: { OPENAI_API_KEY: "sk-key-alpha" } },
      server2: { env: { OPENAI_API_KEY: "sk-key-beta" } }
    }
  });

  const serviceD = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: {},
    readFileFn: async () => conflictingMcp
  });

  const snapD = await serviceD.refresh();
  const openAiD = snapD.prerequisites.find((p) => p.id === "openai");
  assert.equal(openAiD?.state, "unavailable");
  assert.match(openAiD?.detail ?? "", /Conflicting OPENAI_API_KEY/);

  // Case E: Malformed JSON with no env key -> unavailable
  const serviceE = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: {},
    readFileFn: async () => "not a json"
  });

  const snapE = await serviceE.refresh();
  const openAiE = snapE.prerequisites.find((p) => p.id === "openai");
  assert.equal(openAiE?.state, "unavailable");

  // Case F: File not found / missing key -> missing
  const serviceF = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: {},
    readFileFn: async () => {
      throw new Error("ENOENT");
    }
  });

  const snapF = await serviceF.refresh();
  const openAiF = snapF.prerequisites.find((p) => p.id === "openai");
  assert.equal(openAiF?.state, "missing");

  serviceA.dispose();
  serviceB.dispose();
  serviceC.dispose();
  serviceD.dispose();
  serviceE.dispose();
  serviceF.dispose();
});

test("SystemReadinessService: deduplicates concurrent in-flight refresh calls", async () => {
  const mockDocker = new MockDockerStatusService("Active");
  let execCount = 0;

  const execMock = async (file: string) => {
    execCount++;
    await new Promise((r) => setTimeout(r, 20));
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    return { stdout: "1.0.0\n", stderr: "" };
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    env: { OPENAI_API_KEY: "sk-mock-key-12345" }
  });

  const [snap1, snap2, snap3] = await Promise.all([
    service.refresh(),
    service.refresh(),
    service.refresh()
  ]);

  assert.equal(snap1, snap2);
  assert.equal(snap2, snap3);
  // git, node, agy, codegraph probed once during single execution
  assert.equal(execCount, 4);

  service.dispose();
});

test("CodeGraph Golden Assertion 1: PATH CodeGraph returns v1.2.3 -> ready; no fallback attempts", async () => {
  const mockDocker = new MockDockerStatusService("Active");
  const probedPaths: string[] = [];

  const execMock = async (file: string) => {
    probedPaths.push(file);
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    if (file === "git") return { stdout: "git version 2.40.0\n", stderr: "" };
    if (file === "agy") return { stdout: "1.0.0\n", stderr: "" };
    if (file === "codegraph") return { stdout: "v1.2.3\n", stderr: "" };
    throw new Error(`spawn ${file} ENOENT`);
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    platform: "win32",
    homedir: "C:\\Users\\MockUser",
    env: {
      LOCALAPPDATA: "C:\\Users\\MockUser\\AppData\\Local",
      OPENAI_API_KEY: "sk-valid-key-12345678"
    }
  });

  const snapshot = await service.refresh();
  const cg = snapshot.prerequisites.find((p) => p.id === "codegraph");

  assert.equal(cg?.state, "ready");
  assert.equal(cg?.version, "codegraph v1.2.3");
  assert.ok(probedPaths.includes("codegraph"));
  assert.ok(!probedPaths.some((p) => p.includes("codegraph.cmd")));
  assert.ok(!probedPaths.some((p) => p.includes("codegraph.exe")));

  service.dispose();
});

test("CodeGraph Golden Assertion 2: Windows PATH and .cmd missing; .exe succeeds -> ready; ordered attempts", async () => {
  const mockDocker = new MockDockerStatusService("Active");
  const probedPaths: string[] = [];

  const execMock = async (file: string) => {
    probedPaths.push(file);
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    if (file === "git") return { stdout: "git version 2.40.0\n", stderr: "" };
    if (file === "agy") return { stdout: "1.0.0\n", stderr: "" };
    if (file === "codegraph") {
      const err = new Error("spawn codegraph ENOENT");
      (err as any).code = "ENOENT";
      throw err;
    }
    if (file.endsWith("codegraph.cmd")) {
      const err = new Error("spawn codegraph.cmd ENOENT");
      (err as any).code = "ENOENT";
      throw err;
    }
    if (file.endsWith("codegraph.exe")) {
      return { stdout: "1.0.1\n", stderr: "" };
    }
    throw new Error(`spawn ${file} ENOENT`);
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    platform: "win32",
    homedir: "C:\\Users\\MockUser",
    env: {
      LOCALAPPDATA: "C:\\Users\\MockUser\\AppData\\Local",
      OPENAI_API_KEY: "sk-valid-key-12345678"
    }
  });

  const snapshot = await service.refresh();
  const cg = snapshot.prerequisites.find((p) => p.id === "codegraph");

  assert.equal(cg?.state, "ready");
  assert.equal(cg?.version, "codegraph 1.0.1");
  const cgAttempts = probedPaths.filter((p) => p.includes("codegraph"));
  assert.equal(cgAttempts[0], "codegraph");
  assert.ok(cgAttempts[1]?.endsWith("codegraph.cmd"));
  assert.ok(cgAttempts[2]?.endsWith("codegraph.exe"));

  service.dispose();
});

test("CodeGraph Golden Assertion 3: all CodeGraph candidates absent -> missing; snapshot.ready=false", async () => {
  const mockDocker = new MockDockerStatusService("Active");

  const execMock = async (file: string) => {
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    if (file === "git") return { stdout: "git version 2.40.0\n", stderr: "" };
    if (file === "agy") return { stdout: "1.0.0\n", stderr: "" };
    if (file.includes("codegraph")) {
      const err = new Error(`spawn ${file} ENOENT`);
      (err as any).code = "ENOENT";
      throw err;
    }
    throw new Error(`spawn ${file} ENOENT`);
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    platform: "win32",
    homedir: "C:\\Users\\MockUser",
    env: {
      LOCALAPPDATA: "C:\\Users\\MockUser\\AppData\\Local",
      OPENAI_API_KEY: "sk-valid-key-12345678"
    }
  });

  const snapshot = await service.refresh();
  const cg = snapshot.prerequisites.find((p) => p.id === "codegraph");

  assert.equal(cg?.state, "missing");
  assert.equal(snapshot.ready, false, "Missing CodeGraph must block overall readiness");
  assert.match(cg?.detail ?? "", /CodeGraph CLI not found/);
  assert.equal(cg?.copyCommand, "npm install -g @codegraph/cli");

  service.dispose();
});

test("CodeGraph Golden Assertion 4: CodeGraph execution fails or output is empty -> unavailable; English detail", async () => {
  const mockDocker = new MockDockerStatusService("Active");

  const execMock = async (file: string) => {
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    if (file === "git") return { stdout: "git version 2.40.0\n", stderr: "" };
    if (file === "agy") return { stdout: "1.0.0\n", stderr: "" };
    if (file === "codegraph") {
      const err = new Error("EACCES: permission denied");
      (err as any).code = "EACCES";
      throw err;
    }
    throw new Error("ENOENT");
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    platform: "linux",
    env: { OPENAI_API_KEY: "sk-valid-key-12345678" }
  });

  const snapshot = await service.refresh();
  const cg = snapshot.prerequisites.find((p) => p.id === "codegraph");

  assert.equal(cg?.state, "unavailable");
  assert.equal(snapshot.ready, false);
  assert.match(cg?.detail ?? "", /CodeGraph execution failed/);

  service.dispose();
});

test("CodeGraph Golden Assertion 5: non-Windows discovery does not probe Windows fallback locations", async () => {
  const mockDocker = new MockDockerStatusService("Active");
  const probedPaths: string[] = [];

  const execMock = async (file: string) => {
    probedPaths.push(file);
    if (file === "node") return { stdout: "v22.0.0\n", stderr: "" };
    if (file === "git") return { stdout: "git version 2.40.0\n", stderr: "" };
    if (file === "agy") return { stdout: "1.0.0\n", stderr: "" };
    const err = new Error(`spawn ${file} ENOENT`);
    (err as any).code = "ENOENT";
    throw err;
  };

  const service = new SystemReadinessService(mockDocker, {
    execFileFn: execMock,
    platform: "linux",
    homedir: "/home/mockuser",
    env: { OPENAI_API_KEY: "sk-valid-key-12345678" }
  });

  const snapshot = await service.refresh();
  const cg = snapshot.prerequisites.find((p) => p.id === "codegraph");

  assert.equal(cg?.state, "missing");
  const cgAttempts = probedPaths.filter((p) => p.includes("codegraph"));
  assert.deepEqual(cgAttempts, ["codegraph"]);
  assert.ok(!probedPaths.some((p) => p.endsWith(".cmd") || p.endsWith(".exe")));

  service.dispose();
});
