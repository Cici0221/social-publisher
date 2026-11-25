type UploadSession = {
  id: string;
  bytes: number;
  partBytes: number;
  uploadedParts: number[];
  complete: boolean;
};

export class AssetRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function assetRequest<T>(url: string, signal?: AbortSignal, method = "GET", body?: object): Promise<T> {
  const response = await fetch(url, {
    method, signal, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) {
    throw new AssetRequestError(value?.error ?? (response.status === 401 ? "登录已过期。" : "操作未完成，请重试。"), response.status);
  }
  return value as T;
}

async function resumeCacheKey(actorId: string, file: File) {
  const descriptor = [file.name.normalize("NFC"), file.size, file.lastModified, file.type];
  const sampleSize = 64 * 1024;
  if (!crypto.subtle) return `publisher.upload.${actorId}.${JSON.stringify(descriptor)}`;
  const bytes = await new Blob([JSON.stringify(descriptor), file.slice(0, sampleSize),
    file.slice(Math.max(0, file.size - sampleSize))]).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `publisher.upload.${actorId}.${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("")}`;
}

function cachedId(key: string) {
  try { return localStorage.getItem(key) ?? undefined; }
  catch { return undefined; }
}

function remember(key: string, value?: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // This upload can proceed even when the browser blocks persistent storage.
  }
}

function putPart(url: string, body: Blob, signal: AbortSignal, progress: (bytes: number) => void) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("上传已暂停", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.timeout = 180_000;
    const abort = () => request.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    request.upload.onprogress = event => progress(Math.min(body.size, event.loaded));
    request.onload = () => request.status >= 200 && request.status < 300
      ? finish()
      : finish(new Error("对象存储拒绝分片，请检查连接后重试。"));
    request.onerror = () => finish(new Error("分片网络传输中断。"));
    request.ontimeout = () => finish(new Error("分片上传超时。"));
    request.onabort = () => finish(new DOMException("上传已暂停", "AbortError"));
    request.send(body);
  });
}

async function sendPart(session: UploadSession, part: number, body: Blob, signal: AbortSignal, progress: (bytes: number) => void) {
  const endpoint = `/api/assets/uploads/${session.id}/part`;
  for (let attempt = 0; ; attempt++) {
    const { url, length } = await assetRequest<{ url: string; length: number }>(endpoint, signal, "POST", { part });
    if (length !== body.size) throw new Error("分片大小不匹配。");
    try {
      await putPart(url, body, signal, progress);
      return;
    } catch (error) {
      if (signal.aborted || attempt >= 1) throw error;
      progress(0);
    }
  }
}

export async function uploadAsset(
  actorId: string, file: File, signal: AbortSignal, progress: (percentage: number) => void,
) {
  const key = await resumeCacheKey(actorId, file);
  const endpoint = "/api/assets/uploads";
  const fileInfo = { filename: file.name, mime: file.type, bytes: file.size };
  let session: UploadSession;
  const resumeId = cachedId(key);
  try {
    session = await assetRequest<UploadSession>(endpoint, signal, "POST", { ...fileInfo, resumeId });
  } catch (error) {
    if (!resumeId || !(error instanceof AssetRequestError) || ![404, 410].includes(error.status)) throw error;
    remember(key);
    session = await assetRequest<UploadSession>(endpoint, signal, "POST", fileInfo);
  }
  remember(key, session.id);
  if (!session.complete) {
    const saved = new Set(session.uploadedParts);
    const count = Math.ceil(file.size / session.partBytes);
    const partSize = (index: number) => Math.min(session.partBytes, file.size - (index - 1) * session.partBytes);
    let uploaded = [...saved].reduce((total, index) => total + partSize(index), 0);
    const update = (additional: number) => progress(Math.min(99, Math.floor((uploaded + additional) * 100 / file.size)));
    update(0);
    for (let part = 1; part <= count; part++) {
      if (saved.has(part)) continue;
      const start = (part - 1) * session.partBytes;
      const blob = file.slice(start, start + partSize(part));
      await sendPart(session, part, blob, signal, update);
      uploaded += blob.size;
      update(0);
    }
    await assetRequest(`${endpoint}/${session.id}`, signal, "POST");
  }
  remember(key);
  progress(100);
}
