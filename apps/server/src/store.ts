import type { AdminDashboardResponse, AdminUserSummary, BootstrapResponse, Evaluation, LearningPlan, LessonView, MessageView, ProviderPublic, SharedProviderPublic, UserPublic, UserStatus } from "@ailearn/shared";
import type { RowDataPacket } from "mysql2";
import { config } from "./config.js";
import { db, exec, rows } from "./db.js";
import { decryptSecret, encryptSecret, loadMasterKey, secretAad, type EncryptedSecret } from "./secret.js";

export const sharedBaseUrl = "https://api.deepseek.com";
export const sharedModel = "deepseek-v4-flash" as const;
const json = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) : value as T;

type ProviderRow = RowDataPacket & { id: number; user_id: number; base_url: string; model_name: string; encrypted_api_key: unknown; key_last_four: string; verified_at: Date | null };
type SettingsRow = RowDataPacket & { shared_provider_enabled: number | boolean; shared_provider_expires_at: Date | null; registration_enabled: number | boolean; updated_at: Date };
type UserSettingsRow = RowDataPacket & { provider_mode: "shared" | "personal" };
export type ProjectRow = RowDataPacket & { id: number; user_id: number; title: string | null; status: "discovery" | "plan_review" | "active" | "completed"; current_plan: unknown };
type LessonRow = RowDataPacket & { id: number; project_id: number; phase_index: number; lesson_index: number; phase_title: string; title: string; objectives: unknown; completion_criteria: unknown; estimated_minutes: number; generated_brief: string | null; status: "locked" | "available" | "in_progress" | "completed"; mastery_score: number | null };

async function settings(): Promise<SettingsRow> {
  const found = await rows<SettingsRow[]>("SELECT * FROM app_settings WHERE id=1");
  if (!found.length) throw new Error("应用设置尚未初始化，请先运行数据库迁移");
  return found[0];
}

export async function sharedProviderPublic(): Promise<SharedProviderPublic> {
  const value = await settings();
  const expiresAt = value.shared_provider_expires_at?.toISOString() ?? null;
  const enabled = Boolean(value.shared_provider_enabled);
  return { configured: Boolean(config.testApiKey), enabled, available: Boolean(config.testApiKey) && enabled && Boolean(value.shared_provider_expires_at && value.shared_provider_expires_at.getTime() > Date.now()), model: sharedModel, expiresAt };
}

async function personalRow(userId: number): Promise<ProviderRow | null> {
  const found = await rows<ProviderRow[]>("SELECT * FROM provider_configs WHERE user_id=? LIMIT 1", [userId]);
  return found[0] ?? null;
}

async function preference(userId: number): Promise<"shared" | "personal"> {
  const found = await rows<UserSettingsRow[]>("SELECT provider_mode FROM users WHERE id=?", [userId]);
  if (!found.length) throw Object.assign(new Error("账号不存在"), { status: 401, code: "unauthenticated" });
  return found[0].provider_mode;
}

function decryptPersonal(userId: number, provider: ProviderRow): string {
  return decryptSecret(json<EncryptedSecret>(provider.encrypted_api_key), loadMasterKey(), secretAad(userId, provider.id, provider.base_url));
}

export async function providerPublic(userId: number): Promise<ProviderPublic> {
  const [shared, mode, personal] = await Promise.all([sharedProviderPublic(), preference(userId), personalRow(userId)]);
  let personalAvailable = false, needsReauthorization = false;
  if (personal) { try { decryptPersonal(userId, personal); personalAvailable = true; } catch { needsReauthorization = true; } }
  const activeSource = mode === "personal" ? (personalAvailable ? "personal" : shared.available ? "shared" : null) : (shared.available ? "shared" : personalAvailable ? "personal" : null);
  return { configured: activeSource !== null, id: personal?.id, baseUrl: personal?.base_url, model: activeSource === "shared" ? sharedModel : personal?.model_name, personalModel: personal?.model_name, keyMask: personal ? `••••••••${personal.key_last_four}` : undefined, verifiedAt: personal?.verified_at?.toISOString() ?? null, needsReauthorization, preference: mode, activeSource, shared };
}

export async function personalProviderCredentials(userId: number): Promise<{ id: number; baseUrl: string; model: string; apiKey: string }> {
  const personal = await personalRow(userId);
  if (!personal) throw Object.assign(new Error("请先配置个人模型接口"), { status: 409, code: "provider_required" });
  try { return { id: personal.id, baseUrl: personal.base_url, model: personal.model_name, apiKey: decryptPersonal(userId, personal) }; }
  catch { throw Object.assign(new Error("个人模型配置需要重新授权"), { status: 409, code: "reauthorization_required" }); }
}

