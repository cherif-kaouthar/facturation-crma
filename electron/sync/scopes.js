/**
 * Which kinds of data the user has chosen to share with the cloud.
 *
 * Everything is on by default; turning a scope off leaves that data purely
 * local on this device. Kept free of Electron imports so the rules can be
 * tested on their own.
 */

export const SYNC_SCOPES = ['units', 'clients', 'invoices', 'settings'];

const DEFAULT_SCOPES = { units: true, clients: true, invoices: true, settings: true };

/**
 * Normalise a stored or partial scope map.
 *
 * `units` is not independent of `invoices`: public.invoices.unit_id is a NOT
 * NULL foreign key, so an invoice whose unit was never pushed can never be
 * stored in the cloud. Syncing invoices therefore forces units on rather than
 * letting the user pick a combination that silently fails.
 */
export function resolveScopes(raw) {
  const scopes = { ...DEFAULT_SCOPES };
  if (raw && typeof raw === 'object') {
    for (const key of SYNC_SCOPES) {
      if (typeof raw[key] === 'boolean') scopes[key] = raw[key];
    }
  }
  if (scopes.invoices) scopes.units = true;
  return scopes;
}
