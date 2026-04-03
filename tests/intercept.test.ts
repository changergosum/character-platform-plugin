/**
 * Tests for the interception flow logic.
 *
 * These tests exercise the workspace.read interception logic as described in
 * monitor.ts's aToB handler, testing at the handleWorkspaceRead level without
 * needing real WebSockets.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { handleWorkspaceRead } from "../src/workspace.js";
import type { RpcRequest, RpcResponse, WorkspaceReadParams } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sideclaw-intercept-test-"));
}

async function writeFile(dir: string, relPath: string, content: string): Promise<string> {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
  return fullPath;
}

/** Simulate the aToB fast-string-check + parse + dispatch logic from monitor.ts */
async function simulateAToB(
  raw: string,
  agents: any[],
): Promise<{ intercepted: boolean; response: RpcResponse | null }> {
  // Fast string check
  if (!raw.includes('"workspace.read"')) {
    return { intercepted: false, response: null };
  }

  let frame: RpcRequest;
  try {
    frame = JSON.parse(raw) as RpcRequest;
  } catch {
    // JSON parse failed — fall through to normal relay
    return { intercepted: false, response: null };
  }

  if (frame.type !== "req" || frame.method !== "workspace.read") {
    return { intercepted: false, response: null };
  }

  const result = await handleWorkspaceRead(agents, frame.params as WorkspaceReadParams);
  const resp: RpcResponse = result.ok
    ? { type: "res", id: frame.id, ok: true, payload: result.payload }
    : { type: "res", id: frame.id, ok: false, error: { message: result.error } };

  return { intercepted: true, response: resp };
}

// ---------------------------------------------------------------------------
// Interception flow tests
// ---------------------------------------------------------------------------

describe("aToB interception flow", () => {
  let tmpDir: string;
  const AGENT_ID = "devagent";
  const SESSION_KEY = `agent:${AGENT_ID}:sess42`;

  const makeAgents = (workspace: string) => [{ id: AGENT_ID, workspace }];

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("intercepts a well-formed workspace.read request and returns correct RPC response", async () => {
    await writeFile(tmpDir, "hello.ts", "export const x = 1;");
    const agents = makeAgents(tmpDir);

    const frame: RpcRequest = {
      type: "req",
      id: "rpc-001",
      method: "workspace.read",
      params: { sessionKey: SESSION_KEY },
    };

    const { intercepted, response } = await simulateAToB(JSON.stringify(frame), agents);

    expect(intercepted).toBe(true);
    expect(response).not.toBeNull();
    expect(response!.type).toBe("res");
    expect(response!.id).toBe("rpc-001");
    expect(response!.ok).toBe(true);
    expect(Array.isArray(response!.payload)).toBe(true);
    const payload = response!.payload as any[];
    expect(payload.some((e) => e.name === "hello.ts")).toBe(true);
  });

  it("passes non-matching messages through without interception", async () => {
    const agents = makeAgents(tmpDir);

    // Message that doesn't mention workspace.read at all
    const otherFrame = JSON.stringify({
      type: "req",
      id: "rpc-002",
      method: "session.ping",
      params: {},
    });

    const { intercepted, response } = await simulateAToB(otherFrame, agents);
    expect(intercepted).toBe(false);
    expect(response).toBeNull();
  });

  it("falls through gracefully on JSON parse failure", async () => {
    const agents = makeAgents(tmpDir);

    // Malformed JSON that still contains the fast-string trigger
    const malformed = '{"type":"req","method":"workspace.read" BROKEN JSON}';

    const { intercepted, response } = await simulateAToB(malformed, agents);
    expect(intercepted).toBe(false);
    expect(response).toBeNull();
  });

  it("returns error response for missing agent in config", async () => {
    const frame: RpcRequest = {
      type: "req",
      id: "rpc-003",
      method: "workspace.read",
      params: { sessionKey: SESSION_KEY },
    };

    const { intercepted, response } = await simulateAToB(JSON.stringify(frame), []);

    expect(intercepted).toBe(true);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(false);
    expect(response!.error).toBeDefined();
    expect(response!.error!.message).toMatch(/not found in agents list/i);
    expect(response!.id).toBe("rpc-003");
  });

  it("passes through a message that mentions workspace.read but has type=res (not req)", async () => {
    const agents = makeAgents(tmpDir);

    // A response frame that happens to contain "workspace.read" in payload
    const responseFrame = JSON.stringify({
      type: "res",
      id: "rpc-004",
      ok: true,
      payload: { method: "workspace.read", files: [] },
    });

    const { intercepted } = await simulateAToB(responseFrame, agents);
    expect(intercepted).toBe(false);
  });

  it("returns error response when sessionKey is missing from params", async () => {
    const agents = makeAgents(tmpDir);

    const frame: RpcRequest = {
      type: "req",
      id: "rpc-005",
      method: "workspace.read",
      params: {},
    };

    const { intercepted, response } = await simulateAToB(JSON.stringify(frame), agents);

    expect(intercepted).toBe(true);
    expect(response!.ok).toBe(false);
    expect(response!.error!.message).toMatch(/sessionKey/i);
    expect(response!.id).toBe("rpc-005");
  });

  it("builds RPC response with correct id from request", async () => {
    await writeFile(tmpDir, "file.ts", "const a = 1;");
    const agents = makeAgents(tmpDir);
    const requestId = "unique-request-id-xyz";

    const frame: RpcRequest = {
      type: "req",
      id: requestId,
      method: "workspace.read",
      params: { sessionKey: SESSION_KEY },
    };

    const { response } = await simulateAToB(JSON.stringify(frame), agents);
    expect(response!.id).toBe(requestId);
  });
});
