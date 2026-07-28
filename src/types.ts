// Mirrors plugins/_a0_connector/helpers/event_bridge.py's EVENT_* constants
// and _LOG_TYPE_MAP on the team-agent-zero backend. Keep these two files in
// sync by hand — this is the client-side half of that mapping.
export type ConnectorEventType =
  | "user_message"
  | "assistant_delta" // declared server-side but not currently emitted —
  // event_bridge.py updates log entries with the FULL accumulated text on
  // each tick, not incremental deltas. Renderers must REPLACE displayed
  // text on each event of a given sequence, not append. If the backend
  // ever starts emitting true deltas, this type is already reserved.
  | "assistant_message"
  | "tool_start"
  | "tool_output"
  | "tool_end"
  | "code_start"
  | "code_output"
  | "warning"
  | "error"
  | "info"
  | "status"
  | "util_message"
  | "message_complete"
  | "context_updated";

export interface ConnectorEvent {
  context_id: string;
  sequence: number;
  event: ConnectorEventType;
  timestamp: string;
  data: {
    text?: string;
    heading?: string;
    meta?: Record<string, unknown>;
  };
}

// Emitted as a top-level socket.io event named "connector_context_complete"
// — NOT nested inside connector_context_event's stream. Carries the actual
// final assistant text in `.response`; the regular streamed log events
// (assistant_message etc.) do not repeat it (see tools/response.py's
// comment: "don't log here anymore, we have the live_response extension
// now" — the final answer is delivered exclusively through this event).
export interface ConnectorContextComplete {
  context_id: string;
  status: "completed" | "error";
  response?: string;
  error?: string;
}

// Emitted as a top-level socket.io event named "connector_error" for
// agent-level failures (distinct from a rejected connector_send_message ack).
export interface ConnectorErrorEvent {
  context_id: string;
  code: string;
  message: string;
}

export interface ConnectorContextSnapshot {
  context_id: string;
  events: ConnectorEvent[];
  last_sequence: number;
  message_queue: MessageQueueItem[];
}

export interface MessageQueueItem {
  id: string;
  seq: number;
  text: string;
  attachments: string[];
  attachment_count: number;
}

export interface ConnectorHelloPayload {
  context_id?: string;
  api_token?: string;
  remote_files?: { enabled: boolean; write_enabled: boolean };
  remote_exec?: { enabled: boolean };
  computer_use?: Record<string, unknown>;
  host_browser?: Record<string, unknown>;
}

export interface ConnectorHelloResponse {
  protocol: string; // "a0-connector.v1"
  agent_zero_version: string;
  features: string[];
  exec_config: Record<string, unknown>;
  remote_tools: {
    contexts: string[];
    computer_use: boolean;
    host_browser: boolean;
    host_browser_status: Record<string, unknown>;
    remote_files: boolean;
    remote_file_writes: boolean;
    remote_exec: boolean;
  };
}

// --- File ops (connector_file_op / connector_file_op_result) ----------------
// Same wire shape used by text_editor_remote.py server-side and cliClient.ts's
// handleFileOp client-side (read/write/patch/stat), plus list_tree, which is
// the addition made for filesystem-less-mount indexing (see remote_mirror.py).
export type FileOpAction =
  | "read" | "write" | "patch" | "stat" | "list_tree" | "delete" | "list_dir";

export interface FileOpRequest {
  op_id: string;
  op: FileOpAction;
  path: string;
  context_id?: string;
  content?: string;
  patch_text?: string;
  edits?: Array<{ old_text: string; new_text: string }>;
  old_text?: string;
  new_text?: string;
  line_from?: number;
  line_to?: number;
}

export interface FileMetadata {
  path: string;
  mtime: number;
  size: number;
}

export interface FileOpResult {
  op_id: string;
  ok: boolean;
  error?: string;
  code?: string;
  result?: {
    content?: string;
    total_lines?: number;
    message?: string;
    file?: FileMetadata;
    // list_tree-specific:
    root_path?: string;
    tree?: string[];
    tree_hash?: string;
    // list_dir-specific: listado crudo, sin el filtro de list_tree.
    entries?: { name: string; is_dir: boolean }[];
    exists?: boolean;
  };
}

// --- REST endpoints under /api/plugins/_a0_connector/v1/* -------------------
// One interface per endpoint actually verified against the backend. Kept
// intentionally 1:1 with the Python handler's input/output shape rather than
// abstracted, so a protocol change on either side is easy to spot as a diff.

// Matches plugins/_model_config/default_presets.yaml's real (nested) schema
// — NOT flat provider/model fields. Confirmed by reading that YAML directly
// after the CLI's first render showed "undefined/undefined" for every preset.
export interface ModelPresetRole {
  provider: string;
  name: string;
  api_key?: string;
  api_base?: string;
  ctx_length?: number;
  ctx_history?: number;
  vision?: boolean;
}

export interface ModelPreset {
  name: string;
  chat: ModelPresetRole;
  utility?: ModelPresetRole;
  scope?: string;
  project_name?: string;
  [key: string]: unknown;
}

export interface ModelPresetsGetRequest {
  action: "get";
  scope?: "project" | "combined";
  project_name?: string;
}
export interface ModelPresetsSaveRequest {
  action: "save";
  presets: ModelPreset[];
  scope?: "project";
  project_name?: string;
}
export interface ModelPresetsResetRequest {
  action: "reset";
  scope?: "project";
  project_name?: string;
}
export type ModelPresetsRequest =
  | ModelPresetsGetRequest
  | ModelPresetsSaveRequest
  | ModelPresetsResetRequest;

export interface ModelPresetsResponse {
  ok: boolean;
  presets: ModelPreset[];
  global_presets?: ModelPreset[];
  project_presets?: ModelPreset[];
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  origin: string;
}

// Confirmed by calling agents_list directly — it's {key, label} pairs, NOT
// the richer SubAgentListItem shape (name/title/description/context/path/
// origin/enabled) that helpers/subagents.py's model suggested at a glance.
// Whatever transforms it before the API boundary flattens it down to this.
export interface AgentProfileSummary {
  key: string;
  label: string;
}

// --- Exec ops (connector_exec_op / connector_exec_op_result) ---------------
// Same wire shape used by code_execution_remote.py server-side and
// cliClient.ts's handleExecOp client-side.
export type ExecRuntime = "terminal" | "python" | "nodejs" | "output" | "reset";

export interface ExecOpRequest {
  op_id: string;
  runtime: ExecRuntime;
  session: number;
  code?: string;
  timeouts?: Record<string, number>;
}

export interface ExecOpResult {
  op_id: string;
  ok: boolean;
  error?: string;
  result?: {
    message?: string;
    output?: string;
    running?: boolean;
  };
}

export interface IndexProjectRequest {
  path: string;
  context_id?: string;
}
export interface IndexProjectResponse {
  ok: boolean;
  status: "indexing" | "indexing_remote";
  repo_slug: string;
  path: string;
}
