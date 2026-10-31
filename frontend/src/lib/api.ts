export class RequestError extends Error {
  constructor(public readonly kind: "timeout" | "network" | "response" | "cancelled") {
    super(kind);
  }
}

export async function request(
  path: string, init: RequestInit = {}, timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (init.signal?.aborted) throw new RequestError("cancelled");
  init.signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    // Read the body inside the timeout, not only the HTTP headers.
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch {
    throw new RequestError(timedOut ? "timeout" : init.signal?.aborted ? "cancelled" : "network");
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}

export async function jsonRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const response = await request(path, init, timeoutMs);
  if (!response.ok) throw new RequestError("response");
  try { return await response.json() as T; } catch { throw new RequestError("response"); }
}

export function post(body: unknown, signal?: AbortSignal): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal };
}

export function messageFor(error: unknown): string {
  return error instanceof RequestError && error.kind === "timeout"
    ? "服务响应超时，请稍后重试。"
    : "暂时无法连接服务，请联系现场工作人员。";
}
