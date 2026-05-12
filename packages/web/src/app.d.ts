import type { ServerSession } from "$lib/session-paths";

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /**
       * Server-side session snapshot, populated by `hooks.server.ts` from
       * the API's `/api/public/session-zones` endpoint.
       *
       * `null` in three cases:
       *   - the request carried no cookie (anonymous)
       *   - the API returned a non-OK status (logged unless 401)
       *   - the call timed out / errored (logged)
       *
       * Routes that need a session redirect to `/login` when this is null.
       */
      session: ServerSession | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
