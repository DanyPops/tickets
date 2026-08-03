import { AuthRequiredError, IssueNotFoundError } from "../issue/errors.js";
import { NotSupportedError, UnknownBackendError } from "../issue/service.js";
import { FocusError } from "../sqlite/focus.js";
import { SavedQueryNotFoundError } from "../sqlite/saved-queries.js";

/** Returns the legacy HTTP status only for reviewed business errors; unknown failures stay unclassified. */
export function statusForKnownTicketError(error: unknown): number | undefined {
  if (error instanceof IssueNotFoundError || error instanceof SavedQueryNotFoundError) return 404;
  if (error instanceof UnknownBackendError || error instanceof NotSupportedError || error instanceof FocusError) return 400;
  if (error instanceof AuthRequiredError) return 422;
  return undefined;
}
