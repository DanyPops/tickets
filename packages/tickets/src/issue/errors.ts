export class IssueNotFoundError extends Error {
  constructor(backend: string, key: string) {
    super(`${backend}: issue not found: ${key}`);
    this.name = "IssueNotFoundError";
  }
}

export class AuthRequiredError extends Error {
  constructor(backend: string, tokenEnv: string) {
    super(`${backend}: write operation requires ${tokenEnv} to be set`);
    this.name = "AuthRequiredError";
  }
}

/** A reviewed, user-actionable backend setup failure safe to expose to clients. */
export class BackendConfigurationError extends Error {
  constructor(
    public readonly backend: string,
    message: string,
    public readonly recovery: string,
  ) {
    super(`${backend}: ${message}`);
    this.name = "BackendConfigurationError";
  }
}

/** A transport failure with no trustworthy HTTP response (DNS, VPN, connection, or timeout). */
export class BackendConnectionError extends Error {
  constructor(
    public readonly backend: string,
    public readonly kind: "unreachable" | "timeout" = "unreachable",
    cause?: unknown,
  ) {
    super(
      kind === "timeout"
        ? `${backend}: backend request timed out; retry or check backend connectivity`
        : `${backend}: unable to reach the backend API; check the configured URL and network, VPN, or DNS connectivity`,
      { cause },
    );
    this.name = "BackendConnectionError";
  }
}

export class ApiError extends Error {
  constructor(
    public readonly backend: string,
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${backend} API error: ${method} ${path}: ${status}: ${body}`);
    this.name = "ApiError";
  }
}

export class InvalidUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUrlError";
  }
}
