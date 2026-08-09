import { isVehicleError, VehicleError } from "@danypops/vehicle-core";
import { ApiError, AuthRequiredError, BackendConfigurationError, BackendConnectionError, InvalidUrlError } from "../issue/errors.js";
import { statusForKnownTicketError } from "../rpc/error-status.js";

function apiErrorToVehicle(error: ApiError): VehicleError {
  const details = { backend: error.backend, status: error.status };

  if (error.status === 401 || error.status === 403) {
    return new VehicleError("backend-authentication-failed", `${error.backend}: authentication or authorization was rejected`, {
      category: "authorization",
      details,
      recovery: { message: "Check the configured credential and its backend permissions, then retry." },
      cause: error,
    });
  }
  if (error.status === 408) {
    return new VehicleError("backend-timeout", `${error.backend}: backend request timed out`, {
      category: "timeout",
      retryable: true,
      details,
      recovery: { message: "Retry after backend connectivity recovers." },
      cause: error,
    });
  }
  if (error.status === 409) {
    return new VehicleError("backend-conflict", `${error.backend}: backend rejected the request because its state changed`, {
      category: "conflict",
      details,
      recovery: { message: "Refresh the issue and retry against its current state." },
      cause: error,
    });
  }
  if (error.status === 429) {
    return new VehicleError("backend-rate-limited", `${error.backend}: backend API rate limit exceeded`, {
      category: "capacity",
      retryable: true,
      details,
      recovery: { message: "Retry after the backend rate limit resets; cached ledger reads remain available." },
      cause: error,
    });
  }
  if (error.status >= 500) {
    return new VehicleError("backend-unavailable", `${error.backend}: backend API is unavailable (${error.status})`, {
      category: "unavailable",
      retryable: true,
      details,
      recovery: { message: "Retry later; for reads, use ledger.search while the live backend is unavailable." },
      cause: error,
    });
  }
  return new VehicleError("backend-request-rejected", `${error.backend}: backend rejected the request (${error.status})`, {
    category: "validation",
    details,
    recovery: { message: "Check the operation input and backend-specific constraints, then retry." },
    cause: error,
  });
}

/** Converts reviewed Tickets failures into actionable, wire-safe Vehicle failures. */
export function toTicketsVehicleError(error: unknown): VehicleError {
  if (isVehicleError(error)) return error;

  if (error instanceof BackendConfigurationError) {
    return new VehicleError("backend-not-configured", error.message, {
      category: "validation",
      recovery: { message: error.recovery },
      cause: error,
    });
  }
  if (error instanceof BackendConnectionError) {
    return new VehicleError(error.kind === "timeout" ? "backend-timeout" : "backend-unavailable", error.message, {
      category: error.kind === "timeout" ? "timeout" : "unavailable",
      retryable: true,
      details: { backend: error.backend },
      recovery: {
        message: "Check the configured URL and network, VPN, or DNS connectivity; cached ledger reads remain available.",
      },
      cause: error,
    });
  }
  if (error instanceof ApiError) return apiErrorToVehicle(error);
  if (error instanceof InvalidUrlError) {
    return new VehicleError("invalid-backend-url", "Backend URL configuration is invalid", {
      category: "validation",
      recovery: { message: "Use an HTTPS backend URL (HTTP is accepted only for localhost), then restart the daemon." },
      cause: error,
    });
  }
  if (error instanceof AuthRequiredError) {
    return new VehicleError("backend-authentication-required", error.message, {
      category: "authorization",
      recovery: { message: "Configure the backend credential, restart the daemon if needed, and retry." },
      cause: error,
    });
  }

  const status = statusForKnownTicketError(error);
  if (status === 404) {
    return new VehicleError("not-found", (error as Error).message, { category: "not_found", cause: error });
  }
  if (status === 400) {
    return new VehicleError("operation-rejected", (error as Error).message, { category: "validation", cause: error });
  }
  if (status === 422) {
    return new VehicleError("operation-rejected", (error as Error).message, { category: "authorization", cause: error });
  }

  // Unknown exceptions stay opaque: only reviewed domain/config/transport errors above
  // may cross the daemon boundary with their original message.
  return new VehicleError("handler-failed", "Tickets operation failed unexpectedly", {
    category: "internal",
    cause: error,
  });
}

export async function withTicketsErrorParity<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toTicketsVehicleError(error);
  }
}
