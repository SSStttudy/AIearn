import type { AdminDashboardResponse, AuthBootstrapResponse, BootstrapResponse, Evaluation, LearningPlan, ProviderPublic, SharedProviderPublic, UserPublic, UserStatus } from "@ailearn/shared";

export class ApiError extends Error {
  constructor(message: string, public code = "request_failed") { super(message); }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "include", headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401) window.dispatchEvent(new Event("ailearn:unauthenticated"));
    throw new ApiError(body?.error?.message ?? `请求失败（${response.status}）`, body?.error?.code);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export const api = {
  authBootstrap: () => json<AuthBootstrapResponse>("/api/auth/bootstrap"),
  register: (body: { username: string; password: string; bootstrapCode?: string }) => json<{ user: UserPublic }>("/api/auth/register", { method: "POST", body: JSON.stringify(body) }),
  login: (body: { username: string; password: string }) => json<{ user: UserPublic }>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
  logout: () => json<void>("/api/auth/logout", { method: "POST" }),
  bootstrap: () => json<BootstrapResponse>("/api/bootstrap"),
  getModels: (body?: { baseUrl: string; apiKey: string }) => json<{ models: string[] }>("/api/provider/models", { method: "POST", body: JSON.stringify(body ?? {}) }),
  testProvider: (body?: object) => json<{ ok: boolean; message: string }>("/api/provider/test", { method: "POST", body: JSON.stringify(body ?? {}) }),
  saveProvider: (body: { baseUrl: string; model: string; apiKey: string }) => json<ProviderPublic>("/api/provider", { method: "PUT", body: JSON.stringify(body) }),
  switchProvider: (body: { baseUrl: string; model: string }) => json<ProviderPublic>("/api/provider", { method: "PATCH", body: JSON.stringify(body) }),
  deleteProvider: () => json<void>("/api/provider", { method: "DELETE" }),
  setProviderMode: (mode: "shared" | "personal") => json<ProviderPublic>("/api/provider/mode", { method: "PATCH", body: JSON.stringify({ mode }) }),
  getTestProvider: () => json<SharedProviderPublic & { keyConfigured: boolean }>("/api/admin/test-provider"),
  updateTestProvider: (body: { enabled: boolean; expiresAt: string | null }) => json<SharedProviderPublic & { keyConfigured: boolean }>("/api/admin/test-provider", { method: "PUT", body: JSON.stringify(body) }),
  adminDashboard: (query: { q?: string; status?: UserStatus; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.status) params.set("status", query.status);
    params.set("page", String(query.page ?? 1)); params.set("pageSize", String(query.pageSize ?? 20));
    return json<AdminDashboardResponse>(`/api/admin/dashboard?${params}`);
  },
  setUserStatus: (id: number, status: UserStatus) => json<void>(`/api/admin/users/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  revokeUserSessions: (id: number) => json<void>(`/api/admin/users/${id}/revoke-sessions`, { method: "POST" }),
  setRegistration: (enabled: boolean) => json<{ registrationEnabled: boolean }>("/api/admin/settings/registration", { method: "PATCH", body: JSON.stringify({ enabled }) }),
  resetProject: () => json<BootstrapResponse>("/api/project", { method: "DELETE" }),
  generatePlan: () => json<{ plan: LearningPlan }>("/api/plan/generate", { method: "POST" }),
  revisePlan: (content: string) => json<{ plan: LearningPlan }>("/api/plan/revise", { method: "POST", body: JSON.stringify({ content }) }),
  confirmPlan: () => json<BootstrapResponse>("/api/plan/confirm", { method: "POST" }),
  startLesson: (id: number) => json<BootstrapResponse>(`/api/lessons/${id}/start`, { method: "POST" }),
  evaluate: (id: number) => json<{ evaluationId: number; result: Evaluation }>(`/api/lessons/${id}/evaluate`, { method: "POST" }),
  decide: (id: number, evaluationId: number, decision: "complete" | "continue") => json<BootstrapResponse>(`/api/lessons/${id}/complete`, { method: "POST", body: JSON.stringify({ evaluationId, decision }) })
};

export async function streamMessage(url: string, content: string, handlers: { token: (text: string) => void; done: () => void; error: (message: string) => void }, signal: AbortSignal) {
  const response = await fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }), signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401) window.dispatchEvent(new Event("ailearn:unauthenticated"));
    throw new ApiError(body?.error?.message ?? "发送失败", body?.error?.code);
  }
  if (!response.body) throw new ApiError("浏览器未收到数据流");
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? "";
    for (const event of events) {
      const type = event.match(/^event:\s*(.+)$/m)?.[1], data = event.match(/^data:\s*(.+)$/m)?.[1];
      if (!data) continue; const parsed = JSON.parse(data);
      if (type === "token") handlers.token(parsed.text);
      if (type === "done") handlers.done();
      if (type === "error") handlers.error(parsed.message ?? "生成中断");
    }
    if (done) break;
  }
}
