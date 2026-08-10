import { AuthRequiredError, IssueNotFoundError } from "../issue/errors.js";
import { NotSupportedError, UnknownBackendError } from "../issue/service.js";
import { FocusError } from "../sqlite/focus.js";
import { SavedQueryNotFoundError } from "../sqlite/saved-queries.js";
import { SessionAuthError } from "../sqlite/session-identity.js";
import { StagedItemNotFoundError } from "../stage/store.js";

/** Returns the legacy HTTP status only for reviewed business errors; unknown failures stay unclassified. */
export function statusForKnownTicketError(error: unknown): number | undefined {
  if (error instanceof IssueNotFoundError || error instanceof SavedQueryNotFoundError || error instanceof StagedItemNotFoundError)
    return 404;
  if (error instanceof UnknownBackendError || error instanceof NotSupportedError || error instanceof FocusError) return 400;
  if (error instanceof AuthRequiredError) return 422;
  if (error instanceof SessionAuthError) return 401;
  return undefined;
}