export async function providerCredentials(userId: number): Promise<{ baseUrl: string; model: string; apiKey: string }> {
  const [shared, mode] = await Promise.all([sharedProviderPublic(), preference(userId)]);
  if (mode === "shared" && shared.available) return { baseUrl: sharedBaseUrl, model: sharedModel, apiKey: config.testApiKey };
  try { const personal = await personalProviderCredentials(userId); return personal; }
  catch (error) {
    if (mode === "personal" && shared.available) return { baseUrl: sharedBaseUrl, model: sharedModel, apiKey: config.testApiKey };
    if (shared.enabled && !shared.available && !config.testApiKey) throw Object.assign(new Error("共享测试接口未配置服务端 Key"), { status: 409, code: "provider_required" });
    if (shared.enabled && !shared.available) throw Object.assign(new Error("共享测试接口已到期，请配置个人 API"), { status: 409, code: "shared_provider_expired" });
    throw error;
  }
}

export async function saveProvider(userId: number, input: { baseUrl: string; model: string; apiKey: string }): Promise<ProviderPublic> {
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    const [all] = await connection.query<ProviderRow[]>("SELECT * FROM provider_configs WHERE user_id=? LIMIT 1 FOR UPDATE", [userId]);
    let id: number;
    if (all.length) {
      id = all[0].id;
      await connection.execute("UPDATE provider_configs SET base_url=?,model_name=?,key_last_four=?,verified_at=UTC_TIMESTAMP() WHERE id=? AND user_id=?", [input.baseUrl, input.model, input.apiKey.slice(-4), id, userId]);
    } else {
      const [result] = await connection.execute<any>("INSERT INTO provider_configs(user_id,base_url,model_name,encrypted_api_key,key_last_four,verified_at) VALUES (?,?,?,JSON_OBJECT(),?,UTC_TIMESTAMP())", [userId, input.baseUrl, input.model, input.apiKey.slice(-4)]);
      id = Number(result.insertId);
    }
    const envelope = encryptSecret(input.apiKey, loadMasterKey(), secretAad(userId, id, input.baseUrl));
    await connection.execute("UPDATE provider_configs SET encrypted_api_key=? WHERE id=? AND user_id=?", [JSON.stringify(envelope), id, userId]);
    await connection.execute("UPDATE users SET provider_mode='personal' WHERE id=?", [userId]);
    await connection.commit();
    return providerPublic(userId);
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function setProviderMode(userId: number, mode: "shared" | "personal"): Promise<ProviderPublic> {
  if (mode === "personal" && !(await personalRow(userId))) throw Object.assign(new Error("请先配置个人 API"), { status: 409, code: "provider_required" });
  await exec("UPDATE users SET provider_mode=? WHERE id=?", [mode, userId]);
  return providerPublic(userId);
}

export async function deleteProvider(userId: number): Promise<void> { await exec("DELETE FROM provider_configs WHERE user_id=?", [userId]); await exec("UPDATE users SET provider_mode='shared' WHERE id=?", [userId]); }

export async function adminTestProvider(): Promise<SharedProviderPublic & { keyConfigured: boolean }> { const value = await sharedProviderPublic(); return { ...value, keyConfigured: Boolean(config.testApiKey) }; }
export async function updateSharedProvider(enabled: boolean, expiresAt: Date | null): Promise<void> { await exec("UPDATE app_settings SET shared_provider_enabled=?,shared_provider_expires_at=? WHERE id=1", [enabled, expiresAt]); }

type AdminUserRow = RowDataPacket & {
  id: number; username: string; role: "admin" | "user"; status: UserStatus; created_at: Date; last_active_at: Date;
  project_title: string | null; project_status: ProjectRow["status"] | null; completed_lessons: number; total_lessons: number;
};

export async function adminDashboard(input: { q?: string; status?: UserStatus; page: number; pageSize: number }): Promise<AdminDashboardResponse> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.q) { clauses.push("u.username LIKE ?"); params.push(`%${input.q}%`); }
  if (input.status) { clauses.push("u.status=?"); params.push(input.status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (input.page - 1) * input.pageSize;
  const [countRows, userRows, userStats, sessionStats, projectStats, lessonStats, setting, sharedProvider] = await Promise.all([
    rows<(RowDataPacket & { total: number })[]>(`SELECT COUNT(*) total FROM users u ${where}`, params),
    rows<AdminUserRow[]>(`SELECT u.id,u.username,u.role,u.status,u.created_at,
      GREATEST(u.created_at,COALESCE(p.updated_at,u.created_at),COALESCE((SELECT MAX(m.created_at) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=p.id),u.created_at),COALESCE((SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id=u.id),u.created_at)) last_active_at,
      p.title project_title,p.status project_status,
      COALESCE((SELECT COUNT(*) FROM lessons l WHERE l.project_id=p.id AND l.status='completed'),0) completed_lessons,
      COALESCE((SELECT COUNT(*) FROM lessons l WHERE l.project_id=p.id),0) total_lessons
      FROM users u LEFT JOIN projects p ON p.user_id=u.id ${where}
      ORDER BY last_active_at DESC,u.id DESC LIMIT ? OFFSET ?`, [...params, input.pageSize, offset]),
    rows<(RowDataPacket & { total: number; active: number; disabled: number })[]>("SELECT COUNT(*) total,SUM(status='active') active,SUM(status='disabled') disabled FROM users"),
    rows<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) total FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires_at>UTC_TIMESTAMP() AND u.status='active'"),
    rows<(RowDataPacket & { status: ProjectRow["status"]; total: number })[]>("SELECT status,COUNT(*) total FROM projects GROUP BY status"),
    rows<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) total FROM lessons WHERE status='completed'"),
    settings(),
    adminTestProvider()
  ]);
  const total = Number(countRows[0]?.total ?? 0);
  const projects = { discovery: 0, plan_review: 0, active: 0, completed: 0 };
  for (const item of projectStats) projects[item.status] = Number(item.total);
  const users: AdminUserSummary[] = userRows.map(item => {
    const completedLessons = Number(item.completed_lessons), totalLessons = Number(item.total_lessons);
    return { id: item.id, username: item.username, role: item.role, status: item.status, createdAt: item.created_at.toISOString(), lastActiveAt: item.last_active_at.toISOString(), project: item.project_status ? { title: item.project_title, status: item.project_status, completedLessons, totalLessons, percent: totalLessons ? Math.round(completedLessons / totalLessons * 100) : 0 } : null };
  });
  return {
    stats: { totalUsers: Number(userStats[0]?.total ?? 0), activeUsers: Number(userStats[0]?.active ?? 0), disabledUsers: Number(userStats[0]?.disabled ?? 0), activeSessions: Number(sessionStats[0]?.total ?? 0), completedLessons: Number(lessonStats[0]?.total ?? 0), projects },
    users,
    pagination: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.max(1, Math.ceil(total / input.pageSize)) },
    settings: { registrationEnabled: Boolean(setting.registration_enabled) },
    sharedProvider
  };
}

