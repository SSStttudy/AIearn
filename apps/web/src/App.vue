<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { AdminDashboardResponse, AuthBootstrapResponse, BootstrapResponse, Evaluation, LessonView, MessageView, SharedProviderPublic, UserStatus } from "@ailearn/shared";
import { api, ApiError, streamMessage } from "./api";
import MarkdownContent from "./components/MarkdownContent.vue";

const state = ref<BootstrapResponse | null>(null);
const auth = ref<AuthBootstrapResponse | null>(null), authView = ref<"login" | "register">("login");
const authForm = ref({ username: "", password: "", bootstrapCode: "" });
const loading = ref(true), busy = ref(false), planning = ref(false), error = ref("");
const draft = ref(""), streaming = ref(false), controller = ref<AbortController | null>(null);
const showSettings = ref(false), evaluation = ref<{ evaluationId: number; result: Evaluation } | null>(null);
const planExpanded = ref(false), selectedLessonId = ref<number | null>(null);
const planTouchStart = ref<{ x: number; y: number } | null>(null);
const contentPane = ref<HTMLElement | null>(null), sidebarPane = ref<HTMLElement | null>(null), conversationEnd = ref<HTMLElement | null>(null);
const form = ref({ baseUrl: "https://api.openai.com/v1", model: "", apiKey: "" });
const testing = ref(false), fetchingModels = ref(false), testResult = ref(""), models = ref<string[]>([]), modelsOpen = ref(false);
const adminProvider = ref<(SharedProviderPublic & { keyConfigured: boolean }) | null>(null);
const testProviderForm = ref({ enabled: false, expiresAt: "" }), savingTestProvider = ref(false);
const adminView = ref(false), adminData = ref<AdminDashboardResponse | null>(null), adminLoading = ref(false), adminAction = ref<number | null>(null);
const adminQuery = ref(""), adminStatus = ref<"all" | UserStatus>("all"), adminPage = ref(1), adminRefreshedAt = ref<Date | null>(null);

const currentLesson = computed(() => state.value?.lessons.find(x => x.id === state.value?.currentLessonId) ?? null);
const selectedLesson = computed(() => state.value?.lessons.find(x => x.id === selectedLessonId.value) ?? currentLesson.value);
const stage = computed(() => state.value?.project?.status ?? "discovery");
const visibleMessages = computed(() => state.value?.messages ?? []);
const showProviderSetup = computed(() => Boolean(state.value && !state.value.provider.configured && state.value.project?.status === "discovery" && !state.value.project.title && !state.value.messages.length));
const phaseGroups = computed(() => {
  const groups = new Map<string, LessonView[]>();
  for (const lesson of state.value?.lessons ?? []) {
    if (!groups.has(lesson.phaseTitle)) groups.set(lesson.phaseTitle, []);
    groups.get(lesson.phaseTitle)!.push(lesson);
  }
  return [...groups.entries()];
});
const sharedExpiry = computed(() => state.value?.provider.shared.expiresAt ? new Date(state.value.provider.shared.expiresAt).toLocaleString() : "未设置");
const sharedRemaining = computed(() => { const value = state.value?.provider.shared.expiresAt; if (!value) return ""; const ms = new Date(value).getTime() - Date.now(); if (ms <= 0) return "已到期"; const hours = Math.ceil(ms / 3600000); return hours > 48 ? `约 ${Math.ceil(hours / 24)} 天` : `约 ${hours} 小时`; });

