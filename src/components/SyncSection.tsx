import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Cloud, CloudOff, Eye, EyeOff, Info, Link2, RefreshCw,
  Unplug, XCircle,
} from 'lucide-react';
import type { Dictionary } from '../lib/i18n';
import type { SyncScopeKey, SyncStatus } from '../types';
import { getSyncAPI } from '../lib/sync';
import { Button, Field, Modal, Panel, SectionTitle, cx, inputClass } from './ui';

/**
 * The scopes the user can toggle, in display order. `units` is listed last and
 * is locked on whenever invoices are synced — a cloud invoice cannot exist
 * without its unit (foreign key), so letting the two diverge would just
 * produce invoices that never sync.
 */
const SCOPE_ROWS: Array<{
  key: SyncScopeKey;
  label: keyof Dictionary;
  hint: keyof Dictionary;
}> = [
  { key: 'invoices', label: 'syncScopeInvoices', hint: 'syncScopeInvoicesHint' },
  { key: 'clients', label: 'syncScopeClients', hint: 'syncScopeClientsHint' },
  { key: 'settings', label: 'syncScopeSettings', hint: 'syncScopeSettingsHint' },
  { key: 'units', label: 'syncScopeUnits', hint: 'syncScopeUnitsHint' },
];

interface SyncSectionProps {
  t: Dictionary;
  notify: (text: string, tone?: 'success' | 'error') => void;
}

