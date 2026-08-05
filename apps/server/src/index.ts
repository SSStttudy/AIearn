import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { evaluationSchema, learningPlanSchema, type UserPublic } from "@ailearn/shared";
import { config } from "./config.js";
import { complete, extractJson, listModels, ProviderError, stream, type ChatMessage } from "./ai.js";
import { prompt } from "./prompts.js";
import * as store from "./store.js";
import { clearSessionCookie, createSession, destroySession, ensureBootstrapCode, loginUser, registerUser, registrationEnabled, sessionCookie, sessionToken, setupRequired, userForSession } from "./auth.js";

type AuthRequest = Request & { user?: UserPublic };
const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: config.webOrigins, credentials: true }));
app.use(express.json({ limit: "256kb" }));

const providerInput = z.object({ baseUrl: z.string().url().transform(v => v.replace(/\/+$/, "")), model: z.string().min(1).max(200), apiKey: z.string().min(1).max(1000) });
const providerSelection = z.object({ baseUrl: z.string().url().transform(v => v.replace(/\/+$/, "")), model: z.string().min(1).max(200) });
const providerLookup = z.object({ baseUrl: z.string().url().transform(v => v.replace(/\/+$/, "")), apiKey: z.string().min(1).max(1000) });
const messageInput = z.object({ content: z.string().trim().min(1).max(12000) });
const username = z.string().trim().regex(/^[\p{L}\p{N}_-]{3,32}$/u, "用户名须为 3–32 位中英文、数字、下划线或短横线");
const password = z.string().min(8).max(128);
const authInput = z.object({ username, password, bootstrapCode: z.string().trim().max(64).optional() });

