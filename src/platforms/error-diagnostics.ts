const diagnosticKeys = new Set([
  "code", "error", "error_code", "error_subcode", "error_description", "error_summary", "error_message", "msg",
  "message", "detail", "reason", "status", "title", "type", "serviceerrorcode",
]);
const secretKey = /auth|token|secret|password|credential|signature|session|upload[_-]?id|api[_-]?key|cookie|^code$|verifier/i;
const bodyLimit = 4096;
const previewLimit = 700;

export async function responseDiagnostics(response: Response, url: URL, request: RequestInit) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (size < bodyLimit) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = bodyLimit - size;
      text += decoder.decode(part.value.subarray(0, remaining), { stream: true });
      size += part.value.byteLength;
    }
    text += decoder.decode();
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => {});
  }

  // Keep standard error fields only. Never log arbitrary bodies or request data.
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { return undefined; }
  const messages: string[] = [];
  function collect(value: unknown, depth: number) {
    if (!value || typeof value !== "object" || depth > 3 || messages.length >= 8) return;
    for (const [key, field] of Object.entries(value).slice(0, 16)) {
      if (messages.length >= 8) break;
      if (diagnosticKeys.has(key.toLowerCase()) && (typeof field === "string" || typeof field === "number")) {
        messages.push(`${key}=${field}`);
      } else if (["error", "errors", "data", "error_details"].includes(key) || Array.isArray(value)) {
        collect(field, depth + 1);
      }
    }
  }
  collect(data, 0);
  if (!messages.length) return undefined;

  const form = request.body instanceof URLSearchParams || request.body instanceof FormData ? request.body : undefined;
  const fields = [...url.searchParams, ...new Headers(request.headers), ...(form ?? [])];
  const secrets = fields.flatMap(([key, value]) => secretKey.test(key) && typeof value === "string"
    ? [value, ...value.split(/[\s|]+/)].filter(part => part.length >= 4) : []);
  return messages.map(message => {
    let clean = message;
    for (const secret of secrets) {
      clean = clean.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
    }
    return clean
      .replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
      .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, "[credential]")
      .replace(/\b(?:[\w-]*(?:token|secret|password|credential|signature|cookie|api[_-]?key)[\w-]*)\b["']?\s*[:=]\s*.*$/gi, "[credential]")
      .replace(/[A-Za-z0-9_./+=%-]{24,}/g, "[redacted]")
      .replace(/[\r\n\t]/g, " ");
  }).join(" | ").slice(0, previewLimit);
}
