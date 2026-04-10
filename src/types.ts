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

// ---------------------------------------------------------------------------
// Platform chat RPC params
// ---------------------------------------------------------------------------

/** Parameters for platform.chat.send — send a message to an agent on behalf of a user. */
export type PlatformChatSendParams = {
  /** Platform user ID used to derive the session key. */
  userId: string;
  /** Agent ID to target. Defaults to "main" when omitted. */
  agentId?: string | null;
  /** The message text to send. */
  message: string;
  /** Optional extended thinking prompt. */
  thinking?: string | null;
  /** Client-supplied idempotency key / run ID. */
  runId?: string | null;
};

/** Parameters for platform.chat.history — fetch conversation history for a user. */
export type PlatformChatHistoryParams = {
  userId: string;
  agentId?: string | null;
  limit?: number | null;
};

/** Parameters for platform.chat.abort — abort an in-flight agent run for a user. */
export type PlatformChatAbortParams = {
  userId: string;
  agentId?: string | null;
  runId?: string | null;
};

/** Parameters for platform.chat.reset — reset (clear) a user's conversation session. */
export type PlatformChatResetParams = {
  userId: string;
  agentId?: string | null;
};

/** Parameters for platform.session.resolve — return the computed session key without sending anything. */
export type PlatformSessionResolveParams = {
  userId: string;
  agentId?: string | null;
};
