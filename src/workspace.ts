// src/workspace.ts

import type { PluginLogger } from "openclaw/plugin-sdk";
import path from "node:path";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { WorkspaceReadParams, WorkspaceWriteParams, WorkspaceLsParams, FileEntry } from "./types.js";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "vendor",
]);

/**
 * Depth-first directory traversal. Skips symlinks and excluded dirs.
 * Returns sorted workspace-relative file paths.
 */
export async function collectFiles(root: string, recursive: boolean): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results.sort((a, b) =>
    toWorkspaceRelative(a, root).localeCompare(toWorkspaceRelative(b, root)),
  );
}

/** Read a single file as UTF-8, return {name, content} with workspace-relative name. */
export async function readFileEntry(
  filePath: string,
  workspaceRoot: string,
): Promise<FileEntry> {
  const content = await fs.readFile(filePath, "utf8");
  return {
    name: toWorkspaceRelative(filePath, workspaceRoot),
    content,
  };
}

/** Check that a candidate path does not escape the root (path traversal prevention). */
export function isSubPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Validate that the workspace directory exists. */
export async function ensureWorkspaceExists(workspaceRoot: string): Promise<void> {
  try {
    const stats = await fs.stat(workspaceRoot);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory`);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(`Workspace directory does not exist`);
    }
    throw error;
  }
}

/** Convert absolute path to workspace-relative with forward slashes. */
function toWorkspaceRelative(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  const normalized = relative === "" ? path.basename(filePath) : relative;
  return normalized.split(path.sep).join("/");
}

/**
 * Resolve workspace root from an agent list using sessionKey.
 *
 * Accepts agents in the format returned by the `agents.list` RPC:
 *   `[{id, workspace, ...}, ...]`
 *
 * Resolution order:
 *   1. Agent-specific workspace (from agents list, matched by id)
 *   2. Default workspace (from `agents.defaults.workspace` in config)
 *   3. Error — no workspace available
 */
export function resolveWorkspace(
  agents: Array<{ id: string; workspace?: string }>,
  sessionKey: string,
  defaultWorkspace?: string,
): string {
  const key = sessionKey.trim();
  if (!key) {
    throw new Error("sessionKey is required for workspace resolution");
  }

  // Parse agentId from "agent:<agentId>:<rest>"
  const parts = key.split(":").filter(Boolean);
  const agentId =
    parts[0]?.toLowerCase() === "agent" && parts[1]
      ? parts[1].toLowerCase()
      : null;
  if (!agentId) {
    throw new Error(`Cannot parse agent ID from sessionKey: ${key}`);
  }

  // Look up the agent — never fall back to default silently
  const list = Array.isArray(agents) ? agents : [];
  const agentEntry = list.find((a) => a.id.toLowerCase() === agentId);

  if (!agentEntry) {
    const knownIds = list.map((a) => a.id).join(", ");
    throw new Error(`Agent '${agentId}' not found in agents list [${knownIds}]`);
  }

  // Use agent-specific workspace; fall back to default only for the default agent (no explicit workspace)
  const workspace = agentEntry.workspace?.trim() || defaultWorkspace?.trim();

  if (!workspace) {
    throw new Error(`No workspace configured for agent '${agentId}'`);
  }

  const expanded = workspace.startsWith("~")
    ? workspace.replace("~", process.env.HOME ?? "")
    : workspace;
  return path.resolve(expanded);
}

/**
 * Top-level handler for workspace.read RPC.
 * Returns {ok, payload} or {ok: false, error} — never throws.
 *
 * @param agents - Agent list from `agents.list` RPC: `[{id, workspace, ...}]`
 * @param defaultWorkspace - Fallback workspace from `agents.defaults.workspace`
 */
export async function handleWorkspaceRead(
  agents: Array<{ id: string; workspace?: string }>,
  params: WorkspaceReadParams,
  logger?: PluginLogger,
  defaultWorkspace?: string,
): Promise<{ ok: true; payload: FileEntry[] } | { ok: false; error: string }> {
  try {
    if (!params.sessionKey) {
      return { ok: false, error: "sessionKey is required for workspace.read" };
    }

    const workspaceRoot = resolveWorkspace(agents, params.sessionKey, defaultWorkspace);
    await ensureWorkspaceExists(workspaceRoot);

    const recursive = params.recursive !== false;
    const requestedPath = params.path?.trim();

    logger?.info(
      `workspace.read: path=${requestedPath ?? "."} recursive=${recursive} agent-session=${params.sessionKey}`,
    );

    let targetPaths: string[];

    if (requestedPath) {
      const dirPath = path.resolve(workspaceRoot, requestedPath.replace(/\\/g, "/"));
      if (!isSubPath(dirPath, workspaceRoot)) {
        return { ok: false, error: `Path '${requestedPath}' is outside the workspace` };
      }
      let stats;
      try {
        stats = await fs.stat(dirPath);
      } catch {
        return { ok: true, payload: [] };
      }
      if (stats.isDirectory()) {
        targetPaths = await collectFiles(dirPath, recursive);
      } else if (stats.isFile()) {
        targetPaths = [dirPath];
      } else {
        return { ok: true, payload: [] };
      }
    } else {
      targetPaths = await collectFiles(workspaceRoot, recursive);
    }

    if (targetPaths.length === 0) {
      return { ok: true, payload: [] };
    }

    const entries: FileEntry[] = [];
    for (const filePath of targetPaths) {
      try {
        entries.push(await readFileEntry(filePath, workspaceRoot));
      } catch (err) {
        logger?.warn(`workspace.read: skipping ${path.relative(workspaceRoot, filePath)}: ${err}`);
      }
    }

    return { ok: true, payload: entries };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Top-level handler for workspace.write RPC.
 * Writes (or overwrites) a single file inside the agent's workspace.
 * Parent directories are created if they don't exist.
 * Returns {ok, payload: {bytes}} or {ok: false, error}.
 */
export async function handleWorkspaceWrite(
  agents: Array<{ id: string; workspace?: string }>,
  params: WorkspaceWriteParams,
  logger?: PluginLogger,
  defaultWorkspace?: string,
): Promise<{ ok: true; payload: { bytes: number } } | { ok: false; error: string }> {
  try {
    if (!params.sessionKey) {
      return { ok: false, error: "sessionKey is required for workspace.write" };
    }
    if (!params.path?.trim()) {
      return { ok: false, error: "path is required for workspace.write" };
    }
    if (typeof params.content !== "string") {
      return { ok: false, error: "content is required for workspace.write" };
    }

    const workspaceRoot = resolveWorkspace(agents, params.sessionKey, defaultWorkspace);
    await ensureWorkspaceExists(workspaceRoot);

    const targetPath = path.resolve(workspaceRoot, params.path.trim().replace(/\\/g, "/"));
    if (!isSubPath(targetPath, workspaceRoot)) {
      return { ok: false, error: `Path '${params.path}' is outside the workspace` };
    }

    logger?.info(
      `workspace.write: path=${params.path} agent-session=${params.sessionKey}`,
    );

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, params.content, "utf8");

    return { ok: true, payload: { bytes: Buffer.byteLength(params.content, "utf8") } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Top-level handler for workspace.ls RPC.
 * Lists workspace-relative file paths without reading their content.
 * Returns {ok, payload: string[]} or {ok: false, error}.
 */
export async function handleWorkspaceLs(
  agents: Array<{ id: string; workspace?: string }>,
  params: WorkspaceLsParams,
  logger?: PluginLogger,
  defaultWorkspace?: string,
): Promise<{ ok: true; payload: string[] } | { ok: false; error: string }> {
  try {
    if (!params.sessionKey) {
      return { ok: false, error: "sessionKey is required for workspace.ls" };
    }

    const workspaceRoot = resolveWorkspace(agents, params.sessionKey, defaultWorkspace);
    await ensureWorkspaceExists(workspaceRoot);

    const recursive = params.recursive !== false;
    const requestedPath = params.path?.trim();

    logger?.info(
      `workspace.ls: path=${requestedPath ?? "."} recursive=${recursive} agent-session=${params.sessionKey}`,
    );

    let targetDir: string;
    if (requestedPath) {
      targetDir = path.resolve(workspaceRoot, requestedPath.replace(/\\/g, "/"));
      if (!isSubPath(targetDir, workspaceRoot)) {
        return { ok: false, error: `Path '${requestedPath}' is outside the workspace` };
      }
    } else {
      targetDir = workspaceRoot;
    }

    let stats;
    try {
      stats = await fs.stat(targetDir);
    } catch {
      return { ok: true, payload: [] };
    }
    if (!stats.isDirectory()) {
      return { ok: false, error: `Path '${requestedPath}' is not a directory` };
    }

    const filePaths = await collectFiles(targetDir, recursive);
    const relativePaths = filePaths.map((p) =>
      path.relative(workspaceRoot, p).split(path.sep).join("/"),
    );

    return { ok: true, payload: relativePaths };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