async function manageableUser(actorId: number, targetId: number): Promise<{ role: "admin" | "user" }> {
  if (actorId === targetId) throw Object.assign(new Error("不能对当前管理员账号执行此操作"), { status: 409, code: "self_admin_action" });
  const found = await rows<(RowDataPacket & { role: "admin" | "user" })[]>("SELECT role FROM users WHERE id=?", [targetId]);
  if (!found.length) throw Object.assign(new Error("账号不存在"), { status: 404, code: "not_found" });
  if (found[0].role === "admin") throw Object.assign(new Error("首版不允许管理其他管理员账号"), { status: 409, code: "admin_account_protected" });
  return found[0];
}

export async function setUserStatus(actorId: number, targetId: number, status: UserStatus): Promise<void> {
  await manageableUser(actorId, targetId);
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("UPDATE users SET status=?,disabled_at=IF(?='disabled',UTC_TIMESTAMP(),NULL) WHERE id=?", [status, status, targetId]);
    if (status === "disabled") await connection.execute("DELETE FROM sessions WHERE user_id=?", [targetId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function revokeUserSessions(actorId: number, targetId: number): Promise<void> {
  await manageableUser(actorId, targetId);
  await exec("DELETE FROM sessions WHERE user_id=?", [targetId]);
}

export async function setRegistrationEnabled(enabled: boolean): Promise<void> {
  await exec("UPDATE app_settings SET registration_enabled=? WHERE id=1", [enabled]);
}

export async function resetProject(userId: number): Promise<void> {
  const connection = await db().getConnection();
  try { await connection.beginTransaction(); await connection.execute("DELETE FROM projects WHERE user_id=?", [userId]); await connection.execute("INSERT INTO projects(user_id,status) VALUES (?,'discovery')", [userId]); await connection.commit(); }
  catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function ensureProject(userId: number): Promise<ProjectRow> {
  let found = await rows<ProjectRow[]>("SELECT * FROM projects WHERE user_id=? LIMIT 1", [userId]);
  if (!found.length) { await exec("INSERT INTO projects(user_id,status) VALUES (?,'discovery')", [userId]); found = await rows<ProjectRow[]>("SELECT * FROM projects WHERE user_id=? LIMIT 1", [userId]); }
  return found[0];
}

export async function conversation(projectId: number, kind: "discovery" | "plan_review" | "lesson", lessonId?: number) { const found = await rows<(RowDataPacket & { id: number })[]>("SELECT id FROM conversations WHERE project_id=? AND kind=? AND lesson_id <=> ? ORDER BY id DESC LIMIT 1", [projectId, kind, lessonId ?? null]); if (found.length) return found[0].id; const result = await exec("INSERT INTO conversations(project_id,lesson_id,kind) VALUES (?,?,?)", [projectId, lessonId ?? null, kind]); return result.insertId; }
export async function addMessage(conversationId: number, role: "user" | "assistant", content: string) { const result = await exec("INSERT INTO messages(conversation_id,role,content) VALUES (?,?,?)", [conversationId, role, content]); return result.insertId; }
export async function messageHistory(conversationId: number) { const found = await rows<(RowDataPacket & { role: "user" | "assistant"; content: string })[]>("SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id", [conversationId]); return found.map(({ role, content }) => ({ role, content })); }
export async function allProjectMessages(projectId: number): Promise<MessageView[]> { const found = await rows<(RowDataPacket & { id: number; role: "user" | "assistant"; content: string; created_at: Date })[]>("SELECT m.id,m.role,m.content,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=? ORDER BY m.id", [projectId]); return found.map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at.toISOString() })); }
async function contextMessages(project: ProjectRow, currentLessonId: number | null): Promise<MessageView[]> { let found: (RowDataPacket & { id: number; role: "user" | "assistant"; content: string; created_at: Date })[] = []; if (project.status === "discovery") found = await rows("SELECT m.id,m.role,m.content,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=? AND c.kind='discovery' ORDER BY m.id", [project.id]); else if ((project.status === "active" || project.status === "completed") && currentLessonId) found = await rows("SELECT m.id,m.role,m.content,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=? AND c.lesson_id=? AND c.kind='lesson' ORDER BY m.id", [project.id, currentLessonId]); return found.map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at.toISOString() })); }
export async function discoveryTranscript(projectId: number) { return messageHistory(await conversation(projectId, "discovery")); }
export async function saveDraftPlan(projectId: number, plan: LearningPlan) { await exec("UPDATE projects SET title=?,current_plan=?,status='plan_review' WHERE id=?", [plan.title, JSON.stringify(plan), projectId]); }

