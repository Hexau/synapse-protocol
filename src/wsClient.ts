import { io, Socket } from "socket.io-client";
import {
  ConnectorEvent,
  ConnectorContextSnapshot,
  ConnectorContextComplete,
  ConnectorErrorEvent,
  ConnectorHelloPayload,
  FileOpRequest,
  FileOpResult,
  ExecOpRequest,
  ExecOpResult,
} from "./types";

const WS_HANDLER = "plugins/_a0_connector/ws_connector";

export type ConnectionStatusCallback = (connected: boolean) => void;
export type EventCallback = (event: ConnectorEvent) => void;
export type CompleteCallback = (complete: ConnectorContextComplete) => void;
export type ErrorCallback = (error: ConnectorErrorEvent) => void;
export type FileOpHandler = (request: FileOpRequest) => Promise<FileOpResult>;
export type ExecOpHandler = (request: ExecOpRequest) => Promise<ExecOpResult>;

export interface SynapseWsClientOptions {
  serverUrl: string;
  onStatus?: ConnectionStatusCallback;
  // If provided, this client answers connector_file_op requests from the
  // server (i.e. it acts as a filesystem-access CLI, like synapse-vscode's
  // cliClient.ts). Omit for a client that only chats and never exposes
  // local files (e.g. a read-only viewer).
  fileOpHandler?: FileOpHandler;
  // If provided, this client answers connector_exec_op requests (runs
  // terminal/python/nodejs commands locally and streams output back).
  execOpHandler?: ExecOpHandler;
  // Temporary diagnostic hook: called with (eventName, payload) for EVERY
  // event received on the socket, regardless of type. Used to debug why an
  // expected event isn't reaching a registered handler.
  onDebugEvent?: (eventName: string, payload: unknown) => void;
}

/**
 * WebSocket half of the a0-connector.v1 protocol. Extracted from
 * synapse-vscode/src/cliClient.ts (proven working against team-agent-zero)
 * so both the VSCode extension and the Synapse CLI share one implementation
 * instead of two copies drifting apart.
 */
export class SynapseWsClient {
  private socket: Socket | null = null;
  private contextId = "";
  private apiToken = "";
  private readonly serverUrl: string;
  private readonly onStatus?: ConnectionStatusCallback;
  private readonly fileOpHandler?: FileOpHandler;
  private readonly execOpHandler?: ExecOpHandler;
  private readonly onDebugEvent?: (eventName: string, payload: unknown) => void;
  private eventHandlers = new Set<EventCallback>();
  private snapshotHandlers = new Set<(s: ConnectorContextSnapshot) => void>();
  private completeHandlers = new Set<CompleteCallback>();
  private errorHandlers = new Set<ErrorCallback>();

  constructor(options: SynapseWsClientOptions) {
    this.serverUrl = options.serverUrl;
    this.onStatus = options.onStatus;
    this.fileOpHandler = options.fileOpHandler;
    this.execOpHandler = options.execOpHandler;
    this.onDebugEvent = options.onDebugEvent;
  }

  start(): void {
    const sock = io(this.serverUrl + "/ws", {
      path: "/socket.io",
      transports: ["websocket"],
      auth: { handlers: [WS_HANDLER] },
      reconnection: true,
      reconnectionDelay: 3000,
    });

    sock.on("connect", () => {
      this.sendHello(sock);
      this.onStatus?.(true);
    });

    sock.on("connect_error", () => {
      // Caller decides how to surface this (log line, status bar, etc.)
    });

    sock.on("disconnect", () => {
      this.onStatus?.(false);
    });

    // Every event on this namespace is wrapped in a generic envelope by the
    // WsManager dispatch pipeline: {handlerId, eventId, correlationId, ts,
    // data: <actual payload>} — confirmed by a debug onAny() capture, which
    // showed connector_context_complete arriving as that envelope with the
    // real {context_id, status, response} nested under .data. Previously
    // only file/exec ops unwrapped this; every other listener was reading
    // the envelope itself as if it were the payload (so e.g. complete.response
    // was always undefined — the actual bug behind "response never shows").
    sock.on("connector_context_event", (envelope: unknown) => {
      const event = this.unwrapEnvelope<ConnectorEvent>(envelope);
      for (const handler of this.eventHandlers) handler(event);
    });

    sock.on("connector_context_snapshot", (envelope: unknown) => {
      const snapshot = this.unwrapEnvelope<ConnectorContextSnapshot>(envelope);
      for (const handler of this.snapshotHandlers) handler(snapshot);
    });

    // Distinct top-level events, NOT part of the connector_context_event
    // stream — see ConnectorContextComplete's doc comment in types.ts for
    // why this matters (the final assistant answer only arrives here).
    sock.on("connector_context_complete", (envelope: unknown) => {
      const complete = this.unwrapEnvelope<ConnectorContextComplete>(envelope);
      for (const handler of this.completeHandlers) handler(complete);
    });

    sock.on("connector_error", (envelope: unknown) => {
      const error = this.unwrapEnvelope<ConnectorErrorEvent>(envelope);
      for (const handler of this.errorHandlers) handler(error);
    });

    if (this.fileOpHandler) {
      sock.on("connector_file_op", async (envelope: unknown) => {
        const raw = this.unwrapEnvelope<FileOpRequest>(envelope);
        const result = await this.fileOpHandler!(raw);
        sock.emit("connector_file_op_result", { ...result, op_id: raw.op_id });
      });
    }

    if (this.execOpHandler) {
      sock.on("connector_exec_op", async (envelope: unknown) => {
        const raw = this.unwrapEnvelope<ExecOpRequest>(envelope);
        const result = await this.execOpHandler!(raw);
        sock.emit("connector_exec_op_result", { ...result, op_id: raw.op_id });
      });
    }

    if (this.onDebugEvent) {
      sock.onAny((eventName: string, ...args: unknown[]) => this.onDebugEvent!(eventName, args));
    }

    this.socket = sock;
  }