const safeError = (error: any) => {
  if (error instanceof ProviderError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  if (error instanceof z.ZodError) return { status: 400, body: { error: { code: "invalid_input", message: "输入格式不正确", details: error.flatten() } } };
  return { status: error?.status ?? 500, body: { error: { code: error?.code ?? "internal_error", message: error?.status ? error.message : "服务器处理失败" } } };
};
const route = (fn: (req: AuthRequest, res: Response) => Promise<void>) => (req: AuthRequest, res: Response) => fn(req, res).catch(error => { const out = safeError(error); if (out.status >= 500) console.error("Request failed", error instanceof Error ? error.message : "unknown"); if (!res.headersSent) res.status(out.status).json(out.body); });
const requireAuth = (req: AuthRequest, _res: Response, next: NextFunction) => req.user ? next() : next(Object.assign(new Error("请先登录"), { status: 401, code: "unauthenticated" }));
const requireAdmin = (req: AuthRequest, _res: Response, next: NextFunction) => req.user?.role === "admin" ? next() : next(Object.assign(new Error("需要管理员权限"), { status: 403, code: "admin_required" }));

const attempts = new Map<string, { count: number; resetAt: number }>();
function authRateLimit(max: number, windowMs: number) { return (req: Request, _res: Response, next: NextFunction) => { const name = typeof req.body?.username === "string" ? req.body.username.toLocaleLowerCase() : "unknown", key = `${req.path}:${req.ip}:${name}`, now = Date.now(), item = attempts.get(key); if (!item || item.resetAt <= now) { attempts.set(key, { count: 1, resetAt: now + windowMs }); return next(); } if (item.count >= max) return next(Object.assign(new Error("尝试次数过多，请稍后再试"), { status: 429, code: "auth_rate_limited" })); item.count++; next(); }; }

app.use((req: AuthRequest, _res, next) => { userForSession(sessionToken(req.headers.cookie)).then(user => { req.user = user ?? undefined; next(); }).catch(next); });
app.use((req, _res, next) => { if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next(); const origin = req.get("origin"), sameOrigin = `${req.protocol}://${req.get("host")}`; if (!origin || origin === sameOrigin || config.webOrigins.includes(origin)) return next(); next(Object.assign(new Error("请求来源不受信任，请配置 WEB_ORIGINS"), { status: 403, code: "origin_not_allowed" })); });

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/auth/bootstrap", route(async (req, res) => { res.json({ authenticated: Boolean(req.user), setupRequired: await setupRequired(), registrationEnabled: await registrationEnabled(), user: req.user ?? null }); }));
app.post("/api/auth/register", authRateLimit(5, 60 * 60 * 1000), route(async (req, res) => { const body = authInput.parse(req.body), user = await registerUser(body.username, body.password, body.bootstrapCode), token = await createSession(user.id); res.setHeader("set-cookie", sessionCookie(token)); res.status(201).json({ user }); }));
app.post("/api/auth/login", authRateLimit(10, 15 * 60 * 1000), route(async (req, res) => { const body = authInput.omit({ bootstrapCode: true }).parse(req.body), user = await loginUser(body.username, body.password); if (!user) throw Object.assign(new Error("用户名或密码错误"), { status: 401, code: "invalid_credentials" }); const token = await createSession(user.id); res.setHeader("set-cookie", sessionCookie(token)); res.json({ user }); }));
app.post("/api/auth/logout", route(async (req, res) => { await destroySession(sessionToken(req.headers.cookie)); res.setHeader("set-cookie", clearSessionCookie()); res.status(204).end(); }));

app.use("/api", requireAuth);
app.get("/api/auth/me", route(async (req, res) => { res.json({ user: req.user! }); }));

async function credentials(userId: number) { return store.providerCredentials(userId); }
function sse(res: Response) { res.status(200).set({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" }); res.flushHeaders(); return (type: "token" | "done" | "error", data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
async function streamConversation(req: Request, res: Response, userId: number, system: string, conversationId: number, history: ChatMessage[], content: string) { await store.addMessage(conversationId, "user", content); const abort = new AbortController(); res.on("close", () => abort.abort()); const send = sse(res); let answer = ""; try { for await (const token of stream(await credentials(userId), [{ role: "system", content: system }, ...history, { role: "user", content }], abort.signal)) { answer += token; send("token", { text: token }); } if (answer) await store.addMessage(conversationId, "assistant", answer); send("done", { saved: Boolean(answer) }); } catch (error: any) { if (!abort.signal.aborted) { const out = safeError(error); send("error", out.body.error); } } finally { res.end(); } }
async function structured<T>(userId: number, system: string, user: string, schema: z.ZodType<T>): Promise<T> { const c = await credentials(userId); let raw = await complete(c, [{ role: "system", content: system }, { role: "user", content: user }]); for (let attempt = 0; attempt < 2; attempt++) { try { return schema.parse(extractJson(raw)); } catch (error) { if (attempt === 1) throw Object.assign(new Error("模型返回的结构化内容无法通过校验"), { status: 422, code: "invalid_model_output" }); raw = await complete(c, [{ role: "system", content: system }, { role: "user", content: user }, { role: "assistant", content: raw }, { role: "user", content: `上一个 JSON 无效。请修复并只返回完整 JSON。校验提示：${error instanceof Error ? error.message : "格式错误"}` }]); } } throw new Error("unreachable"); }

app.get("/api/provider", route(async (req, res) => { res.json(await store.providerPublic(req.user!.id)); }));
app.post("/api/provider/models", route(async (req, res) => { const body = req.body?.apiKey ? providerLookup.parse(req.body) : await store.personalProviderCredentials(req.user!.id); res.json({ models: await listModels({ baseUrl: body.baseUrl, apiKey: body.apiKey }) }); }));
app.post("/api/provider/test", route(async (req, res) => { const body = req.body?.apiKey ? providerInput.parse(req.body) : await store.personalProviderCredentials(req.user!.id); const text = await complete({ baseUrl: body.baseUrl, model: body.model, apiKey: body.apiKey }, [{ role: "user", content: "Reply with OK." }]); res.json({ ok: true, message: "连接成功", sample: text.slice(0, 80) }); }));
app.put("/api/provider", route(async (req, res) => { const body = providerInput.parse(req.body); await complete(body, [{ role: "user", content: "Reply with OK." }]); res.json(await store.saveProvider(req.user!.id, body)); }));
app.patch("/api/provider", route(async (req, res) => { const body = providerSelection.parse(req.body), saved = await store.personalProviderCredentials(req.user!.id), next = { ...body, apiKey: saved.apiKey }; await complete(next, [{ role: "user", content: "Reply with OK." }]); res.json(await store.saveProvider(req.user!.id, next)); }));
app.patch("/api/provider/mode", route(async (req, res) => { const body = z.object({ mode: z.enum(["shared", "personal"]) }).parse(req.body); res.json(await store.setProviderMode(req.user!.id, body.mode)); }));
app.delete("/api/provider", route(async (req, res) => { await store.deleteProvider(req.user!.id); res.status(204).end(); }));

app.get("/api/admin/test-provider", requireAdmin, route(async (_req, res) => { res.json(await store.adminTestProvider()); }));
app.put("/api/admin/test-provider", requireAdmin, route(async (req, res) => { const body = z.object({ enabled: z.boolean(), expiresAt: z.string().datetime().nullable() }).parse(req.body); const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null; if (body.enabled) { if (!config.testApiKey) throw Object.assign(new Error("请先在服务端配置 AILEARN_TEST_API_KEY"), { status: 409, code: "provider_required" }); if (!expiresAt || expiresAt.getTime() <= Date.now()) throw Object.assign(new Error("截止时间必须晚于当前时间"), { status: 400, code: "invalid_expiry" }); await complete({ baseUrl: store.sharedBaseUrl, model: store.sharedModel, apiKey: config.testApiKey }, [{ role: "user", content: "Reply with OK." }]); } await store.updateSharedProvider(body.enabled, body.enabled ? expiresAt : null); res.json(await store.adminTestProvider()); }));
app.get("/api/admin/dashboard", requireAdmin, route(async (req, res) => {
  const query = z.object({ q: z.string().trim().max(64).optional(), status: z.enum(["active", "disabled"]).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
  res.json(await store.adminDashboard(query));
}));
app.patch("/api/admin/users/:id/status", requireAdmin, route(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id), body = z.object({ status: z.enum(["active", "disabled"]) }).parse(req.body);
  await store.setUserStatus(req.user!.id, id, body.status); res.status(204).end();
}));
app.post("/api/admin/users/:id/revoke-sessions", requireAdmin, route(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id); await store.revokeUserSessions(req.user!.id, id); res.status(204).end();
}));
app.patch("/api/admin/settings/registration", requireAdmin, route(async (req, res) => {
  const body = z.object({ enabled: z.boolean() }).parse(req.body); await store.setRegistrationEnabled(body.enabled); res.json({ registrationEnabled: body.enabled });
}));

app.get("/api/bootstrap", route(async (req, res) => { res.json(await store.bootstrap(req.user!)); }));
app.delete("/api/project", route(async (req, res) => { await store.resetProject(req.user!.id); res.json(await store.bootstrap(req.user!)); }));
app.post("/api/discovery/messages", route(async (req, res) => { const { content } = messageInput.parse(req.body), project = await store.ensureProject(req.user!.id); if (project.status !== "discovery") throw Object.assign(new Error("需求访谈阶段已结束"), { status: 409 }); const id = await store.conversation(project.id, "discovery"), history = await store.messageHistory(id); await streamConversation(req, res, req.user!.id, prompt("discovery"), id, history, content); }));
app.post("/api/plan/generate", route(async (req, res) => { const project = await store.ensureProject(req.user!.id); if (project.status !== "discovery") throw Object.assign(new Error("当前状态不能生成计划"), { status: 409 }); const transcript = await store.discoveryTranscript(project.id); if (transcript.filter(x => x.role === "user").length < 2) throw Object.assign(new Error("请先完成更多需求访谈"), { status: 409, code: "discovery_incomplete" }); const plan = await structured(req.user!.id, prompt("planner"), `访谈记录：\n${JSON.stringify(transcript)}`, learningPlanSchema); await store.saveDraftPlan(project.id, plan); const id = await store.conversation(project.id, "plan_review"); await store.addMessage(id, "assistant", `计划《${plan.title}》已经生成。你可以提出修改意见，确认后再开始学习。`); res.json({ plan }); }));
app.post("/api/plan/revise", route(async (req, res) => { const { content } = messageInput.parse(req.body), project = await store.ensureProject(req.user!.id); if (project.status !== "plan_review" || !project.current_plan) throw Object.assign(new Error("当前没有可修订的计划"), { status: 409 }); const id = await store.conversation(project.id, "plan_review"); await store.addMessage(id, "user", content); const plan = await structured(req.user!.id, prompt("plan-reviser"), `现有计划：${JSON.stringify(project.current_plan)}\n访谈：${JSON.stringify(await store.discoveryTranscript(project.id))}\n用户反馈：${content}`, learningPlanSchema); await store.saveDraftPlan(project.id, plan); await store.addMessage(id, "assistant", `已按你的反馈生成新版《${plan.title}》。请检查后确认。`); res.json({ plan }); }));
app.post("/api/plan/confirm", route(async (req, res) => { const project = await store.ensureProject(req.user!.id); await store.confirmPlan(req.user!.id, project.id); res.json(await store.bootstrap(req.user!)); }));
app.post("/api/lessons/:id/start", route(async (req, res) => { const item = await store.lesson(req.user!.id, Number(req.params.id)); if (item.status === "locked") throw Object.assign(new Error("请先完成前一节课程"), { status: 409 }); const conversationId = await store.conversation(item.project_id, "lesson", item.id); if (!item.generated_brief) { const project = await store.ensureProject(req.user!.id); const brief = await complete(await credentials(req.user!.id), [{ role: "system", content: prompt("lesson-builder") }, { role: "user", content: JSON.stringify({ plan: project.current_plan, current: { title: item.title, objectives: item.objectives, criteria: item.completion_criteria }, previous: await store.previousContext(item.project_id, item.lesson_index) }) }]); await store.saveBrief(req.user!.id, item.id, brief); await store.addMessage(conversationId, "assistant", brief); } res.json(await store.bootstrap(req.user!)); }));
app.post("/api/lessons/:id/messages", route(async (req, res) => { const { content } = messageInput.parse(req.body), item = await store.lesson(req.user!.id, Number(req.params.id)); if (item.status !== "in_progress") throw Object.assign(new Error("课程尚未开始或已经完成"), { status: 409 }); const id = await store.conversation(item.project_id, "lesson", item.id), history = await store.messageHistory(id); await streamConversation(req, res, req.user!.id, `${prompt("tutor")}\n\n本节：${item.title}\n目标：${JSON.stringify(item.objectives)}\n完成标准：${JSON.stringify(item.completion_criteria)}`, id, history, content); }));
app.post("/api/lessons/:id/evaluate", route(async (req, res) => { const item = await store.lesson(req.user!.id, Number(req.params.id)), id = await store.conversation(item.project_id, "lesson", item.id), history = await store.messageHistory(id); const result = await structured(req.user!.id, prompt("evaluator"), JSON.stringify({ lesson: { title: item.title, objectives: item.objectives, criteria: item.completion_criteria }, conversation: history }), evaluationSchema); const evaluationId = await store.saveEvaluation(item.id, result); res.json({ evaluationId, result }); }));
app.post("/api/lessons/:id/complete", route(async (req, res) => { const body = z.object({ evaluationId: z.number().int().positive(), decision: z.enum(["complete", "continue"]) }).parse(req.body); await store.decideEvaluation(req.user!.id, Number(req.params.id), body.evaluationId, body.decision); res.json(await store.bootstrap(req.user!)); }));

app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "接口不存在" } }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { const out = safeError(error); if (out.status >= 500) console.error("Request failed", error instanceof Error ? error.message : "unknown"); res.status(out.status).json(out.body); });

ensureBootstrapCode().then(() => app.listen(config.port, "127.0.0.1", () => console.info(`AIearn server listening on http://127.0.0.1:${config.port}`))).catch(error => { console.error("AIearn failed to start", error instanceof Error ? error.message : error); process.exitCode = 1; });
