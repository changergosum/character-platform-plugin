// src/types.ts

/** Inbound RPC request from the bot-runner side. */
export type RpcRequest = {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

/** Outbound RPC response sent back to the bot-runner side. */
export type RpcResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string };
};

/** Parameters for workspace.read RPC. */
export type WorkspaceReadParams = {
  sessionKey?: string;
  path?: string;
  recursive?: boolean;
};

/** Parameters for workspace.write RPC. */
export type WorkspaceWriteParams = {
  sessionKey?: string;
  /** Workspace-relative path to write (required). */
  path: string;
  /** UTF-8 content to write (required). */
  content: string;
};

/** Parameters for workspace.ls RPC. */
export type WorkspaceLsParams = {
  sessionKey?: string;
  /** Workspace-relative path to list (defaults to root). */
  path?: string;
  recursive?: boolean;
};

/** Single file entry returned by workspace.read. */
export type FileEntry = {
  name: string;
  content: string;
};