  stop(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  updateContextId(id: string): void {
    if (!id || id === this.contextId) return;
    this.contextId = id;
    if (this.socket?.connected) this.sendHello(this.socket);
  }

  updateApiToken(token: string): void {
    this.apiToken = token || "";
    if (this.socket?.connected) this.sendHello(this.socket);
  }

  // Proactively pushes this client's file tree so the server's
  // _76_include_remote_file_structure.py extension can auto-inject it into
  // the agent's prompt every turn (max_age_seconds=90 there — call this
  // again periodically, not just once at startup, or the snapshot goes
  // stale and stops being injected). This is how the agent learns what
  // project/files a CLI's cwd actually contains, without needing the
  // separate "projects" registry (which only manages folders it creates
  // itself under usr/projects/, not arbitrary external paths).
  sendRemoteTreeUpdate(rootPath: string, tree: string, treeHash: string): void {
    this.socket?.emit("connector_remote_tree_update", {
      root_path: rootPath,
      tree,
      tree_hash: treeHash,
    });
  }

  onEvent(handler: EventCallback): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onSnapshot(handler: (s: ConnectorContextSnapshot) => void): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  onComplete(handler: CompleteCallback): () => void {
    this.completeHandlers.add(handler);
    return () => this.completeHandlers.delete(handler);
  }

  onError(handler: ErrorCallback): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  subscribeContext(contextId: string, from = 0): void {
    this.socket?.emit("connector_subscribe_context", { context_id: contextId, from });
  }

  // Returns the ack error message if the server rejected the send (e.g.
  // "Context not found" — a client must chat_ensure() an id it derived
  // itself before ever sending to it, since the server won't auto-create
  // one for a context_id it hasn't seen before), or null on success/accepted.
  // Without reading this ack, a rejected send previously looked identical to
  // one still being processed — the UI just sat there indefinitely.
  sendMessage(message: string, attachments: string[] = []): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve("Not connected");
        return;
      }
      this.socket.emit(
        "connector_send_message",
        { message, context_id: this.contextId || undefined, attachments },
        (response: unknown) => resolve(this.extractAckError(response))
      );
    });
  }

  // The ack payload comes back through helpers/ws.py's catch-all dispatcher
  // as {results: [{handlerId, ok, error?, code?}, ...]} — one entry per
  // activated WsHandler, not a flat {error} — plus some paths (e.g. the
  // AUTH_REQUIRED/NO_HANDLERS early-outs) return a flatter shape directly.
  // Tolerate both instead of assuming one.
  private extractAckError(response: unknown): string | null {
    if (!response || typeof response !== "object") return null;
    const r = response as Record<string, unknown>;

    if (Array.isArray(r.results)) {
      for (const item of r.results as Record<string, unknown>[]) {
        if (item && item.ok === false) {
          const code = typeof item.code === "string" ? `[${item.code}] ` : "";
          return `${code}${String(item.error ?? "Unknown error")}`;
        }
      }
      return null;
    }

    if (r.error) {
      const code = typeof r.code === "string" ? `[${r.code}] ` : "";
      return `${code}${String(r.error)}`;
    }

    return null;
  }

  private sendHello(sock: Socket): void {
    const payload: ConnectorHelloPayload = {
      context_id: this.contextId || undefined,
      api_token: this.apiToken || undefined,
    };
    if (this.fileOpHandler) {
      payload.remote_files = { enabled: true, write_enabled: true };
    }
    if (this.execOpHandler) {
      payload.remote_exec = { enabled: true };
    }
    sock.emit("connector_hello", payload);
  }

  private unwrapEnvelope<T>(envelope: unknown): T {
    if (envelope && typeof envelope === "object" && "data" in envelope) {
      return (envelope as { data: T }).data;
    }
    return envelope as T;
  }
}
