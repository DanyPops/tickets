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