function explain(value: unknown) { error.value = value instanceof Error ? value.message : "操作失败"; }
function localDateTime(value: string) { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
function openPlan(lessonId?: number | null) { selectedLessonId.value = lessonId ?? state.value?.currentLessonId ?? null; planExpanded.value = true; }
function closePlan() { planExpanded.value = false; selectedLessonId.value = state.value?.currentLessonId ?? null; }
function expandPlanFromRail() { if (!planExpanded.value && state.value?.lessons.length) openPlan(currentLesson.value?.id); }
function selectRelativeLesson(offset: number) {
  const lessons = state.value?.lessons ?? [];
  const index = lessons.findIndex(lesson => lesson.id === selectedLesson.value?.id);
  const next = lessons[index + offset];
  if (!next) return;
  selectedLessonId.value = next.id;
  sidebarPane.value?.scrollTo({ top: 0, behavior: "smooth" });
}
function beginPlanSwipe(event: TouchEvent) {
  const touch = event.changedTouches[0];
  if (touch) planTouchStart.value = { x: touch.clientX, y: touch.clientY };
}
function finishPlanSwipe(event: TouchEvent) {
  const start = planTouchStart.value, touch = event.changedTouches[0];
  planTouchStart.value = null;
  if (!start || !touch) return;
  const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
  if (Math.abs(dx) < 52 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
  selectRelativeLesson(dx < 0 ? 1 : -1);
}
async function scrollToConversation(behavior: ScrollBehavior = "auto") {
  await nextTick();
  conversationEnd.value?.scrollIntoView({ block: "end", behavior });
}
function returnToLatestMessage() { void scrollToConversation("smooth"); }
async function focusCurrentLesson() {
  await nextTick();
  const current = sidebarPane.value?.querySelector<HTMLElement>('[data-current="true"]');
  current?.scrollIntoView({ block: "center", behavior: "smooth" });
}
async function refresh(initial = false, keepConversation = false) {
  if (initial) loading.value = true;
  try {
    state.value = await api.bootstrap();
    const provider = state.value.provider;
    if (provider.baseUrl) form.value.baseUrl = provider.baseUrl;
    if (provider.personalModel) form.value.model = provider.personalModel;
    if (selectedLessonId.value === null) selectedLessonId.value = state.value.currentLessonId;
    await focusCurrentLesson();
    if (keepConversation) await scrollToConversation();
  } catch (value) { explain(value); }
  finally { if (initial) loading.value = false; }
}
function signedOut() { controller.value?.abort(); auth.value = { authenticated: false, setupRequired: false, registrationEnabled: true, user: null }; state.value = null; showSettings.value = false; adminView.value = false; }
async function initialize() {
  loading.value = true;
  try { auth.value = await api.authBootstrap(); if (auth.value.setupRequired) authView.value = "register"; if (auth.value.authenticated) await refresh(false); }
  catch (value) { explain(value); }
  finally { loading.value = false; }
}
async function submitAuth() {
  busy.value = true; error.value = "";
  try {
    if (authView.value === "register") await api.register({ username: authForm.value.username, password: authForm.value.password, bootstrapCode: auth.value?.setupRequired ? authForm.value.bootstrapCode : undefined });
    else await api.login({ username: authForm.value.username, password: authForm.value.password });
    authForm.value.password = ""; authForm.value.bootstrapCode = ""; auth.value = await api.authBootstrap(); await refresh(false);
  } catch (value) { explain(value); }
  finally { busy.value = false; }
}
async function logout() { try { await api.logout(); } finally { signedOut(); auth.value = await api.authBootstrap().catch(() => auth.value); } }
async function openSettings() {
  showSettings.value = true; testResult.value = "";
}
async function switchProviderMode(mode: "shared" | "personal") { busy.value = true; try { await api.setProviderMode(mode); await refresh(false); } catch (value) { explain(value); } finally { busy.value = false; } }
async function saveTestProvider() {
  savingTestProvider.value = true; testResult.value = "";
  try { adminProvider.value = await api.updateTestProvider({ enabled: testProviderForm.value.enabled, expiresAt: testProviderForm.value.enabled && testProviderForm.value.expiresAt ? new Date(testProviderForm.value.expiresAt).toISOString() : null }); testResult.value = adminProvider.value.enabled ? "✓ 共享 DeepSeek Flash 已启用" : "共享测试接口已停用"; await Promise.all([refresh(false), refreshAdmin()]); }
  catch (value) { testResult.value = `✕ ${value instanceof Error ? value.message : "保存失败"}`; }
  finally { savingTestProvider.value = false; }
}
async function refreshAdmin() {
  if (state.value?.user.role !== "admin") return;
  adminLoading.value = true;
  try {
    adminData.value = await api.adminDashboard({ q: adminQuery.value.trim() || undefined, status: adminStatus.value === "all" ? undefined : adminStatus.value, page: adminPage.value });
    adminProvider.value = adminData.value.sharedProvider;
    testProviderForm.value = { enabled: adminProvider.value.enabled, expiresAt: adminProvider.value.expiresAt ? localDateTime(adminProvider.value.expiresAt) : "" };
    adminRefreshedAt.value = new Date();
  } catch (value) { explain(value); }
  finally { adminLoading.value = false; }
}
async function openAdmin() { if (state.value?.user.role !== "admin") return; showSettings.value = false; adminView.value = true; adminPage.value = 1; await refreshAdmin(); }
function closeAdmin() { adminView.value = false; }
async function filterAdmin() { adminPage.value = 1; await refreshAdmin(); }
async function changeAdminPage(page: number) { if (!adminData.value || page < 1 || page > adminData.value.pagination.totalPages) return; adminPage.value = page; await refreshAdmin(); }
async function toggleRegistration() {
  if (!adminData.value) return;
  const enabled = !adminData.value.settings.registrationEnabled;
  try { await api.setRegistration(enabled); adminData.value.settings.registrationEnabled = enabled; if (auth.value) auth.value.registrationEnabled = enabled; }
  catch (value) { explain(value); }
}
async function changeUserStatus(id: number, status: UserStatus) {
  const verb = status === "disabled" ? "停用" : "恢复";
  if (!confirm(`确定${verb}这个账号？${status === "disabled" ? "该用户会立即退出所有设备。" : ""}`)) return;
  adminAction.value = id;
  try { await api.setUserStatus(id, status); await refreshAdmin(); }
  catch (value) { explain(value); }
  finally { adminAction.value = null; }
}
async function revokeSessions(id: number) {
  if (!confirm("强制退出该用户的所有设备？账号和学习数据会保留。")) return;
  adminAction.value = id;
  try { await api.revokeUserSessions(id); await refreshAdmin(); }
  catch (value) { explain(value); }
  finally { adminAction.value = null; }
}
const projectStatusText = (status?: string | null) => ({ discovery: "需求访谈", plan_review: "计划确认", active: "学习中", completed: "已完成" }[status ?? ""] ?? "暂无项目");
const formatTime = (value: string | Date | null) => value ? new Date(value).toLocaleString() : "—";
const onUnauthenticated = () => signedOut();
onMounted(() => { window.addEventListener("ailearn:unauthenticated", onUnauthenticated); void initialize(); });
onBeforeUnmount(() => window.removeEventListener("ailearn:unauthenticated", onUnauthenticated));

async function fetchModels(useSaved = false) {
  fetchingModels.value = true; testResult.value = "";
  try {
    const body = useSaved && !form.value.apiKey ? undefined : { baseUrl: form.value.baseUrl, apiKey: form.value.apiKey };
    if (body && !body.apiKey) throw new ApiError("请先输入 API Key");
    const result = await api.getModels(body);
    models.value = result.models;
    modelsOpen.value = result.models.length > 0;
    testResult.value = result.models.length ? `已获取 ${result.models.length} 个模型` : "接口没有返回可用模型";
    if (!form.value.model && result.models.length) form.value.model = result.models[0];
  } catch (value) { testResult.value = `获取失败：${value instanceof Error ? value.message : "未知错误"}`; }
  finally { fetchingModels.value = false; }
}
async function testProvider(existing = false) {
  testing.value = true; testResult.value = "";
  try { const result = await api.testProvider(existing && !form.value.apiKey ? undefined : form.value); testResult.value = `✓ ${result.message}`; }
  catch (value) { testResult.value = `✕ ${value instanceof Error ? value.message : "连接失败"}`; }
  finally { testing.value = false; }
}
async function saveProvider() {
  busy.value = true; error.value = "";
  try { await api.saveProvider(form.value); form.value.apiKey = ""; modelsOpen.value = false; showSettings.value = false; await refresh(false); }
  catch (value) { explain(value); }
  finally { busy.value = false; }
}
async function saveSettings() {
  busy.value = true; error.value = "";
  try {
    if (form.value.apiKey) await api.saveProvider(form.value);
    else await api.switchProvider({ baseUrl: form.value.baseUrl, model: form.value.model });
    form.value.apiKey = ""; modelsOpen.value = false; showSettings.value = false; await refresh(false);
  } catch (value) { explain(value); }
  finally { busy.value = false; }
}
async function removeProvider() {
  if (!confirm("彻底删除模型配置？学习数据会保留，但在重新配置前无法继续对话。")) return;
  await api.deleteProvider(); showSettings.value = false; models.value = []; modelsOpen.value = false; await refresh(false);
}
async function clearPlan() {
  if (!confirm("清除当前计划、课程、对话和进度？模型配置会保留，此操作无法撤销。")) return;
  busy.value = true;
  try { state.value = await api.resetProject(); draft.value = ""; evaluation.value = null; showSettings.value = false; planExpanded.value = false; selectedLessonId.value = null; await scrollToConversation(); }
  catch (value) { explain(value); }
  finally { busy.value = false; }
}

async function send() {
  const text = draft.value.trim(); if (!text || streaming.value) return;
  draft.value = ""; error.value = "";
  const optimistic: MessageView = { id: -Date.now(), role: "user", content: text, createdAt: new Date().toISOString() };
  const answer: MessageView = { id: -Date.now() - 1, role: "assistant", content: "", createdAt: new Date().toISOString() };
  state.value?.messages.push(optimistic, answer); await scrollToConversation("smooth");
  const url = stage.value === "discovery" ? "/api/discovery/messages" : `/api/lessons/${currentLesson.value?.id}/messages`;
  controller.value = new AbortController(); streaming.value = true;
  try {
    await streamMessage(url, text, {
      token: token => { answer.content += token; void scrollToConversation(); },
      done: () => {}, error: message => { throw new ApiError(message); }
    }, controller.value.signal);
    await refresh(false, true);
  } catch (value) { if ((value as Error).name !== "AbortError") explain(value); }
  finally { streaming.value = false; controller.value = null; await scrollToConversation(); }
}
async function generatePlan() {
  busy.value = true; planning.value = true; error.value = "";
  try { await api.generatePlan(); await refresh(false); }
  catch (value) { explain(value); }
  finally { busy.value = false; planning.value = false; }
}
async function revisePlan() {
  const text = draft.value.trim(); if (!text) return; draft.value = ""; busy.value = true; planning.value = true;
  try { await api.revisePlan(text); await refresh(false); }
  catch (value) { explain(value); }
  finally { busy.value = false; planning.value = false; }
}
async function confirmPlan() { busy.value = true; try { state.value = await api.confirmPlan(); await focusCurrentLesson(); await startCurrent(); } catch (value) { explain(value); } finally { busy.value = false; } }
async function startCurrent() { const id = state.value?.currentLessonId; if (!id) return; busy.value = true; try { state.value = await api.startLesson(id); await focusCurrentLesson(); await scrollToConversation(); } catch (value) { explain(value); } finally { busy.value = false; } }
async function requestEvaluation() { if (!currentLesson.value) return; busy.value = true; try { evaluation.value = await api.evaluate(currentLesson.value.id); } catch (value) { explain(value); } finally { busy.value = false; } }
async function decide(decision: "complete" | "continue") { if (!evaluation.value || !currentLesson.value) return; busy.value = true; try { state.value = await api.decide(currentLesson.value.id, evaluation.value.evaluationId, decision); evaluation.value = null; await focusCurrentLesson(); if (decision === "complete" && state.value.currentLessonId) await startCurrent(); } catch (value) { explain(value); } finally { busy.value = false; } }
</script>

<template>
  <div v-if="loading" class="splash"><div class="brand-mark">A</div><p>正在唤醒你的学习空间…</p></div>
  <section v-else-if="auth&&!auth.authenticated" class="auth-shell">
    <div class="auth-brand"><span class="brand-mark">A</span><b>AIearn</b></div>
    <div class="auth-copy"><div class="eyebrow">局域网学习空间</div><h1>你的计划，<br><em>只属于你的账号。</em></h1><p>登录后继续自己的计划、课程、对话与进度。其他测试者无法看到你的学习数据。</p></div>
    <form class="auth-card" @submit.prevent="submitAuth">
      <div class="auth-tabs" v-if="!auth.setupRequired"><button type="button" :class="{active:authView==='login'}" @click="authView='login'">登录</button><button v-if="auth.registrationEnabled" type="button" :class="{active:authView==='register'}" @click="authView='register'">注册</button></div>
      <div v-if="!auth.setupRequired&&!auth.registrationEnabled" class="registration-closed">管理员已关闭新账号注册，已有账号仍可正常登录。</div>
      <div v-if="auth.setupRequired"><div class="eyebrow">首次初始化</div><h2>创建管理员账号</h2><p>请查看运行 AIearn 的服务器终端，输入一次性认领码。现有计划和模型配置将归属此账号。</p></div>
      <label>用户名<input v-model="authForm.username" autocomplete="username" minlength="3" maxlength="32" placeholder="3–32 位中英文、数字、_ 或 -"/></label>
      <label>密码<input v-model="authForm.password" type="password" :autocomplete="authView==='login'?'current-password':'new-password'" minlength="8" maxlength="128" placeholder="至少 8 位"/></label>
      <label v-if="auth.setupRequired">管理员认领码<input v-model="authForm.bootstrapCode" autocomplete="off" maxlength="64" placeholder="服务器终端中的认领码"/></label>
      <div v-if="error" class="error-banner">{{error}}<button type="button" @click="error=''">×</button></div>
      <button class="btn primary auth-submit" :disabled="busy||!authForm.username||authForm.password.length<8||(auth.setupRequired&&!authForm.bootstrapCode)">{{busy?'请稍候…':auth.setupRequired?'认领并进入':authView==='login'?'登录':'创建账号'}} →</button>
    </form>
  </section>
  <main v-else-if="state" class="shell">
    <header class="topbar">
      <a class="brand" href="#"><span class="brand-mark small">A</span><span>AIearn</span></a>
      <div class="top-actions"><span v-if="state.provider.configured&&!adminView" class="model-pill"><i></i>{{state.provider.activeSource==='shared'?'共享 · ':''}}{{state.provider.model}}</span><button v-if="state.user.role==='admin'" type="button" class="admin-entry" @click="adminView?closeAdmin():openAdmin()">{{adminView?'返回学习':'管理后台'}}</button><span class="user-pill">{{state.user.username}}<b v-if="state.user.role==='admin'">管理员</b></span><button v-if="!adminView" type="button" class="icon-btn" aria-label="打开设置" title="设置" @click="openSettings"><span>⚙</span></button><button type="button" class="logout-btn" @click="logout">退出</button></div>
    </header>

    <section v-if="adminView" class="admin-page">
      <div class="admin-page-head"><div><div class="eyebrow">AIearn · 管理后台</div><h1>保持学习空间<em>清晰可控。</em></h1><p>这里只展示账号和学习进度的聚合状态，不读取用户的对话、课程内容或个人 API 配置。</p></div><div class="admin-refresh"><span>上次刷新：{{formatTime(adminRefreshedAt)}}</span><button type="button" class="btn ghost" :disabled="adminLoading" @click="refreshAdmin">{{adminLoading?'刷新中…':'刷新数据'}}</button></div></div>
      <div v-if="error" class="error-banner">{{error}}<button type="button" @click="error=''">×</button></div>
      <div v-if="adminData" class="admin-dashboard">
        <section class="admin-stat-grid">
          <article><span>全部用户</span><b>{{adminData.stats.totalUsers}}</b><small>{{adminData.stats.activeUsers}} 正常 · {{adminData.stats.disabledUsers}} 停用</small></article>
          <article><span>有效会话</span><b>{{adminData.stats.activeSessions}}</b><small>当前未过期的登录</small></article>
          <article><span>学习中项目</span><b>{{adminData.stats.projects.active}}</b><small>{{adminData.stats.projects.completed}} 个已完成</small></article>
          <article><span>完成课程</span><b>{{adminData.stats.completedLessons}}</b><small>所有账号聚合</small></article>
        </section>
        <section class="admin-control-grid">
          <article class="admin-control-card"><div><div class="eyebrow">注册管理</div><h2>{{adminData.settings.registrationEnabled?'允许新用户注册':'新用户注册已关闭'}}</h2><p>切换只影响新账号，已有账号和学习数据不会改变。</p></div><button type="button" class="setting-toggle" :class="{on:adminData.settings.registrationEnabled}" :aria-pressed="adminData.settings.registrationEnabled" @click="toggleRegistration"><i></i><span>{{adminData.settings.registrationEnabled?'已开放':'已关闭'}}</span></button></article>
          <article class="admin-control-card shared-control"><div><div class="eyebrow">共享测试 API</div><h2>DeepSeek V4 Flash</h2><p>{{adminProvider?.keyConfigured?'服务端 Key 已配置':'服务端尚未配置 AILEARN_TEST_API_KEY'}} · {{adminProvider?.available?'当前可用':adminProvider?.enabled?'已到期或不可用':'未启用'}}</p></div><label class="switch"><input v-model="testProviderForm.enabled" type="checkbox"/><i></i></label><label>共享截止时间<input v-model="testProviderForm.expiresAt" type="datetime-local" :disabled="!testProviderForm.enabled"/></label><button type="button" class="btn primary" :disabled="savingTestProvider||(testProviderForm.enabled&&!testProviderForm.expiresAt)" @click="saveTestProvider">{{savingTestProvider?'连接测试中…':'测试并保存'}}</button><span class="test-result">{{testResult}}</span></article>
        </section>
        <section class="admin-users">
          <div class="admin-users-head"><div><div class="eyebrow">账号管理</div><h2>用户与学习进度</h2></div><form class="admin-filters" @submit.prevent="filterAdmin"><input v-model="adminQuery" placeholder="搜索用户名" maxlength="64"/><select v-model="adminStatus" aria-label="账号状态"><option value="all">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option></select><button class="btn ghost">筛选</button></form></div>
          <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>用户</th><th>最近活动</th><th>学习项目</th><th>进度</th><th>操作</th></tr></thead><tbody><tr v-for="user in adminData.users" :key="user.id"><td data-label="用户"><div class="admin-user-name"><b>{{user.username}}</b><span :class="['status-chip',user.status]">{{user.status==='active'?'正常':'已停用'}}</span><small v-if="user.role==='admin'">管理员</small></div><small>注册于 {{formatTime(user.createdAt)}}</small></td><td data-label="最近活动">{{formatTime(user.lastActiveAt)}}</td><td data-label="学习项目"><b>{{user.project?.title||'尚未生成计划'}}</b><small>{{projectStatusText(user.project?.status)}}</small></td><td data-label="进度"><div class="user-progress"><div><i :style="{width:(user.project?.percent??0)+'%'}"></i></div><span>{{user.project?.completedLessons??0}} / {{user.project?.totalLessons??0}} · {{user.project?.percent??0}}%</span></div></td><td data-label="操作"><div v-if="user.role==='user'" class="admin-row-actions"><button type="button" :disabled="adminAction===user.id" @click="revokeSessions(user.id)">强制退出</button><button v-if="user.status==='active'" type="button" class="danger" :disabled="adminAction===user.id" @click="changeUserStatus(user.id,'disabled')">停用</button><button v-else type="button" class="restore" :disabled="adminAction===user.id" @click="changeUserStatus(user.id,'active')">恢复</button></div><span v-else class="protected-account">受保护</span></td></tr></tbody></table><div v-if="!adminData.users.length" class="admin-empty">没有符合条件的账号。</div></div>
          <footer class="admin-pagination"><span>共 {{adminData.pagination.total}} 个账号</span><div><button type="button" :disabled="adminData.pagination.page<=1||adminLoading" @click="changeAdminPage(adminData.pagination.page-1)">上一页</button><b>{{adminData.pagination.page}} / {{adminData.pagination.totalPages}}</b><button type="button" :disabled="adminData.pagination.page>=adminData.pagination.totalPages||adminLoading" @click="changeAdminPage(adminData.pagination.page+1)">下一页</button></div></footer>
        </section>
      </div>
      <div v-else class="admin-loading">{{adminLoading?'正在汇总后台数据…':'后台数据暂不可用'}}</div>
    </section>

    <section v-else-if="showProviderSetup" class="onboarding">
      <div class="eyebrow">第一步 · 连接你的 AI</div><h1>一次配置，<br><em>持续学习。</em></h1><p class="lead">Key 会由本机服务端加密保存，不进入浏览器存储，也不会出现在学习对话中。</p>
      <form class="provider-card" @submit.prevent="saveProvider">
        <label>Base URL<input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" /></label>
        <div class="form-row">
          <label>模型名<div class="input-action"><input v-model="form.model" placeholder="先获取或手动输入模型"/><button type="button" :disabled="fetchingModels||!form.apiKey" @click="fetchModels(false)">{{fetchingModels?'获取中…':'获取模型'}}</button><button v-if="models.length" type="button" class="model-toggle" :aria-expanded="modelsOpen" @click="modelsOpen=!modelsOpen">选择 {{modelsOpen?'▴':'▾'}}</button><div v-if="modelsOpen&&models.length" class="model-menu" role="listbox" aria-label="可用模型"><button v-for="model in models" :key="model" type="button" role="option" :aria-selected="form.model===model" :class="{selected:form.model===model}" @click="form.model=model;modelsOpen=false"><span>{{model}}</span><i v-if="form.model===model">✓</i></button></div></div></label>
          <label>API Key<input v-model="form.apiKey" type="password" autocomplete="off" placeholder="仅本次输入" /></label>
        </div>
        <div v-if="state.provider.needsReauthorization" class="warning">原密钥无法解密，请重新输入并保存。学习数据仍然保留。</div>
        <div class="form-actions"><button type="button" class="btn ghost" :disabled="testing||!form.model||!form.apiKey" @click="testProvider(false)">{{testing?'测试中…':'测试连接'}}</button><span class="test-result">{{testResult}}</span><button class="btn primary" :disabled="busy||!form.apiKey||!form.model">{{busy?'验证中…':'验证并安全保存'}} →</button></div>
      </form><p class="privacy-note">AES-256-GCM · 主密钥与数据库分离 · 个人配置仅当前账号可用</p>
    </section>

    <div v-else class="workspace" :class="{'plan-expanded':planExpanded}">
      <aside ref="sidebarPane" class="sidebar" @pointerdown="expandPlanFromRail" @touchstart.passive="beginPlanSwipe" @touchend.passive="finishPlanSwipe">
        <div class="mobile-plan-header"><div><span>学习计划</span><b>第 {{(selectedLesson?.lessonIndex??0)+1}} / {{state.progress.total}} 节</b></div><button type="button" @click.stop="closePlan">返回对话 →</button></div>
        <div class="project-kicker">当前学习项目</div><button type="button" class="project-title" @click="openPlan(currentLesson?.id)">{{state.project?.title||'定义你的下一次成长'}}<span>{{planExpanded?'计划详情':'展开计划'}} →</span></button>
        <div v-if="state.lessons.length" class="progress"><div><b>{{state.progress.percent}}%</b><span>{{state.progress.completed}} / {{state.progress.total}} 节</span></div><div class="progress-track"><i :style="{width:state.progress.percent+'%'}"></i></div></div>
        <div v-if="planExpanded&&state.lessons.length" class="plan-overview" aria-label="计划总览">
          <article><span>课程</span><b>{{state.progress.total}}</b><small>节</small></article>
          <article><span>已完成</span><b>{{state.progress.completed}}</b><small>节</small></article>
          <article><span>当前</span><b>{{(currentLesson?.lessonIndex??0)+1}}</b><small>/ {{state.progress.total}}</small></article>
        </div>
        <div v-if="stage==='discovery'" class="side-hint"><span>01</span><p>告诉我你想学什么，我们会一起把模糊目标变成可执行计划。</p></div>
        <div v-else-if="stage==='plan_review'" class="side-hint"><span>02</span><p>检查课程节奏和最终成果。计划只有在你确认后才会生效。</p></div>
        <div v-else class="active-plan">
        <Transition name="detail-rise">
          <article v-if="planExpanded&&selectedLesson" class="lesson-detail-card">
            <nav class="mobile-lesson-pager" aria-label="切换课程"><button type="button" :disabled="selectedLesson.lessonIndex===0" aria-label="上一节" @click.stop="selectRelativeLesson(-1)">←</button><span>左右滑动切换课程</span><button type="button" :disabled="selectedLesson.lessonIndex===state.lessons.length-1" aria-label="下一节" @click.stop="selectRelativeLesson(1)">→</button></nav>
            <div class="detail-topline"><span>{{selectedLesson.phaseTitle}}</span><b :class="selectedLesson.status">{{selectedLesson.status==='completed'?'已完成':selectedLesson.status==='in_progress'?'学习中':selectedLesson.status==='available'?'当前课程':'后续课程'}}</b></div>
            <h2>{{selectedLesson.title}}</h2>
            <div class="detail-meta"><span>第 {{selectedLesson.lessonIndex+1}} 节</span><span>{{selectedLesson.estimatedMinutes}} 分钟</span><span v-if="selectedLesson.masteryScore!==null">掌握度 {{selectedLesson.masteryScore}}</span></div>
            <section><h3>学习目标</h3><p v-for="(objective,index) in selectedLesson.objectives" :key="objective"><i>{{String(index+1).padStart(2,'0')}}</i>{{objective}}</p></section>
            <section><h3>完成证据</h3><p v-for="criterion in selectedLesson.completionCriteria" :key="criterion"><i>✓</i>{{criterion}}</p></section>
          </article>
        </Transition>
        <div class="curriculum" :class="{'with-detail':planExpanded}">
          <section v-for="([phase,items],pi) in phaseGroups" :key="phase"><h3><span>{{String(pi+1).padStart(2,'0')}}</span><b>{{phase}}</b><small>{{items.filter(item=>item.status==='completed').length}} / {{items.length}}</small></h3><div class="lesson-map"><button v-for="lesson in items" :key="lesson.id" type="button" class="lesson-item" :class="[lesson.status,{current:lesson.id===state.currentLessonId,selected:lesson.id===selectedLesson?.id}]" :data-current="lesson.id===state.currentLessonId" :aria-disabled="lesson.status==='locked'" @click="openPlan(lesson.id)"><i>{{lesson.status==='completed'?'✓':lesson.lessonIndex+1}}</i><span>{{lesson.title}}<small>{{lesson.estimatedMinutes}} 分钟 <b v-if="lesson.masteryScore!==null">· {{lesson.masteryScore}} 分</b></small></span></button></div></section>
        </div>
        </div>
        <div v-if="state.reviewItems.length" class="review-box"><h3>待复习</h3><p v-for="item in state.reviewItems" :key="item">• {{item}}</p></div>
      </aside>

      <section ref="contentPane" class="content" @pointerdown="closePlan">
        <button v-if="state.lessons.length&&!planExpanded" type="button" class="mobile-plan-open" @click.stop="openPlan(currentLesson?.id)">☰ 展开计划</button>
        <button v-if="planExpanded" type="button" class="chat-return-hint" @click.stop="closePlan">← 返回对话</button>
        <div v-if="!state.provider.configured" class="provider-unavailable"><div><b>{{state.provider.shared.enabled?'共享测试 API 已到期或不可用':'当前没有可用的 AI 接口'}}</b><span>计划、课程和历史消息仍可查看；配置个人 API 后即可继续学习。</span></div><button type="button" class="btn primary" @click.stop="openSettings">配置 API</button></div>
        <div v-if="stage==='discovery'" class="conversation-head"><div class="eyebrow">需求访谈</div><h1>先说说，<em>你想学会什么？</em></h1><p>我会了解你的基础、目标、时间和偏好。信息够了之后，由你决定何时生成计划。</p></div>
        <div v-else-if="stage==='plan_review'" class="plan-view"><div class="eyebrow">计划草案 · 可继续修订</div><h1>{{state.project?.plan?.title}}</h1><p class="plan-summary">{{state.project?.plan?.summary}}</p><div class="plan-facts"><span>周期 <b>{{state.project?.plan?.duration}}</b></span><span>投入 <b>{{state.project?.plan?.weeklyEffort}}</b></span><span>课程 <b>{{state.project?.plan?.phases.reduce((n,p)=>n+p.lessons.length,0)}} 节</b></span></div><section v-for="(phase,pi) in state.project?.plan?.phases" :key="phase.title" class="phase-card"><div class="phase-number">{{String(pi+1).padStart(2,'0')}}</div><div><h3>{{phase.title}}</h3><p>{{phase.goal}}</p><ol><li v-for="lesson in phase.lessons" :key="lesson.title"><span>{{lesson.title}}</span><small>{{lesson.estimatedMinutes}} 分钟</small></li></ol></div></section></div>
        <div v-else class="lesson-head"><div class="eyebrow">第 {{(currentLesson?.lessonIndex??0)+1}} 节 · {{currentLesson?.phaseTitle}}</div><h1>{{currentLesson?.title||'课程已完成'}}</h1><div v-if="currentLesson" class="criteria"><div><span>今天要做到</span><p v-for="objective in currentLesson.objectives" :key="objective">{{objective}}</p></div><div><span>完成证据</span><p v-for="criterion in currentLesson.completionCriteria" :key="criterion">{{criterion}}</p></div></div></div>

        <div v-if="stage!=='plan_review'" class="messages" aria-live="polite"><div v-if="!visibleMessages.length" class="welcome-message"><span class="ai-avatar">A</span><p>你好，我会先了解你的学习主题、已有基础、目标成果、时间安排与偏好。<br>从你最想学会的一件事开始吧。</p></div><article v-for="message in visibleMessages" :key="message.id" class="message" :class="message.role"><span>{{message.role==='assistant'?'A':'你'}}</span><MarkdownContent v-if="message.role==='assistant'" :source="message.content||'…'"/><div v-else>{{message.content||'…'}}</div></article></div>
        <div v-if="error" class="error-banner">{{error}}<button type="button" @click="error=''">×</button></div>
        <div v-if="stage==='plan_review'" class="composer plan-composer"><textarea v-model="draft" rows="2" :disabled="!state.provider.configured" placeholder="例如：减少理论，增加更多动手练习…" @keydown.ctrl.enter="revisePlan"></textarea><button type="button" class="btn ghost" :disabled="busy||!draft.trim()||!state.provider.configured" @click="revisePlan">按意见修订</button><button type="button" class="btn primary" :disabled="busy||!state.provider.configured" @click="confirmPlan">确认计划并开始</button></div>
        <div v-else-if="stage==='discovery'||(stage==='active'&&currentLesson)" class="composer"><button type="button" class="scroll-to-bottom" aria-label="回到最新消息" title="回到最新消息" @click.stop="returnToLatestMessage"><span></span></button><textarea v-model="draft" rows="2" :disabled="!state.provider.configured" :placeholder="state.provider.configured?(stage==='discovery'?'写下你想学习的主题…':'回答导师，或描述你的疑问…'):'请先配置可用的 API'" @keydown.ctrl.enter="send"></textarea><div class="composer-actions"><button v-if="streaming" type="button" class="stop" @click="controller?.abort()">■ 停止生成</button><span>Ctrl + Enter 发送</span><button type="button" class="send-btn" aria-label="发送" :disabled="!draft.trim()||streaming||!state.provider.configured" @click="send">↑</button></div></div>
        <div class="stage-actions"><button v-if="stage==='discovery'" type="button" class="btn primary" :disabled="busy||visibleMessages.filter(m=>m.role==='user').length<2||!state.provider.configured" @click="generatePlan">生成整体计划 →</button><button v-if="stage==='active'&&currentLesson?.status==='available'" type="button" class="btn primary" :disabled="busy||!state.provider.configured" @click="startCurrent">生成并开始本节</button><button v-if="stage==='active'&&currentLesson?.status==='in_progress'" type="button" class="btn evaluate" :disabled="busy||streaming||!state.provider.configured" @click="requestEvaluation">申请完成本节</button><div v-if="stage==='completed'" class="complete-banner">全部课程已完成。你已经把一个目标变成了一段真实的成长记录。</div></div>
        <div ref="conversationEnd" class="conversation-end" aria-hidden="true"></div>

        <div v-if="planning" class="planning-overlay" role="status"><div class="plan-orbit"><i></i><i></i><i></i><span>A</span></div><h2>{{stage==='plan_review'?'正在重构你的计划':'正在设计你的学习路径'}}</h2><p>分析目标与基础 · 安排知识顺序 · 设计完成证据</p><div class="planning-steps"><span></span><span></span><span></span></div></div>
      </section>
    </div>

    <Teleport to="body">
    <div v-if="showSettings" class="modal-backdrop modal-layer-top" @click.self="showSettings=false"><section class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button type="button" class="modal-close" aria-label="关闭设置" @click="showSettings=false">×</button><div class="eyebrow">AIearn 设置 · {{state.user.username}}</div><h2 id="settings-title">模型与学习数据</h2>
      <div class="provider-source"><div><span>当前使用</span><b>{{state.provider.activeSource==='shared'?'共享测试 API':state.provider.activeSource==='personal'?'个人 API':'暂无可用 API'}}</b><small v-if="state.provider.shared.enabled">共享测试截止：{{sharedExpiry}} · {{sharedRemaining}}</small></div><div class="source-switch"><button type="button" :class="{active:state.provider.preference==='shared'}" :disabled="busy" @click="switchProviderMode('shared')">共享 Flash</button><button type="button" :class="{active:state.provider.preference==='personal'}" :disabled="busy||!state.provider.id" @click="switchProviderMode('personal')">个人 API</button></div></div>
      <p>个人 Key：{{state.provider.keyMask||'尚未保存'}}。保存个人配置后会自动切换到个人 API。</p>
      <label>Base URL<input v-model="form.baseUrl"/></label>
      <label>模型<div class="input-action"><input v-model="form.model" placeholder="模型名称"/><button type="button" :disabled="fetchingModels" @click="fetchModels(true)">{{fetchingModels?'获取中…':'获取模型'}}</button><button v-if="models.length" type="button" class="model-toggle" :aria-expanded="modelsOpen" @click="modelsOpen=!modelsOpen">选择 {{modelsOpen?'▴':'▾'}}</button><div v-if="modelsOpen&&models.length" class="model-menu" role="listbox" aria-label="可用模型"><button v-for="model in models" :key="model" type="button" role="option" :aria-selected="form.model===model" :class="{selected:form.model===model}" @click="form.model=model;modelsOpen=false"><span>{{model}}</span><i v-if="form.model===model">✓</i></button></div></div></label>
      <label>替换 API Key（可选）<input v-model="form.apiKey" type="password" autocomplete="off" placeholder="留空则继续使用已保存 Key"/></label>
      <p class="test-result">{{testResult}}</p><div class="modal-actions"><button type="button" class="btn ghost" :disabled="testing" @click="testProvider(true)">{{testing?'测试中…':'测试当前连接'}}</button><button type="button" class="btn primary" :disabled="busy||!form.model" @click="saveSettings">{{busy?'保存中…':'保存并切换'}}</button></div>
      <div class="danger-zone"><div><b>重新开始学习</b><span>清除计划、课程、对话和进度，保留模型配置。</span></div><button type="button" @click="clearPlan">清除计划</button></div>
      <div class="danger-zone subtle"><div><b>删除模型配置</b><span>同时清除加密后的 API Key，学习数据不受影响。</span></div><button type="button" @click="removeProvider">删除配置</button></div>
    </section></div>
    </Teleport>

    <Teleport to="body">
    <div v-if="evaluation" class="modal-backdrop modal-layer-top"><section class="modal evaluation" role="dialog" aria-modal="true" aria-labelledby="evaluation-title"><div class="score-ring"><b>{{evaluation.result.masteryScore}}</b><span>掌握度</span></div><div><div class="eyebrow">本节评估</div><h2 id="evaluation-title">{{evaluation.result.recommendation==='complete'?'已经具备推进条件':'再补一小步会更稳'}}</h2><p>{{evaluation.result.summary}}</p></div><div class="eval-grid"><section><h3>已掌握</h3><p v-for="item in evaluation.result.mastered" :key="item">✓ {{item}}</p></section><section><h3>知识缺口</h3><p v-for="item in evaluation.result.gaps" :key="item">• {{item}}</p></section></div><div class="evidence"><h3>对话证据</h3><p v-for="item in evaluation.result.evidence" :key="item">“{{item}}”</p></div><div class="modal-actions"><button type="button" class="btn ghost" :disabled="busy" @click="decide('continue')">继续学习</button><button type="button" class="btn primary" :disabled="busy" @click="decide('complete')">确认完成并继续 →</button></div></section></div>
    </Teleport>
  </main>
</template>