export async function confirmPlan(userId: number, projectId: number) {
  const project = await ensureProject(userId);
  if (project.id !== projectId || project.status !== "plan_review" || !project.current_plan) throw Object.assign(new Error("当前没有可确认的计划"), { status: 409 });
  const plan = json<LearningPlan>(project.current_plan), connection = await db().getConnection();
  try { await connection.beginTransaction(); await connection.execute("DELETE FROM lessons WHERE project_id=?", [projectId]); let index = 0; for (let p = 0; p < plan.phases.length; p++) for (const item of plan.phases[p].lessons) { await connection.execute("INSERT INTO lessons(project_id,phase_index,lesson_index,phase_title,title,objectives,completion_criteria,estimated_minutes,status) VALUES (?,?,?,?,?,?,?,?,?)", [projectId, p, index, plan.phases[p].title, item.title, JSON.stringify(item.objectives), JSON.stringify(item.completionCriteria), item.estimatedMinutes, index === 0 ? "available" : "locked"]); index++; } await connection.execute("UPDATE projects SET status='active' WHERE id=? AND user_id=?", [projectId, userId]); await connection.commit(); }
  catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function lessons(projectId: number): Promise<LessonView[]> { const found = await rows<LessonRow[]>("SELECT l.*, (SELECT e.mastery_score FROM evaluations e WHERE e.lesson_id=l.id AND e.user_decision='complete' ORDER BY e.id DESC LIMIT 1) mastery_score FROM lessons l WHERE project_id=? ORDER BY lesson_index", [projectId]); return found.map(l => ({ id: l.id, phaseIndex: l.phase_index, lessonIndex: l.lesson_index, phaseTitle: l.phase_title, title: l.title, objectives: json(l.objectives), completionCriteria: json(l.completion_criteria), estimatedMinutes: l.estimated_minutes, status: l.status, generatedBrief: l.generated_brief, masteryScore: l.mastery_score })); }
export async function lesson(userId: number, id: number) { const found = await rows<LessonRow[]>("SELECT l.*,NULL mastery_score FROM lessons l JOIN projects p ON p.id=l.project_id WHERE l.id=? AND p.user_id=?", [id, userId]); if (!found.length) throw Object.assign(new Error("课程不存在"), { status: 404, code: "not_found" }); return found[0]; }
export async function saveBrief(userId: number, id: number, brief: string) { const result = await exec("UPDATE lessons l JOIN projects p ON p.id=l.project_id SET l.generated_brief=?,l.status=IF(l.status='available','in_progress',l.status) WHERE l.id=? AND p.user_id=?", [brief, id, userId]); if (!result.affectedRows) throw Object.assign(new Error("课程不存在"), { status: 404 }); }
export async function previousContext(projectId: number, lessonIndex: number) { const found = await rows<(RowDataPacket & { title: string; generated_brief: string | null; result: unknown })[]>("SELECT l.title,l.generated_brief,(SELECT e.result FROM evaluations e WHERE e.lesson_id=l.id ORDER BY e.id DESC LIMIT 1) result FROM lessons l WHERE l.project_id=? AND l.lesson_index<? ORDER BY l.lesson_index DESC LIMIT 3", [projectId, lessonIndex]); return found.map(x => ({ title: x.title, brief: x.generated_brief, evaluation: x.result ? json<Evaluation>(x.result) : null })); }
export async function saveEvaluation(lessonId: number, value: Evaluation) { const result = await exec("INSERT INTO evaluations(lesson_id,mastery_score,result,recommendation) VALUES (?,?,?,?)", [lessonId, value.masteryScore, JSON.stringify(value), value.recommendation]); return result.insertId; }
export async function decideEvaluation(userId: number, lessonId: number, evaluationId: number, decision: "complete" | "continue") { const current = await lesson(userId, lessonId); const found = await rows<(RowDataPacket & { recommendation: "complete" | "continue" })[]>("SELECT recommendation FROM evaluations WHERE id=? AND lesson_id=?", [evaluationId, lessonId]); if (!found.length) throw Object.assign(new Error("评估不存在"), { status: 404 }); await exec("UPDATE evaluations SET user_decision=?,was_override=?,decided_at=UTC_TIMESTAMP() WHERE id=?", [decision, found[0].recommendation !== decision, evaluationId]); if (decision === "complete") { await exec("UPDATE lessons SET status='completed',completed_at=UTC_TIMESTAMP() WHERE id=?", [lessonId]); const next = await rows<(RowDataPacket & { id: number })[]>("SELECT id FROM lessons WHERE project_id=? AND lesson_index>? ORDER BY lesson_index LIMIT 1", [current.project_id, current.lesson_index]); if (next.length) await exec("UPDATE lessons SET status='available' WHERE id=? AND status='locked'", [next[0].id]); else await exec("UPDATE projects SET status='completed' WHERE id=? AND user_id=?", [current.project_id, userId]); } }

export async function bootstrap(user: UserPublic): Promise<BootstrapResponse> {
  const provider = await providerPublic(user.id), project = await ensureProject(user.id), list = await lessons(project.id), completed = list.filter(x => x.status === "completed").length, current = list.find(x => x.status === "in_progress") ?? list.find(x => x.status === "available"), currentId = current?.id ?? null;
  const gaps = (await rows<(RowDataPacket & { result: unknown })[]>("SELECT result FROM evaluations e JOIN lessons l ON l.id=e.lesson_id WHERE l.project_id=? ORDER BY e.id DESC LIMIT 10", [project.id])).flatMap(x => json<Evaluation>(x.result).gaps).slice(0, 8);
  return { user, provider, project: { id: project.id, status: project.status, title: project.title, plan: project.current_plan ? json(project.current_plan) : null }, lessons: list, messages: await contextMessages(project, currentId), currentLessonId: currentId, progress: { completed, total: list.length, percent: list.length ? Math.round(completed / list.length * 100) : 0 }, reviewItems: [...new Set(gaps)] };
}
