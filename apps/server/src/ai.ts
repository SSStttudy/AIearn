export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ProviderConnection = { baseUrl: string; apiKey: string; model: string };

export class ProviderError extends Error {
  constructor(public code: string, message: string, public status = 502) { super(message); }
}

const providerUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, "")}${path}`;
export const completionUrl = (baseUrl: string) => providerUrl(baseUrl, "/chat/completions");
export const modelsUrl = (baseUrl: string) => providerUrl(baseUrl, "/models");

function classify(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("authentication_failed", "API Key 鉴权失败", 400);
  if (status === 404) return new ProviderError("model_or_endpoint_not_found", "模型或接口不存在，请检查 Base URL", 400);
  if (status === 429) return new ProviderError("rate_limited", "请求被限流，请稍后重试", 429);
  return new ProviderError("provider_error", `模型服务请求失败（${status}）${body ? `：${body.slice(0, 160)}` : ""}`, 502);
}

async function checked(response: Response) {
  if (!response.ok) throw classify(response.status, await response.text());
  return response;
}

async function request(url: string, apiKey: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${apiKey}` } });
  } catch {
    throw new ProviderError("unreachable", "无法连接模型服务，请检查 Base URL 和网络", 400);
  }
}

export async function listModels(input: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const response = await request(modelsUrl(input.baseUrl), input.apiKey, { method: "GET", headers: { accept: "application/json" } });
  await checked(response);
  const payload: any = await response.json().catch(() => { throw new ProviderError("incompatible_response", "模型列表响应不是有效 JSON", 400); });
  if (!Array.isArray(payload?.data)) throw new ProviderError("incompatible_response", "该接口没有返回兼容的模型列表", 400);
  const ids: string[] = payload.data.flatMap((item: any) => typeof item?.id === "string" && item.id.length > 0 ? [item.id] : []);
  return [...new Set<string>(ids)].sort();
}

export async function complete(config: ProviderConnection, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const response = await request(completionUrl(config.baseUrl), config.apiKey, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.3, stream: false }), signal
  });
  await checked(response);
  const json: any = await response.json().catch(() => { throw new ProviderError("incompatible_response", "接口响应不是有效 JSON", 400); });
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new ProviderError("incompatible_response", "接口响应格式不兼容", 400);
  return text;
}

export async function* stream(config: ProviderConnection, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
  const response = await request(completionUrl(config.baseUrl), config.apiKey, {
    method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.55, stream: true }), signal
  });
  await checked(response);
  if (!response.body) throw new ProviderError("incompatible_response", "接口未返回数据流", 400);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const parts = buffer.split(/\r?\n\r?\n/); buffer = parts.pop() ?? "";
    for (const part of parts) for (const line of part.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (data === "[DONE]") return;
      let item: any; try { item = JSON.parse(data); } catch { continue; }
      const token = item?.choices?.[0]?.delta?.content; if (typeof token === "string") yield token;
    }
    if (done) break;
  }
}

export function extractJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
}
