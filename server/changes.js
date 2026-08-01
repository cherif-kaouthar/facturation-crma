/**
 * Local-change signal.
 *
 * The API layer emits here after every successful mutating request; the sync
 * engine listens and schedules an immediate (debounced) push. Without this the
 * only thing that ever triggered a push was the background timer, so a saved
 * invoice could sit unsynced for a full interval.
 *
 * Deliberately dependency-free: both `server/` and `electron/sync/` import it,
 * and it must not pull either of them in.
 */

import { EventEmitter } from 'node:events';

export const localChanges = new EventEmitter();

/** Signal that this device wrote something that needs pushing. */
export function notifyLocalChange(reason = 'local') {
  localChanges.emit('change', reason);
}
