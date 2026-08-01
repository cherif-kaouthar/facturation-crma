import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Building2, Plus } from 'lucide-react';
import type { Client, ClientType, Invoice, InvoiceDraft, Language, Settings, Stats, Unit } from './types';
import { api, ApiError } from './lib/api';
import { getTranslation } from './lib/i18n';
import { getSyncAPI } from './lib/sync';
import { AppHeader } from './components/AppHeader';
import { Ledger } from './components/Ledger';
import { ClientsPage } from './components/ClientsPage';
import { ClientModal } from './components/ClientModal';
import { InvoiceDetail } from './components/InvoiceDetail';
import { InvoiceEditor } from './components/InvoiceEditor';
import { SettingsPage } from './components/SettingsPage';
import { UnitModal } from './components/UnitModal';
import { Button, EmptyState, Modal, Spinner, Toaster, type ToastMessage } from './components/ui';

type View =
  | { name: 'ledger' }
  | { name: 'clients' }
  | { name: 'invoice'; id: number }
  | { name: 'editor'; id: number | null }
  | { name: 'settings' };

const SCOPE_KEY = 'lfb.unitScope';

export default function App() {
  /* ---------------- Core data ---------------- */
  const [settings, setSettings] = useState<Settings | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [nextNumber, setNextNumber] = useState<{ year: number; seq: number; number: string } | null>(null);
  const [activeInvoice, setActiveInvoice] = useState<Invoice | null>(null);

  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string>('');
  const [listLoading, setListLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  /* ---------------- View & scope ---------------- */
  const [view, setView] = useState<View>({ name: 'ledger' });
  const [unitScope, setUnitScope] = useState<number | 'all'>(() => {
    const stored = localStorage.getItem(SCOPE_KEY);
    if (!stored || stored === 'all') return 'all';
    const parsed = Number(stored);
    return Number.isInteger(parsed) ? parsed : 'all';
  });
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [lang, setLang] = useState<Language>('fr');
  const t = getTranslation(lang);

  /* ---------------- Modals ---------------- */
  const [unitModal, setUnitModal] = useState<{ open: boolean; unit: Unit | null }>({ open: false, unit: null });
  const [clientModal, setClientModal] = useState<{ open: boolean; client: Client | null }>({
    open: false,
    client: null,
  });
  const [confirm, setConfirm] = useState<
    { title: string; body: string; action: () => void | Promise<void> } | null
  >(null);
  const [settingsVersion, setSettingsVersion] = useState(0);

  /* ---------------- Toasts ---------------- */
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastId = useRef(0);

  const notify = useCallback((text: string, tone: 'success' | 'error' = 'success') => {
    const id = (toastId.current += 1);
    setToasts((previous) => [...previous, { id, text, tone }]);
    window.setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, tone === 'error' ? 6000 : 3500);
  }, []);

  const dismissToast = useCallback(
    (id: number) => setToasts((previous) => previous.filter((toast) => toast.id !== id)),
    []
  );

  /** Surface API failures in the operator's language rather than swallowing them. */
  const reportError = useCallback(
    (error: unknown) => {
      const message = error instanceof ApiError ? error.message : String((error as Error)?.message ?? error);
      notify(message, 'error');
    },
    [notify]
  );

  /* ---------------- Language & direction ---------------- */
  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  /* ---------------- Window title (Electron title bar) ---------------- */
  useEffect(() => {
    const companyName = settings?.company?.name?.trim();
    document.title = companyName ? `${companyName} — ${t.appName}` : t.appName;
  }, [settings, t]);

  /* ---------------- Boot ---------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedSettings, loadedUnits, loadedClients] = await Promise.all([
          api.getSettings(),
          api.listUnits(),
          api.listClients(),
        ]);
        if (cancelled) return;
        setSettings(loadedSettings);
        setUnits(loadedUnits);
        setClients(loadedClients);
        setLang(loadedSettings.app.language === 'ar' ? 'ar' : 'fr');
        setBootError('');
      } catch (error) {
        if (!cancelled) {
          setBootError(error instanceof ApiError ? error.message : 'Le chargement a échoué.');
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- Search debounce ---------------- */
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  /* ---------------- Scope persistence ---------------- */
  useEffect(() => {
    localStorage.setItem(SCOPE_KEY, String(unitScope));
  }, [unitScope]);

  /* ---------------- Ledger data ---------------- */
  const scopeId = unitScope === 'all' ? undefined : unitScope;

  const refreshLedger = useCallback(async () => {
    setListLoading(true);
    try {
      const [list, loadedStats, next, loadedClients] = await Promise.all([
        api.listInvoices({ unitId: scopeId, q: debouncedSearch.trim() || undefined }),
        api.getStats(scopeId),
        api.nextNumber(),
        api.listClients(),
      ]);
      setInvoices(list);
      setStats(loadedStats);
      setNextNumber(next);
      setClients(loadedClients);
    } catch (error) {
      reportError(error);
    } finally {
      setListLoading(false);
    }
  }, [scopeId, debouncedSearch, reportError]);

  useEffect(() => {
    if (booting || bootError) return;
    refreshLedger();
  }, [booting, bootError, refreshLedger]);

  const refreshUnits = useCallback(async () => {
    try {
      setUnits(await api.listUnits());
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  const refreshClients = useCallback(async () => {
    try {
      setClients(await api.listClients());
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  /* ---------------- Cloud sync arrivals ---------------- */
  /**
   * The sync engine writes straight into SQLite, so a change pulled from
   * another device is invisible until something refetches. Reload quietly
   * (no spinner) whenever a cycle reports it applied cloud data.
   */
  useEffect(() => {
    const sync = getSyncAPI();
    if (!sync?.onChanged || booting || bootError) return;

    let cancelled = false;
    const unsubscribe = sync.onChanged(() => {
      (async () => {
        try {
          const [list, loadedStats, next, loadedClients, loadedUnits, loadedSettings] =
            await Promise.all([
              api.listInvoices({ unitId: scopeId, q: debouncedSearch.trim() || undefined }),
              api.getStats(scopeId),
              api.nextNumber(),
              api.listClients(),
              api.listUnits(),
              api.getSettings(),
            ]);
          if (cancelled) return;
          setInvoices(list);
          setStats(loadedStats);
          setNextNumber(next);
          setClients(loadedClients);
          setUnits(loadedUnits);
          setSettings(loadedSettings);
        } catch {
          /* transient: the next cycle will report again */
        }
      })();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [booting, bootError, scopeId, debouncedSearch]);

  /* ---------------- Client actions ---------------- */
  const submitClient = useCallback(
    async (data: {
      name: string;
      type: ClientType;
      location: string;
      nif: string;
      art: string;
      phone: string;
      email: string;
      archived?: boolean;
    }) => {
      setSaving(true);
      try {
        const editing = clientModal.client;
        if (editing) {
          await api.updateClient(editing.id, data);
          notify(t.clientSaved);
        } else {
          const created = await api.createClient(data);
          notify(t.clientCreated(created.name));
        }
        setClientModal({ open: false, client: null });
        await Promise.all([refreshClients(), refreshLedger()]);
      } catch (error) {
        reportError(error);
      } finally {
        setSaving(false);
      }
    },
    [clientModal, notify, t, refreshClients, refreshLedger, reportError]
  );

  const toggleClientArchive = useCallback(
    async (client: Client) => {
      try {
        await api.updateClient(client.id, {
          archived: !client.archived,
        });
        await refreshClients();
        notify(t.clientSaved);
      } catch (error) {
        reportError(error);
      }
    },
    [refreshClients, notify, t, reportError]
  );

  const requestDeleteClient = useCallback(
    (client: Client) => {
      setConfirm({
        title: t.confirmDeleteClientTitle,
        body: t.confirmDeleteClientBody(client.name),
        action: async () => {
          try {
            await api.deleteClient(client.id);
            await Promise.all([refreshClients(), refreshLedger()]);
            notify(t.clientDeleted);
          } catch (error) {
            reportError(error);
          }
        },
      });
    },
    [t, refreshClients, refreshLedger, notify, reportError]
  );

  /* ---------------- Invoice actions ---------------- */
  const openInvoice = useCallback(
    async (invoice: Invoice) => {
      try {
        const full = await api.getInvoice(invoice.id);
        setActiveInvoice(full);
        setView({ name: 'invoice', id: full.id });
        window.scrollTo({ top: 0 });
      } catch (error) {
        reportError(error);
      }
    },
    [reportError]
  );

  const startNewInvoice = useCallback(() => {
    if (units.filter((unit) => !unit.archived).length === 0) {
      setUnitModal({ open: true, unit: null });
      return;
    }
    setActiveInvoice(null);
    setView({ name: 'editor', id: null });
    window.scrollTo({ top: 0 });
  }, [units]);

  const saveInvoice = useCallback(
    async (draft: InvoiceDraft) => {
      setSaving(true);
      try {
        const isEdit = view.name === 'editor' && view.id !== null;
        const saved = isEdit
          ? await api.updateInvoice(view.id as number, draft)
          : await api.createInvoice(draft);
        setActiveInvoice(saved);
        setView({ name: 'invoice', id: saved.id });
        await Promise.all([refreshLedger(), refreshUnits()]);
        notify(t.invoiceSaved(saved.reference));
        window.scrollTo({ top: 0 });
      } catch (error) {
        reportError(error);
      } finally {
        setSaving(false);
      }
    },
    [view, refreshLedger, refreshUnits, notify, t, reportError]
  );

  const duplicateInvoice = useCallback(
    async (invoice: Invoice) => {
      setSaving(true);
      try {
        const copy = await api.duplicateInvoice(invoice.id);
        setActiveInvoice(copy);
        setView({ name: 'invoice', id: copy.id });
        await Promise.all([refreshLedger(), refreshUnits()]);
        notify(t.invoiceDuplicated(copy.reference));
      } catch (error) {
        reportError(error);
      } finally {
        setSaving(false);
      }
    },
    [refreshLedger, refreshUnits, notify, t, reportError]
  );

  const requestDeleteInvoice = useCallback(
    (invoice: Invoice) => {
      setConfirm({
        title: t.confirmDeleteTitle,
        body: t.confirmDeleteBody(invoice.reference),
        action: async () => {
          try {
            await api.deleteInvoice(invoice.id);
            setActiveInvoice(null);
            setView({ name: 'ledger' });
            await Promise.all([refreshLedger(), refreshUnits()]);
            notify(t.invoiceDeleted(invoice.reference));
          } catch (error) {
            reportError(error);
          }
        },
      });
    },
    [t, refreshLedger, refreshUnits, notify, reportError]
  );

  /* ---------------- Unit actions ---------------- */
  const submitUnit = useCallback(
    async (data: { name: string; address: string }) => {
      setSaving(true);
      try {
        const editing = unitModal.unit;
        if (editing) {
          await api.updateUnit(editing.id, { ...data, archived: editing.archived });
          notify(t.unitSaved);
        } else {
          const created = await api.createUnit(data);
          setUnitScope(created.id);
          notify(t.unitCreated(created.name));
        }
        setUnitModal({ open: false, unit: null });
        await Promise.all([refreshUnits(), refreshLedger()]);
      } catch (error) {
        reportError(error);
      } finally {
        setSaving(false);
      }
    },
    [unitModal, notify, t, refreshUnits, refreshLedger, reportError]
  );

  const toggleArchive = useCallback(
    async (unit: Unit) => {
      try {
        await api.updateUnit(unit.id, {
          name: unit.name,
          address: unit.address,
          archived: !unit.archived,
        });
        if (!unit.archived && unitScope === unit.id) setUnitScope('all');
        await refreshUnits();
        notify(t.unitSaved);
      } catch (error) {
        reportError(error);
      }
    },
    [unitScope, refreshUnits, notify, t, reportError]
  );

  const requestDeleteUnit = useCallback(
    (unit: Unit) => {
      setConfirm({
        title: t.confirmDeleteUnitTitle,
        body: t.confirmDeleteUnitBody(unit.name),
        action: async () => {
          try {
            await api.deleteUnit(unit.id);
            if (unitScope === unit.id) setUnitScope('all');
            await Promise.all([refreshUnits(), refreshLedger()]);
            notify(t.unitDeleted);
          } catch (error) {
            reportError(error);
          }
        },
      });
    },
    [t, unitScope, refreshUnits, refreshLedger, notify, reportError]
  );

  /* ---------------- Settings actions ---------------- */
  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      setSaving(true);
      try {
        const saved = await api.saveSettings(patch);
        setSettings(saved);
        // A language stored in settings should take effect straight away.
        if (patch.app?.language) setLang(patch.app.language);
        notify(t.settingsSaved);
        await refreshLedger();
      } catch (error) {
        reportError(error);
      } finally {
        setSaving(false);
      }
    },
    [notify, t, refreshLedger, reportError]
  );

  const resetSettings = useCallback(() => {
    setConfirm({
      title: t.resetSettings,
      body: t.settingsSubtitle,
      action: async () => {
        try {
          const saved = await api.resetSettings();
          setSettings(saved);
          setSettingsVersion((version) => version + 1);
          notify(t.settingsSaved);
        } catch (error) {
          reportError(error);
        }
      },
    });
  }, [t, notify, reportError]);

  const applyNextSeq = useCallback(
    async (year: number, nextSeq: number) => {
      try {
        const result = await api.setNextSeq(year, nextSeq);
        setNextNumber(result);
        setStats((previous) => (previous ? { ...previous, next: result } : previous));
        notify(t.numberingUpdated(`${result.number}/${result.year}`));
      } catch (error) {
        reportError(error);
      }
    },
    [notify, t, reportError]
  );

  /* ---------------- Language ---------------- */
  const changeLanguage = useCallback(
    (next: Language) => {
      setLang(next);
      api.saveSettings({ app: { language: next } }).catch(() => {
        /* the UI already switched; persisting the preference is best-effort */
      });
    },
    []
  );

  /* ---------------- Render ---------------- */
  const editorInvoice = useMemo(
    () => (view.name === 'editor' && view.id !== null ? activeInvoice : null),
    [view, activeInvoice]
  );

  const activeUnits = useMemo(() => units.filter((unit) => !unit.archived), [units]);

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-desk">
        <Spinner label={t.loading} />
      </div>
    );
  }

  if (bootError || !settings) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-desk p-6">
        <div className="w-full max-w-md rounded-lg border border-rule bg-paper">
          <EmptyState
            icon={AlertTriangle}
            title={bootError || 'Le chargement a échoué.'}
            hint="Vérifiez que le serveur est démarré, puis réessayez."
            action={
              <Button variant="primary" onClick={() => window.location.reload()}>
                {t.retry}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="print-root flex min-h-screen flex-col bg-desk text-ink">
      <AppHeader
        settings={settings}
        units={units}
        selectedUnitId={unitScope}
        currentViewName={view.name}
        lang={lang}
        t={t}
        showUnitBar={view.name === 'ledger'}
        onSelectUnit={setUnitScope}
        onChangeLanguage={changeLanguage}
        onOpenLedger={() => setView({ name: 'ledger' })}
        onOpenClients={() => setView({ name: 'clients' })}
        onOpenSettings={() => setView({ name: 'settings' })}
        onAddUnit={() => setUnitModal({ open: true, unit: null })}
        onGoHome={() => setView({ name: 'ledger' })}
      />

      <main className="flex-1">
        {view.name === 'ledger' && (
          units.length === 0 ? (
            <div className="mx-auto max-w-2xl px-4 py-16">
              <div className="rounded-lg border border-rule bg-paper">
                <EmptyState
                  icon={Building2}
                  title={t.noUnits}
                  hint={t.noUnitsHint}
                  action={
                    <Button
                      variant="primary"
                      icon={Plus}
                      onClick={() => setUnitModal({ open: true, unit: null })}
                    >
                      {t.addUnit}
                    </Button>
                  }
                />
              </div>
            </div>
          ) : (
            <Ledger
              invoices={invoices}
              stats={stats}
              settings={settings}
              lang={lang}
              t={t}
              loading={listLoading}
              search={search}
              scopedToUnit={unitScope !== 'all'}
              exportUrl={api.exportCsvUrl({ unitId: scopeId, q: debouncedSearch.trim() || undefined })}
              onSearchChange={setSearch}
              onOpenInvoice={openInvoice}
              onNewInvoice={startNewInvoice}
            />
          )
        )}

        {view.name === 'clients' && (
          <ClientsPage
            clients={clients}
            lang={lang}
            t={t}
            onAddClient={() => setClientModal({ open: true, client: null })}
            onEditClient={(client) => setClientModal({ open: true, client })}
            onToggleArchive={toggleClientArchive}
            onDeleteClient={requestDeleteClient}
            onSelectClientInvoices={(clientId) => {
              const selectedClient = clients.find((c) => c.id === clientId);
              if (selectedClient) {
                setSearch(selectedClient.name);
                setView({ name: 'ledger' });
              }
            }}
          />
        )}

        {view.name === 'invoice' && activeInvoice && (
          <InvoiceDetail
            invoice={activeInvoice}
            settings={settings}
            lang={lang}
            t={t}
            busy={saving}
            onBack={() => setView({ name: 'ledger' })}
            onEdit={() => setView({ name: 'editor', id: activeInvoice.id })}
            onDuplicate={() => duplicateInvoice(activeInvoice)}
            onDelete={() => requestDeleteInvoice(activeInvoice)}
          />
        )}

        {view.name === 'editor' && (
          <InvoiceEditor
            key={editorInvoice?.id ?? 'new'}
            invoice={editorInvoice}
            units={editorInvoice ? units : activeUnits}
            clients={clients}
            defaultUnitId={
              editorInvoice?.unitId ??
              (unitScope !== 'all' ? unitScope : activeUnits[0]?.id ?? units[0]?.id ?? 0)
            }
            nextNumber={nextNumber?.number ?? ''}
            settings={settings}
            lang={lang}
            t={t}
            saving={saving}
            onSave={saveInvoice}
            onCancel={() =>
              setView(activeInvoice ? { name: 'invoice', id: activeInvoice.id } : { name: 'ledger' })
            }
            onAddNewClient={() => setClientModal({ open: true, client: null })}
          />
        )}

        {view.name === 'settings' && (
          <SettingsPage
            key={settingsVersion}
            settings={settings}
            units={units}
            lang={lang}
            t={t}
            saving={saving}
            nextNumber={nextNumber}
            onSave={saveSettings}
            onReset={resetSettings}
            onCreateUnit={() => setUnitModal({ open: true, unit: null })}
            onEditUnit={(unit) => setUnitModal({ open: true, unit })}
            onDeleteUnit={requestDeleteUnit}
            onToggleArchive={toggleArchive}
            onSetNextSeq={applyNextSeq}
            notify={notify}
          />
        )}
      </main>

      <UnitModal
        open={unitModal.open}
        unit={unitModal.unit}
        t={t}
        saving={saving}
        onClose={() => setUnitModal({ open: false, unit: null })}
        onSubmit={submitUnit}
      />

      <ClientModal
        open={clientModal.open}
        client={clientModal.client}
        busy={saving}
        lang={lang}
        t={t}
        onClose={() => setClientModal({ open: false, client: null })}
        onSubmit={submitClient}
      />

      <Modal
        open={confirm !== null}
        title={confirm?.title ?? ''}
        onClose={() => setConfirm(null)}
        closeLabel={t.dismiss}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const pending = confirm;
                setConfirm(null);
                await pending?.action();
              }}
            >
              {t.confirmDelete}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate">{confirm?.body}</p>
      </Modal>

      <Toaster toasts={toasts} onDismiss={dismissToast} closeLabel={t.dismiss} />
    </div>
  );
}
