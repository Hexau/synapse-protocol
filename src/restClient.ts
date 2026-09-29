import * as fs from "fs";
import * as path from "path";
import {
  IndexProjectRequest,
  IndexProjectResponse,
  ModelPresetsRequest,
  ModelPresetsResponse,
  SkillSummary,
  AgentProfileSummary,
  TokenStatus,
  UsageSummaryRequest,
  UsageSummaryResponse,
  SessionGoalGetResponse,
  SessionGoalSetResponse,
  MultiRunStartRequest,
  MultiRunStartResponse,
  MultiRunStatusResponse,
  MultiRunPickRequest,
  MultiRunPickResponse,
  DiffWalkthroughResponse,
  PolicyRememberRequest,
  PolicyRememberResponse,
  PolicyRememberedListResponse,
  PolicyAuditTailResponse,
  PolicyPendingListResponse,
  PolicyApproveResponse,
} from "./types";

export interface SynapseRestClientOptions {
  serverUrl: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

export type ModelSwitcherAction = "get" | "set_preset" | "clear" | "set_override";

export interface ModelSwitcherRequest {
  action: ModelSwitcherAction;
  // Required for every action except "get" (get() works with no context —
  // falls back to the global chat/utility model config).
  context_id?: string;
  preset_name?: string; // set_preset
  main_model?: { provider?: string; name?: string; api_key?: string; api_base?: string }; // set_override
  utility_model?: { provider?: string; name?: string; api_key?: string; api_base?: string }; // set_override
}

/**
 * REST half of the a0-connector.v1 protocol — the endpoints under
 * /api/plugins/_a0_connector/v1/*. Every field name here was verified
 * directly against the Python handler source (not guessed) — see
 * plugins/_a0_connector/api/v1/*.py on the team-agent-zero backend.
 */
export class SynapseRestClient {
  private readonly baseUrl: string;
  // /upload lives at the server root (api/upload.py -> route "upload"),
  // NOT under /api/plugins/_a0_connector/v1 like every other endpoint here
  // — it's a core Agent-Zero handler the connector plugin reuses rather
  // than reimplementing its own upload path.
  private readonly rootUrl: string;
  private apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SynapseRestClientOptions) {
    this.rootUrl = options.serverUrl.replace(/\/$/, "");
    this.baseUrl = this.rootUrl + "/api/plugins/_a0_connector/v1";
    this.apiToken = options.apiToken ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  updateApiToken(token: string): void {
    this.apiToken = token;
  }

  private async post<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiToken ? { "X-API-Token": this.apiToken } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Synapse API ${endpoint} failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  // Uploads a local file (e.g. an image the CLI user wants to attach) to
  // usr/uploads/ on the server, returning the server-side path to reference
  // as a WS connector_send_message attachment. Data-URL/base64 payloads are
  // explicitly rejected by that WS handler (see _normalize_attachment_refs
  // in ws_connector.py) — this /upload roundtrip is the documented way to
  // get a real server path for something that only exists on the client's
  // own disk, matching what the WebUI's drag-and-drop attach already does.
  async uploadFile(filePath: string): Promise<string> {
    const data = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const form = new FormData();
    form.append("file", new Blob([data]), filename);

    // Every other core Agent-Zero handler here lives under
    // /api/plugins/_a0_connector/v1/*, but api/upload.py is a core (non-
    // connector) endpoint reached via the generic dispatcher mounted at
    // /api/<path> (helpers/api.py's register_api_route) — NOT bare /upload,
    // which matches an unrelated GET-only route and 405s.
    const res = await this.fetchImpl(`${this.rootUrl}/api/upload`, {
      method: "POST",
      headers: this.apiToken ? { "X-API-Token": this.apiToken } : {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node's
      // fetch (undici) accepts FormData directly; BodyInit isn't declared
      // without the DOM lib, which this package intentionally doesn't pull in.
      body: form as any,
    });
    if (!res.ok) {
      throw new Error(`Synapse API upload failed: ${res.status} ${await res.text()}`);
    }
    const result = (await res.json()) as { filenames?: string[] };
    const saved = result.filenames?.[0];
    if (!saved) {
      throw new Error("Upload succeeded but the server returned no filename.");
    }
    // api/upload.py saves under usr/uploads/; message_send.py's own upload
    // path (the one WS attachments are documented to expect) resolves that
    // same directory to /a0/usr/uploads inside the container.
    return `/a0/usr/uploads/${saved}`;
  }

  // --- Settings (includes provider API keys — masked on read, per
  // helpers/settings.py's API_KEY_PLACEHOLDER; a value equal to that
  // placeholder is left untouched on write, so it's safe to round-trip a
  // settings_get() response straight into settings_set() for unrelated
  // field changes without accidentally wiping a key). --------------------
  // settings_get's raw response is {settings: {...}, additional: {...}} —
  // unwrap to just the settings dict, since every caller wants that, not
  // the wrapper (confirmed by curl: the wrapper was silently swallowing
  // "agent_profile" lookups, since it's nested one level deeper than a
  // naive `key in settings` check assumed).
  async getSettings(): Promise<Record<string, unknown>> {
    const response = await this.post<{ settings?: Record<string, unknown> }>("settings_get");
    return response.settings ?? {};
  }

  async setSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post("settings_set", { settings });
  }

  // --- Models ---------------------------------------------------------------
  // Global presets (create/list/reset a saved model configuration):
  async modelPresets(request: ModelPresetsRequest): Promise<ModelPresetsResponse> {
    return this.post("model_presets", request as unknown as Record<string, unknown>);
  }

  // Per-chat override (which preset/model this specific context/session
  // uses right now — requires context_id except for the "get" action,
  // which falls back to the global config when omitted):
  async modelSwitcher(request: ModelSwitcherRequest): Promise<Record<string, unknown>> {
    return this.post("model_switcher", request as unknown as Record<string, unknown>);
  }

  // --- Skills -----------------------------------------------------------
  async listSkills(
    options: { contextId?: string; projectName?: string; agentProfile?: string } = {}
  ): Promise<{ ok: boolean; data: SkillSummary[] }> {
    return this.post("skills_list", {
      context_id: options.contextId,
      project_name: options.projectName,
      agent_profile: options.agentProfile,
    });
  }

  async activateSkill(
    contextId: string,
    skill: string | { path: string }
  ): Promise<Record<string, unknown>> {
    return this.post("skills_activate", { context_id: contextId, skill });
  }

  async deleteSkill(skillPath: string, projectName?: string): Promise<Record<string, unknown>> {
    return this.post("skills_delete", { skill_path: skillPath, project_name: projectName });
  }

  // --- Agent profiles ---------------------------------------------------
  async listAgents(): Promise<{ ok: boolean; data: AgentProfileSummary[] }> {
    return this.post("agents_list");
  }

  async setAgentProfile(contextId: string, agentProfile: string): Promise<Record<string, unknown>> {
    return this.post("agent_profile_set", { context_id: contextId, agent_profile: agentProfile });
  }

  // --- Chats --------------------------------------------------------------
  async listChats(): Promise<{ contexts: Record<string, unknown>[] }> {
    return this.post("chats_list");
  }

  async createChat(currentContext?: string): Promise<Record<string, unknown>> {
    return this.post("chat_create", { current_context: currentContext });
  }

  // Idempotent get-or-create by exact id — REQUIRED before the first
  // connector_send_message to a context_id a client derived itself (like the
  // CLI's hostname+path hash), since _handle_send_message's get_existing_context
  // 404s on any context_id it hasn't seen before rather than auto-creating it.
  // (Same fix already applied once for synapse-vscode's WebUI iframe — see
  // chat_ensure.py's docstring.)
  async ensureChat(contextId: string): Promise<{ context_id: string; created: boolean }> {
    return this.post("chat_ensure", { context_id: contextId });
  }

  async resetChat(contextId: string): Promise<Record<string, unknown>> {
    return this.post("chat_reset", { context_id: contextId });
  }

  async deleteChat(contextId: string): Promise<Record<string, unknown>> {
    return this.post("chat_delete", { context_id: contextId });
  }

  // --- Projects / indexing --------------------------------------------------
  async indexProject(request: IndexProjectRequest): Promise<IndexProjectResponse> {
    return this.post("index_project", request as unknown as Record<string, unknown>);
  }

  // --- Misc control -----------------------------------------------------
  async pause(contextId: string, paused: boolean): Promise<Record<string, unknown>> {
    return this.post("pause", { context_id: contextId, paused });
  }

  async nudge(contextId: string): Promise<Record<string, unknown>> {
    return this.post("nudge", { context_id: contextId });
  }

  async compactChat(contextId: string): Promise<Record<string, unknown>> {
    return this.post("compact_chat", { context_id: contextId });
  }

  async logTail(contextId: string, after = 0, limit = 50): Promise<Record<string, unknown>> {
    return this.post("log_tail", { context_id: contextId, after, limit });
  }

  // --- Fase 1 - A*Usage tracker / Fase 2 - B*Session-goal (HUD data layer) --
  async getTokenStatus(contextId: string): Promise<TokenStatus> {
    return this.post("token_status", { context_id: contextId });
  }

  async getUsageSummary(request: UsageSummaryRequest = {}): Promise<UsageSummaryResponse> {
    return this.post("usage_summary", request as unknown as Record<string, unknown>);
  }

  async getSessionGoal(contextId: string): Promise<SessionGoalGetResponse> {
    return this.post("session_goal_get", { context_id: contextId });
  }

  async setSessionGoal(
    contextId: string,
    objective: string,
    tokenBudget?: number
  ): Promise<SessionGoalSetResponse> {
    return this.post("session_goal_set", {
      context_id: contextId,
      objective,
      ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}),
    });
  }

  async clearSessionGoal(contextId: string): Promise<Record<string, unknown>> {
    return this.post("session_goal_clear", { context_id: contextId });
  }

  async pauseSessionGoal(contextId: string): Promise<SessionGoalSetResponse> {
    return this.post("session_goal_pause", { context_id: contextId });
  }

  // Server dispatches the continuation nudge itself (context.communicate())
  // — see plugins/_a0_connector/api/v1/session_goal_resume.py. The caller
  // doesn't need to send anything after this resolves.
  async resumeSessionGoal(contextId: string): Promise<SessionGoalSetResponse> {
    return this.post("session_goal_resume", { context_id: contextId });
  }

  // --- Multi-run ----------------------------------------------------------
  // Fires fan_out() in a background thread server-side and returns
  // immediately with a run_id — see multi_run_start.py. Poll getMultiRunStatus
  // until status is no longer "running".
  async startMultiRun(request: MultiRunStartRequest): Promise<MultiRunStartResponse> {
    return this.post("multi_run_start", request as unknown as Record<string, unknown>);
  }

  async getMultiRunStatus(runId: string): Promise<MultiRunStatusResponse> {
    return this.post("multi_run_status", { run_id: runId });
  }

  async pickMultiRunWinner(request: MultiRunPickRequest): Promise<MultiRunPickResponse> {
    return this.post("multi_run_pick", request as unknown as Record<string, unknown>);
  }

  // --- Diff walkthrough -----------------------------------------------------
  async getDiffWalkthrough(repoSlug: string, baseRef?: string): Promise<DiffWalkthroughResponse> {
    return this.post("diff_walkthrough_get", { repo_slug: repoSlug, base_ref: baseRef });
  }

  // --- Tool policy engine -----------------------------------------------
  async rememberPolicyDecision(request: PolicyRememberRequest): Promise<PolicyRememberResponse> {
    return this.post("policy_remember", request as unknown as Record<string, unknown>);
  }

  async listRememberedPolicyRules(): Promise<PolicyRememberedListResponse> {
    return this.post("policy_remembered_list");
  }

  async forgetPolicyDecision(actionId: string): Promise<Record<string, unknown>> {
    return this.post("policy_forget", { action_id: actionId });
  }

  async tailPolicyAudit(limit = 50): Promise<PolicyAuditTailResponse> {
    return this.post("policy_audit_tail", { limit });
  }

  // Live approval flow — a require_approval rule with no remembered
  // decision blocks the tool call server-side until one of these resolves
  // it (or it times out on its own).
  async listPendingApprovals(): Promise<PolicyPendingListResponse> {
    return this.post("policy_pending_list");
  }

  async approvePendingAction(actionId: string, decision: "allow" | "deny"): Promise<PolicyApproveResponse> {
    return this.post("policy_approve", { action_id: actionId, decision });
  }
}
