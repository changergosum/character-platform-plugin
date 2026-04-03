import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  isSubPath,
  ensureWorkspaceExists,
  collectFiles,
  readFileEntry,
  resolveWorkspace,
  handleWorkspaceRead,
} from "../src/workspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sideclaw-test-"));
}

async function writeFile(dir: string, relPath: string, content: string): Promise<string> {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
  return fullPath;
}

// ---------------------------------------------------------------------------
// isSubPath
// ---------------------------------------------------------------------------

describe("isSubPath", () => {
  it("accepts paths within root", () => {
    expect(isSubPath("/workspace/src/index.ts", "/workspace")).toBe(true);
  });

  it("accepts root itself", () => {
    expect(isSubPath("/workspace", "/workspace")).toBe(true);
  });

  it("rejects paths outside root", () => {
    expect(isSubPath("/other/file.ts", "/workspace")).toBe(false);
  });

  it("rejects traversal with ..", () => {
    expect(isSubPath("/workspace/../etc/passwd", "/workspace")).toBe(false);
  });

  it("accepts nested paths", () => {
    expect(isSubPath("/workspace/a/b/c/deep.ts", "/workspace")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureWorkspaceExists
// ---------------------------------------------------------------------------

describe("ensureWorkspaceExists", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("succeeds for existing directory", async () => {
    await expect(ensureWorkspaceExists(tmpDir)).resolves.toBeUndefined();
  });

  it("throws for non-existent path", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    await expect(ensureWorkspaceExists(missing)).rejects.toThrow(
      "Workspace directory does not exist",
    );
  });

  it("throws for a file, not directory", async () => {
    const filePath = await writeFile(tmpDir, "afile.txt", "hello");
    await expect(ensureWorkspaceExists(filePath)).rejects.toThrow(
      "not a directory",
    );
  });
});

// ---------------------------------------------------------------------------
// collectFiles
// ---------------------------------------------------------------------------

describe("collectFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists files in a flat directory", async () => {
    await writeFile(tmpDir, "a.ts", "");
    await writeFile(tmpDir, "b.ts", "");
    const files = await collectFiles(tmpDir, false);
    const names = files.map((f) => path.basename(f));
    expect(names).toContain("a.ts");
    expect(names).toContain("b.ts");
  });

  it("recurses into subdirectories when recursive=true", async () => {
    await writeFile(tmpDir, "root.ts", "");
    await writeFile(tmpDir, "sub/nested.ts", "");
    const files = await collectFiles(tmpDir, true);
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).toContain("root.ts");
    expect(basenames).toContain("nested.ts");
  });

  it("does not recurse when recursive=false", async () => {
    await writeFile(tmpDir, "root.ts", "");
    await writeFile(tmpDir, "sub/nested.ts", "");
    const files = await collectFiles(tmpDir, false);
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).toContain("root.ts");
    expect(basenames).not.toContain("nested.ts");
  });

  it("skips node_modules directory", async () => {
    await writeFile(tmpDir, "index.ts", "");
    await writeFile(tmpDir, "node_modules/pkg/index.js", "");
    const files = await collectFiles(tmpDir, true);
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).toContain("index.ts");
    expect(basenames).not.toContain("index.js");
  });

  it("returns sorted results", async () => {
    await writeFile(tmpDir, "z.ts", "");
    await writeFile(tmpDir, "a.ts", "");
    await writeFile(tmpDir, "m.ts", "");
    const files = await collectFiles(tmpDir, false);
    const names = files.map((f) => path.relative(tmpDir, f));
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// readFileEntry
// ---------------------------------------------------------------------------

describe("readFileEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns workspace-relative name and content", async () => {
    const filePath = await writeFile(tmpDir, "hello.txt", "world");
    const entry = await readFileEntry(filePath, tmpDir);
    expect(entry.name).toBe("hello.txt");
    expect(entry.content).toBe("world");
  });

  it("uses forward slashes for nested paths", async () => {
    const filePath = await writeFile(tmpDir, "a/b/c.txt", "deep");
    const entry = await readFileEntry(filePath, tmpDir);
    expect(entry.name).toBe("a/b/c.txt");
    expect(entry.name).not.toContain("\\");
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspace
// ---------------------------------------------------------------------------

describe("resolveWorkspace", () => {
  const makeAgents = (agents: any[]) => agents;

  it("resolves workspace from agent config matching sessionKey", () => {
    const cfg = makeAgents([{ id: "myagent", workspace: "/workspace/myagent" }]);
    const result = resolveWorkspace(cfg, "agent:myagent:session123");
    expect(result).toBe("/workspace/myagent");
  });

  it("is case-insensitive for agent id matching", () => {
    const cfg = makeAgents([{ id: "MyAgent", workspace: "/workspace/myagent" }]);
    const result = resolveWorkspace(cfg, "agent:myagent:session123");
    expect(result).toBe("/workspace/myagent");
  });

  it("throws when agent not found", () => {
    const agents = makeAgents([{ id: "other", workspace: "/workspace/other" }]);
    expect(() => resolveWorkspace(agents, "agent:myagent:session123")).toThrow(
      /not found in agents list/,
    );
  });

  it("throws when no workspace configured", () => {
    const cfg = makeAgents([{ id: "myagent" }]);
    expect(() => resolveWorkspace(cfg, "agent:myagent:session123")).toThrow(
      "No workspace configured for agent 'myagent'",
    );
  });

  it("throws when sessionKey is empty", () => {
    const cfg = makeAgents([{ id: "myagent", workspace: "/workspace/myagent" }]);
    expect(() => resolveWorkspace(cfg, "   ")).toThrow("sessionKey is required");
  });

  it("throws when sessionKey has no agent prefix", () => {
    const cfg = makeAgents([{ id: "myagent", workspace: "/workspace/myagent" }]);
    expect(() => resolveWorkspace(cfg, "notanagent")).toThrow(
      "Cannot parse agent ID",
    );
  });

  it("throws when agent not found and no default", () => {
    const agents = makeAgents([{ id: "other", workspace: "/workspace/other" }]);
    expect(() => resolveWorkspace(agents, "agent:unknown:session")).toThrow();
  });

  it("falls back to default workspace when agent has no workspace", () => {
    const agents = [{ id: "myagent" }]; // no workspace field
    const result = resolveWorkspace(agents, "agent:myagent:session", "/default/workspace");
    expect(result).toBe("/default/workspace");
  });

  it("throws when agent not in list even with default workspace", () => {
    expect(() => resolveWorkspace([], "agent:main:session", "/default/workspace")).toThrow(
      /not found in agents list/,
    );
  });

  it("prefers agent-specific workspace over default", () => {
    const agents = [{ id: "myagent", workspace: "/specific" }];
    const result = resolveWorkspace(agents, "agent:myagent:session", "/default/workspace");
    expect(result).toBe("/specific");
  });
});

// ---------------------------------------------------------------------------
// handleWorkspaceRead
// ---------------------------------------------------------------------------

describe("handleWorkspaceRead", () => {
  let tmpDir: string;

  const makeAgents = (workspace: string) => [{ id: "testagent", workspace }];

  const SESSION_KEY = "agent:testagent:session1";

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads all files from workspace directory", async () => {
    await writeFile(tmpDir, "a.txt", "content-a");
    await writeFile(tmpDir, "b.txt", "content-b");
    const cfg = makeAgents(tmpDir);
    const result = await handleWorkspaceRead(cfg, { sessionKey: SESSION_KEY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.payload.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("reads files from a specific subdirectory", async () => {
    await writeFile(tmpDir, "root.txt", "root");
    await writeFile(tmpDir, "sub/deep.txt", "deep");
    const cfg = makeAgents(tmpDir);
    const result = await handleWorkspaceRead(cfg, {
      sessionKey: SESSION_KEY,
      path: "sub",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.payload.map((e) => e.name);
    expect(names).toContain("sub/deep.txt");
    expect(names).not.toContain("root.txt");
  });

  it("returns error for missing sessionKey", async () => {
    const cfg = makeAgents(tmpDir);
    const result = await handleWorkspaceRead(cfg, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/sessionKey/i);
  });

  it("returns error for path traversal attempt", async () => {
    const cfg = makeAgents(tmpDir);
    const result = await handleWorkspaceRead(cfg, {
      sessionKey: SESSION_KEY,
      path: "../../etc/passwd",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/outside the workspace/i);
  });

  it("returns empty array for non-existent path", async () => {
    const cfg = makeAgents(tmpDir);
    const result = await handleWorkspaceRead(cfg, {
      sessionKey: SESSION_KEY,
      path: "does-not-exist",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual([]);
  });

  it("reads a single file when path points to a file", async () => {
    await writeFile(tmpDir, "single.txt", "only-me");
    const cfg = makeAgents(tmpDir);
    const result = await handleWorkspaceRead(cfg, {
      sessionKey: SESSION_KEY,
      path: "single.txt",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toHaveLength(1);
    expect(result.payload[0].name).toBe("single.txt");
    expect(result.payload[0].content).toBe("only-me");
  });

  it("returns error when agent not found", async () => {
    const result = await handleWorkspaceRead([], { sessionKey: SESSION_KEY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found in agents list/i);
  });
});
