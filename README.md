# AIearn

AIearn 是一个面向本机与局域网测试的多用户 AI 学习助手。它通过对话了解目标，生成可确认的整体计划，再依据实际进度动态构建课程、教学和评估。每个账号拥有独立的一份计划、课程、消息和进度。

## 已实现的 MVP 流程

`模型配置 → 需求访谈 → 生成/修订计划 → 确认 → 动态课程 → 导师对话 → 证据评估 → 用户决定 → 下一课`

- Vue 3 + TypeScript + Vite 前端
- Express + TypeScript 后端
- MySQL 持久化项目、消息、课程和评估
- OpenAI 兼容 `/chat/completions`，聊天使用 SSE 流式传输
- AES-256-GCM 加密 API Key，随机 IV，配置 ID 与 Base URL 作为 AAD
- 计划和评估使用共享 Zod schema；模型格式错误自动修复一次
- 内置六类提示词，普通聊天不能直接修改产品状态
- 用户名与密码登录，服务端会话 Cookie 和严格的数据归属检查
- 管理员可限时开放固定为 `deepseek-v4-flash` 的共享测试接口

## 本地启动

要求：Node.js 20+、npm、MySQL 8。

1. 复制环境文件：

   ```powershell
   Copy-Item .env.example .env
   ```

2. 修改 `.env` 中的 `DATABASE_URL`。迁移器会自动创建 URL 里的数据库。
3. 如果需要共享测试 API，在 DeepSeek 撤销曾经暴露的 Key、生成新 Key，并只写入本机 `.env`：

   ```dotenv
   AILEARN_TEST_API_KEY=sk-新生成的Key
   ```

   共享 Base URL 固定为 `https://api.deepseek.com`，模型固定为 `deepseek-v4-flash`。Key 不进入数据库或浏览器。
4. 安装并迁移：

   ```powershell
   npm install
   npm run db:migrate
   ```

5. 启动前后端：

   ```powershell
   npm run dev
   ```

6. 启动后，服务器终端会显示一次性管理员认领码。打开 `http://localhost:5173`，使用认领码注册首个管理员账号；现有单用户数据会自动归入该账号。

## 局域网测试

1. 在 Windows 中运行 `ipconfig`，找到当前网络的 IPv4，例如 `192.168.0.114`。
2. 将 `.env` 中的来源配置为实际地址：

   ```dotenv
   WEB_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://192.168.0.114:5173
   ```

3. 运行 `npm run dev`。Vite 监听 `0.0.0.0:5173`，Express 只监听 `127.0.0.1:8787`，外部设备只能通过 Vite 的 `/api` 代理访问后端。
4. 如 Windows 防火墙询问，只允许 Node.js 在专用网络访问；也可手动放行 TCP 5173 的专用网络入站。
5. 同一局域网的测试者访问 `http://192.168.0.114:5173` 注册。管理员认领完成后注册对局域网开放。

管理员可通过顶栏的“管理后台”查看聚合运行状态、开放或关闭注册、停用或恢复测试账号、强制用户退出，并启用共享 DeepSeek、选择截止时间。系统会先测试连接；到期后共享接口自动停用。用户已有个人 API 时自动回退，否则保留只读学习数据并提示配置个人 API。

管理后台不会展示用户对话、课程内容、评估证据或个人 API 配置。停用账号会立即撤销该用户的全部会话，但不会删除学习数据；恢复后可继续登录学习。

## Base URL 示例

OpenAI 官方兼容地址通常填写 `https://api.openai.com/v1`。其他兼容服务应填写到版本层级，AIearn 会在后面追加 `/chat/completions`。

## API Key 安全行为

- 个人 API Key 只从设置表单传给后端；不写入 localStorage/sessionStorage，不返回给网页。
- 首次启动时，如果未设置 `AILEARN_SECRET_KEY`，后端生成 32 字节主密钥并保存到 `data/.ailearn-secret`。
- 数据库仅保存个人 Key 密文、后四位、Base URL、模型和验证时间；加密上下文包含账号 ID，密文不能跨账号替换。
- 共享 DeepSeek Key 只从 `AILEARN_TEST_API_KEY` 读取，不写入数据库、日志或响应。
- `data/.ailearn-secret` 与数据库密文必须分开备份。主密钥丢失时，旧 Key 无法恢复；网页会提示重新授权，学习数据不会删除。
- 首版不支持密钥轮换。若通过环境变量提供主密钥，应使用 32 字节 base64 或 64 位 hex，并保持稳定。

生成 base64 主密钥的 Node 命令：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 常用命令

```powershell
npm run dev
npm run build
npm run typecheck
npm test
npm run db:migrate
```

## 数据与边界

每个账号只能管理一个学习项目。当前版本不含邮箱、验证码、找回密码、账号删除、密码重置、角色修改、多项目、共享项目、公网部署、上传、语音、联网搜索、代码执行和自动判题。公网部署前仍需启用 HTTPS、设置 `COOKIE_SECURE=true`，并进行正式的安全审计。

## 目录

```text
apps/web              Vue 网页
apps/server           Express API 与学习流程
packages/shared       共享 schema 和类型
database/migrations   MySQL 迁移
prompts               内置系统提示词
data                  本地主密钥（不提交）
```
