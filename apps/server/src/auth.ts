import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { RowDataPacket } from "mysql2";
import type { UserPublic } from "@ailearn/shared";
import { config } from "./config.js";
import { db, exec, rows } from "./db.js";
import { decryptSecret, encryptSecret, legacySecretAad, loadMasterKey, secretAad, type EncryptedSecret } from "./secret.js";

const scrypt = promisify(scryptCallback);
const bootstrapFile = path.join(config.dataDir, ".ailearn-bootstrap-code");
const sessionDays = 7;

type UserRow = RowDataPacket & { id: number; username: string; password_hash: string; role: "admin" | "user"; provider_mode: "shared" | "personal"; status: "active" | "disabled" };
type LegacyProviderRow = RowDataPacket & { id: number; base_url: string; encrypted_api_key: unknown };

const json = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) : value as T;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64");
  const actual = await scrypt(password, Buffer.from(saltText, "base64"), expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function setupRequired(): Promise<boolean> {
  const found = await rows<(RowDataPacket & { count: number })[]>("SELECT COUNT(*) count FROM users");
  return Number(found[0]?.count ?? 0) === 0;
}

export async function registrationEnabled(): Promise<boolean> {
  const found = await rows<(RowDataPacket & { registration_enabled: number | boolean })[]>("SELECT registration_enabled FROM app_settings WHERE id=1");
  return Boolean(found[0]?.registration_enabled ?? true);
}

export async function ensureBootstrapCode(): Promise<void> {
  if (!(await setupRequired())) {
    if (fs.existsSync(bootstrapFile)) fs.rmSync(bootstrapFile);
    return;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(bootstrapFile)) fs.writeFileSync(bootstrapFile, randomBytes(6).toString("hex").toUpperCase(), { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.info(`AIearn first-account claim code: ${fs.readFileSync(bootstrapFile, "utf8").trim()}`);
}

function readBootstrapCode(): string {
  try { return fs.readFileSync(bootstrapFile, "utf8").trim(); }
  catch { throw Object.assign(new Error("首次管理员认领码不可用，请重启服务生成"), { status: 409, code: "bootstrap_claim_required" }); }
}

export async function registerUser(username: string, password: string, bootstrapCode?: string): Promise<UserPublic> {
  const passwordHash = await hashPassword(password);
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    const [settings] = await connection.query<(RowDataPacket & { registration_enabled: number | boolean })[]>("SELECT registration_enabled FROM app_settings WHERE id=1 FOR UPDATE");
    const [existing] = await connection.query<(RowDataPacket & { count: number })[]>("SELECT COUNT(*) count FROM users");
    const first = Number(existing[0]?.count ?? 0) === 0;
    if (!first && !Boolean(settings[0]?.registration_enabled)) {
      throw Object.assign(new Error("管理员已关闭注册"), { status: 403, code: "registration_closed" });
    }
    if (first && (!bootstrapCode || bootstrapCode.trim().toUpperCase() !== readBootstrapCode().toUpperCase())) {
      throw Object.assign(new Error("首次注册需要服务器终端显示的认领码"), { status: 409, code: "bootstrap_claim_required" });
    }
    const [created] = await connection.execute<any>("INSERT INTO users(username,password_hash,role) VALUES (?,?,?)", [username, passwordHash, first ? "admin" : "user"]);
    const userId = Number(created.insertId);
    if (first) {
      const [legacyProjects] = await connection.query<(RowDataPacket & { id: number })[]>("SELECT id FROM projects WHERE user_id IS NULL ORDER BY id");
      const [legacyProviders] = await connection.query<LegacyProviderRow[]>("SELECT id,base_url,encrypted_api_key FROM provider_configs WHERE user_id IS NULL ORDER BY id");
      if (legacyProjects.length > 1 || legacyProviders.length > 1) throw Object.assign(new Error("检测到多条旧版数据，无法自动认领"), { status: 409, code: "legacy_data_conflict" });
      if (legacyProjects.length) await connection.execute("UPDATE projects SET user_id=? WHERE id=?", [userId, legacyProjects[0].id]);
      else await connection.execute("INSERT INTO projects(user_id,status) VALUES (?,'discovery')", [userId]);
      if (legacyProviders.length) {
        const provider = legacyProviders[0];
        const plain = decryptSecret(json<EncryptedSecret>(provider.encrypted_api_key), loadMasterKey(), legacySecretAad(provider.id, provider.base_url));
        const envelope = encryptSecret(plain, loadMasterKey(), secretAad(userId, provider.id, provider.base_url));
        await connection.execute("UPDATE provider_configs SET user_id=?,encrypted_api_key=? WHERE id=?", [userId, JSON.stringify(envelope), provider.id]);
      }
    } else await connection.execute("INSERT INTO projects(user_id,status) VALUES (?,'discovery')", [userId]);
    await connection.commit();
    if (first && fs.existsSync(bootstrapFile)) fs.rmSync(bootstrapFile);
    return { id: userId, username, role: first ? "admin" : "user" };
  } catch (error: any) {
    await connection.rollback();
    if (error?.code === "ER_DUP_ENTRY") throw Object.assign(new Error("用户名已存在"), { status: 409, code: "username_taken" });
    throw error;
  } finally { connection.release(); }
}

export async function loginUser(username: string, password: string): Promise<UserPublic | null> {
  const found = await rows<UserRow[]>("SELECT * FROM users WHERE username=? LIMIT 1", [username]);
  if (!found.length || !(await verifyPassword(password, found[0].password_hash))) return null;
  if (found[0].status === "disabled") throw Object.assign(new Error("账号已被管理员停用"), { status: 403, code: "account_disabled" });
  return { id: found[0].id, username: found[0].username, role: found[0].role };
}

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await exec("DELETE FROM sessions WHERE expires_at<=UTC_TIMESTAMP()");
  await exec(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ${sessionDays} DAY))`, [userId, tokenHash(token)]);
  return token;
}

export async function userForSession(token: string | undefined): Promise<UserPublic | null> {
  if (!token) return null;
  const found = await rows<UserRow[]>("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.status='active' LIMIT 1", [tokenHash(token)]);
  return found.length ? { id: found[0].id, username: found[0].username, role: found[0].role } : null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await exec("DELETE FROM sessions WHERE token_hash=?", [tokenHash(token)]);
}

export function sessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieHeader?.split(";").map(item => item.trim()).find(item => item.startsWith("ailearn_session="))?.slice("ailearn_session=".length);
}

export const sessionCookie = (token: string) => `ailearn_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDays * 86400}${config.cookieSecure ? "; Secure" : ""}`;
export const clearSessionCookie = () => `ailearn_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure ? "; Secure" : ""}`;
