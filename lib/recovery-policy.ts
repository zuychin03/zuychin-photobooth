/** Handler gates supplement the recovery route allowlist; existing authority checks still apply. */
export function recoveryOperationAllowed(surface: string, operation: string, body: Record<string, unknown> = {}): boolean {
  switch (surface) {
    case "project":
      return ["capabilities", "list", "view", "status", "read", "finalise", "delete"].includes(operation)
        || operation === "member" && body.action === "revoke";
    case "project-design":
      return ["capabilities", "head", "read", "status"].includes(operation);
    case "event-root":
      return ["capabilities", "list"].includes(operation);
    case "event-host":
      return ["dashboard", "settings", "missions", "guestbook", "revokeToken"].includes(operation)
        || operation === "manage" && ["pause", "close", "delete", "revoke_guest", "revoke_moderator", "remove_submission"].includes(String(body.action));
    case "event-guest": {
      // Reservation names resolve existing deterministic receipt authority only in recovery.
      if (["session", "context", "missions", "guestbook", "ownConsent", "finalise", "withdrawGuestbook", "reserve", "reserveMission"].includes(operation)) return true;
      if (operation === "saveOwnConsent") return body.gallery === false && body.wall === false;
      const consent = body.consent;
      return operation === "consent" && !!consent && typeof consent === "object"
        && (consent as Record<string, unknown>).submission === false
        && (consent as Record<string, unknown>).gallery === false
        && (consent as Record<string, unknown>).wall === false;
    }
    case "event-receipt":
      return ["exchange", "read", "media", "guestbook", "withdrawGuestbook"].includes(operation);
    case "event-export":
      return ["list", "create", "page", "access", "media", "guestbook", "checkpoint", "retire"].includes(operation);
    case "event-kiosk":
      return ["capabilities", "session", "context", "status", "finalise", "reset", "unlock", "operator", "exit", "revoke"].includes(operation);
    default:
      return false;
  }
}
