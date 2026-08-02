import { ApiError, IssueNotFoundError } from "./domain/errors.js";

export type FetchLike = typeof fetch;

export interface HttpClientOptions {
  baseUrl: string;
  backend: string;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Thin authenticated JSON HTTP client shared by all adapters. Each adapter owns its
 * own auth header construction (Bearer, Basic, PRIVATE-TOKEN, ...) and passes it in
 * via `headers`. Accepts an injectable `fetchImpl` so adapters are testable without
 * a network — see test/github/*.test.ts, test/gitlab/*.test.ts, test/jira/*.test.ts.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly backend: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.backend = opts.backend;
    this.headers = opts.headers ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 404) {
        throw new IssueNotFoundError(this.backend, path);
      }
      if (res.status === 204) {
        return undefined;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new ApiError(this.backend, method, path, res.status, redact(text));
      }
      if (text.length === 0) return undefined;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string): Promise<T | undefined> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T | undefined> {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T | undefined> {
    return this.request<T>("PUT", path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T | undefined> {
    return this.request<T>("PATCH", path, body);
  }
}

/** Strips anything that looks like a bearer/basic credential from error bodies before logging. */
function redact(text: string): string {
  return text.replace(/"(token|password|secret|api_key|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"').slice(0, 2000);
}