export function SyncSection({ t, notify }: SyncSectionProps) {
  const sync = getSyncAPI();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingScopes, setSavingScopes] = useState(false);
  const [form, setForm] = useState({ projectUrl: '', publishableKey: '', databasePassword: '' });

  const refresh = useCallback(async () => {
    if (!sync) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setStatus(await sync.status());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [sync]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const patch = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const handleToggle = async (enabled: boolean) => {
    if (!sync) return;
    if (enabled && !status?.configured) {
      setErrors([]);
      setModalOpen(true);
      return;
    }
    setLoading(true);
    try {
      const result = await sync.toggle(enabled);
      setStatus(await sync.status());
      if (result.ok) {
        notify(enabled ? t.syncEnabled : t.syncDisabled);
      } else {
        notify((result.errors ?? []).join(' ') || t.syncToggleFailed, 'error');
      }
    } catch (error) {
      notify(error?.message || t.syncToggleFailed, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSetup = async () => {
    if (!sync) return;
    setSubmitting(true);
    setErrors([]);
    try {
      const result = await sync.setup(form);
      if (result.ok) {
        setModalOpen(false);
        setForm({ projectUrl: '', publishableKey: '', databasePassword: '' });
        setStatus(await sync.status());
        notify(t.syncConfigured);
      } else {
        setErrors(result.errors ?? [t.syncSetupFailed]);
      }
    } catch (error) {
      setErrors([error?.message || t.syncSetupFailed]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleForget = async () => {
    if (!sync) return;
    setConfirmingForget(false);
    try {
      await sync.forget();
      setStatus(await sync.status());
      notify(t.syncForgotten);
    } catch (error) {
      notify(error?.message || t.syncForgetFailed, 'error');
    }
  };

  const handleScope = async (key: SyncScopeKey, value: boolean) => {
    if (!sync || savingScopes) return;
    setSavingScopes(true);
    // Optimistic: the checkbox should not lag behind the click.
    setStatus((previous) =>
      previous?.scopes
        ? { ...previous, scopes: { ...previous.scopes, [key]: value } }
        : previous
    );
    try {
      const result = await sync.setScopes({ [key]: value });
      setStatus(await sync.status());
      if (result.ok) notify(t.syncScopesSaved);
      else notify((result.errors ?? []).join(' ') || t.syncScopesFailed, 'error');
    } catch (error) {
      setStatus(await sync.status().catch(() => null));
      notify(error?.message || t.syncScopesFailed, 'error');
    } finally {
      setSavingScopes(false);
    }
  };

  const handleSyncNow = async () => {
    if (!sync || syncing) return;
    setSyncing(true);
    try {
      const result = await sync.syncNow();
      const next = await sync.status();
      setStatus(next);
      if (!result.ok && result.error) {
        notify(result.error, 'error');
      } else if (result.ok) {
        notify(t.syncEnabled);
      }
    } catch (error) {
      notify(error?.message || t.syncError, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const formatLastSync = (value: string | null) => {
    if (!value) return t.syncNever;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  };

  const projectName = status?.projectUrl ? status.projectUrl.replace(/^https?:\/\//, '') : null;

  const scopeLabel = (key: string) => {
    const row = SCOPE_ROWS.find((candidate) => candidate.key === key);
    return row ? (t[row.label] as string) : key;
  };

  // Entities that failed in the last cycle, ignoring ones the user turned off.
  const issues = Object.entries(status?.issues ?? {}).filter(([, message]) => !!message);

  return (
    <Panel className="p-5">
      <SectionTitle>{t.sectionSync}</SectionTitle>

      {!sync ? (
        <p className="text-sm leading-relaxed text-slate">{t.syncNotAvailable}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-slate">{t.syncDesc}</p>

          {/* Toggle row */}
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-rule bg-desk/40 p-4">
            <button
              type="button"
              role="switch"
              aria-checked={!!status?.enabled}
              disabled={loading}
              onClick={() => handleToggle(!status?.enabled)}
              className={cx(
                'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60',
                status?.enabled ? 'bg-pine' : 'bg-rule'
              )}
            >
              <span
                className={cx(
                  'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                  status?.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                )}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">
                {status?.enabled ? t.syncOn : t.syncOff}
              </p>
              {status?.enabled ? (
                <p className="flex items-center gap-1.5 text-xs text-slate">
                  <Cloud className="h-3.5 w-3.5 text-pine" aria-hidden />
                  {t.syncConnectedTo} {projectName ?? ''}
                  {status.connection?.method === 'pooler' && (
                    <span className="text-mute">
                      · {t.syncViaPooler(status.connection.region ?? '')}
                    </span>
                  )}
                  {status.connection?.method === 'direct' && (
                    <span className="text-mute">· {t.syncViaDirect}</span>
                  )}
                </p>
              ) : (
                <p className="text-xs text-mute">{t.syncOffHint}</p>
              )}
            </div>
          </div>

          {/* Connected project card */}
          {status?.configured && (
            <div className="space-y-3 rounded-md border border-rule bg-desk/40 p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <CheckCircle2 className="h-4 w-4 text-pine" aria-hidden />
                <span className="font-semibold">{t.syncProjectLabel}</span>
                <span className="min-w-0 truncate font-mono text-xs text-slate">{projectName}</span>
                <span
                  className={cx(
                    'ms-auto inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                    status.enabled
                      ? 'border-pine-mid/40 bg-pine-tint text-pine'
                      : 'border-rule bg-paper text-mute'
                  )}
                >
                  {status.enabled ? (
                    <Cloud className="h-3 w-3" aria-hidden />
                  ) : (
                    <CloudOff className="h-3 w-3" aria-hidden />
                  )}
                  {status.enabled ? t.syncActive : t.syncPaused}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={RefreshCw}
                  busy={syncing}
                  onClick={handleSyncNow}
                >
                  {syncing ? t.syncSyncing : t.syncNowButton}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={Link2}
                  onClick={() => {
                    setErrors([]);
                    setModalOpen(true);
                  }}
                >
                  {t.syncEdit}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  icon={Unplug}
                  onClick={() => setConfirmingForget(true)}
                >
                  {t.syncDisconnect}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mute">
                <span>
                  {t.syncLastSyncLabel} : {formatLastSync(status.lastSyncAt)}
                </span>
              </div>

              {/* Per-entity failures. Previously any completed cycle cleared
                  the error, so a table that failed every time still looked
                  healthy — this is what hid the invoice/settings breakage. */}
              {issues.length > 0 && (
                <div className="space-y-1.5 rounded-md border border-seal/30 bg-seal-tint/40 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-seal">
                    <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {t.syncIssuesTitle}
                  </p>
                  <ul className="space-y-1 text-xs text-seal">
                    {issues.map(([key, message]) => (
                      <li key={key}>
                        <span className="font-semibold">{scopeLabel(key)}</span> — {message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Things the engine fixed on its own, e.g. a local invoice
                  renumbered because another device already used that number. */}
              {status.notices?.length > 0 && (
                <div className="space-y-1.5 rounded-md border border-rule bg-paper p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                    <Info className="h-3.5 w-3.5 shrink-0 text-pine" aria-hidden />
                    {t.syncNoticesTitle}
                  </p>
                  <ul className="space-y-1 text-xs text-slate">
                    {status.notices.map((notice, index) => (
                      <li key={index}>{notice}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* What gets shared */}
          {status?.configured && status.scopes && (
            <div className="space-y-3 rounded-md border border-rule bg-desk/40 p-4">
              <div>
                <p className="text-sm font-semibold text-ink">{t.syncScopesTitle}</p>
                <p className="mt-0.5 text-xs text-mute">{t.syncScopesHint}</p>
              </div>
              <ul className="space-y-2">
                {SCOPE_ROWS.map(({ key, label, hint }) => {
                  const checked = !!status.scopes?.[key];
                  // Units are implied by invoices; show it locked rather than
                  // letting the user create a combination that cannot work.
                  const locked = key === 'units' && !!status.scopes?.invoices;
                  return (
                    <li key={key}>
                      <label
                        className={cx(
                          'flex items-start gap-3 rounded-md border border-transparent p-2 transition-colors',
                          locked ? 'opacity-70' : 'cursor-pointer hover:border-rule hover:bg-paper'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked || savingScopes}
                          onChange={(event) => handleScope(key, event.target.checked)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-pine disabled:opacity-60"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-ink">{t[label] as string}</span>
                          <span className="block text-xs text-mute">
                            {locked || checked ? (t[hint] as string) : t.syncScopeOff}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Credential setup modal */}
      <Modal
        open={modalOpen}
        title={t.syncSetupTitle}
        onClose={() => !submitting && setModalOpen(false)}
        closeLabel={t.dismiss}
        footer={
          <>
            <Button type="button" variant="ghost" disabled={submitting} onClick={() => setModalOpen(false)}>
              {t.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              icon={Link2}
              busy={submitting}
              onClick={handleSetup}
            >
              {submitting ? t.syncConnecting : t.syncConnect}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-slate">{t.syncSetupHint}</p>

          <Field label={t.syncProjectUrl} htmlFor="sync-project-url">
            <input
              id="sync-project-url"
              type="text"
              value={form.projectUrl}
              onChange={patch('projectUrl')}
              placeholder="https://xxxxxxxx.supabase.co"
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </Field>

          <Field label={t.syncPublishableKey} htmlFor="sync-publishable-key">
            <input
              id="sync-publishable-key"
              type="text"
              value={form.publishableKey}
              onChange={patch('publishableKey')}
              placeholder="sb_publishable_…"
              autoComplete="off"
              spellCheck={false}
              className={cx(inputClass, 'font-mono')}
            />
          </Field>

          <Field label={t.syncDbPassword} hint={t.syncDbPasswordHint} htmlFor="sync-db-password">
            <div className="relative">
              <input
                id="sync-db-password"
                type={showPassword ? 'text' : 'password'}
                value={form.databasePassword}
                onChange={patch('databasePassword')}
                autoComplete="new-password"
                className={cx(inputClass, 'pr-10')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? t.syncHidePassword : t.syncShowPassword}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-mute transition-colors hover:text-ink"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          {errors.length > 0 && (
            <div className="flex items-start gap-3 rounded-md border border-seal/30 bg-seal-tint/40 p-3 text-sm text-seal">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <ul className="list-disc space-y-1 ps-4">
                {errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>

      {/* Disconnect confirmation */}
      <Modal
        open={confirmingForget}
        title={t.syncForgetTitle}
        onClose={() => setConfirmingForget(false)}
        closeLabel={t.dismiss}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setConfirmingForget(false)}>
              {t.cancel}
            </Button>
            <Button type="button" variant="danger" icon={Unplug} onClick={handleForget}>
              {t.syncDisconnect}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate">{t.syncForgetConfirm}</p>
      </Modal>
    </Panel>
  );
}
