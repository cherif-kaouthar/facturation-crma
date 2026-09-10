import React, { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Building2, FileText, Mail, MapPin, Phone, Plus, Search, Trash2, User, Users } from 'lucide-react';
import type { Client, ClientType } from '../types';
import type { Dictionary } from '../lib/i18n';
import { money } from '../lib/format';
import { Button, cx, EmptyState, inputClass, Panel } from './ui';

interface ClientsPageProps {
  clients: Client[];
  t: Dictionary;
  onAddClient: () => void;
  onEditClient: (client: Client) => void;
  onToggleArchive: (client: Client) => void;
  onDeleteClient: (client: Client) => void;
  onSelectClientInvoices: (clientId: number) => void;
}

export function ClientsPage({
  clients,
  t,
  onAddClient,
  onEditClient,
  onToggleArchive,
  onDeleteClient,
  onSelectClientInvoices,
}: ClientsPageProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ClientType>('all');
  const [showArchived, setShowArchived] = useState(false);

  const filteredClients = useMemo(() => {
    return clients.filter((client) => {
      if (!showArchived && client.archived) return false;
      if (typeFilter !== 'all' && client.type !== typeFilter) return false;
      if (!query.trim()) return true;
      const q = query.toLowerCase().trim();
      return (
        client.name.toLowerCase().includes(q) ||
        client.location.toLowerCase().includes(q) ||
        (client.nif && client.nif.toLowerCase().includes(q)) ||
        (client.art && client.art.toLowerCase().includes(q)) ||
        (client.phone && client.phone.toLowerCase().includes(q)) ||
        (client.email && client.email.toLowerCase().includes(q))
      );
    });
  }, [clients, query, typeFilter, showArchived]);

  const stats = useMemo(() => {
    const active = clients.filter((c) => !c.archived);
    const companies = active.filter((c) => c.type === 'company').length;
    const persons = active.filter((c) => c.type === 'person').length;
    const totalBilled = active.reduce((acc, c) => acc + (c.totalBilled || 0), 0);
    return { count: active.length, companies, persons, totalBilled };
  }, [clients]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header action area */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-narrow text-xl font-bold uppercase tracking-[0.08em] text-pine">
            {t.clients}
          </h1>
          <p className="text-xs text-slate">{t.noClientsHint}</p>
        </div>
        <Button variant="primary" icon={Plus} onClick={onAddClient}>
          {t.addClient}
        </Button>
      </div>

      {/* Summary KPI Panel */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Panel className="p-4">
          <p className="font-narrow text-[10px] font-semibold uppercase tracking-[0.1em] text-slate">
            {t.allClients}
          </p>
          <p className="font-narrow text-2xl font-bold text-pine">{stats.count}</p>
        </Panel>
        <Panel className="p-4">
          <p className="font-narrow text-[10px] font-semibold uppercase tracking-[0.1em] text-slate">
            {t.company}
          </p>
          <p className="font-narrow text-2xl font-bold text-ink">{stats.companies}</p>
        </Panel>
        <Panel className="p-4">
          <p className="font-narrow text-[10px] font-semibold uppercase tracking-[0.1em] text-slate">
            {t.person}
          </p>
          <p className="font-narrow text-2xl font-bold text-ink">{stats.persons}</p>
        </Panel>
        <Panel className="p-4">
          <p className="font-narrow text-[10px] font-semibold uppercase tracking-[0.1em] text-slate">
            {t.statBilled}
          </p>
          <p className="font-narrow text-xl font-bold text-pine">{money(stats.totalBilled)}</p>
        </Panel>
      </div>

      {/* Search & Filter Toolbar */}
      <Panel className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`${t.search} (${t.clientNameLabel}, ${t.clientNifLabel}...)`}
              className={cx(inputClass, 'pl-9')}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Type tabs */}
            <div className="flex items-center rounded-md border border-rule bg-desk/60 p-0.5">
              <button
                type="button"
                onClick={() => setTypeFilter('all')}
                className={cx(
                  'rounded px-2.5 py-1 text-xs font-semibold transition-colors',
                  typeFilter === 'all' ? 'bg-pine text-white' : 'text-slate hover:text-ink'
                )}
              >
                {t.allClients}
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter('company')}
                className={cx(
                  'rounded px-2.5 py-1 text-xs font-semibold transition-colors',
                  typeFilter === 'company' ? 'bg-pine text-white' : 'text-slate hover:text-ink'
                )}
              >
                {t.company}
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter('person')}
                className={cx(
                  'rounded px-2.5 py-1 text-xs font-semibold transition-colors',
                  typeFilter === 'person' ? 'bg-pine text-white' : 'text-slate hover:text-ink'
                )}
              >
                {t.person}
              </button>
            </div>

            {/* Archive toggle */}
            <label className="flex items-center gap-2 text-xs font-semibold text-slate cursor-pointer px-2 py-1">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="rounded border-rule text-pine focus:ring-pine"
              />
              <span>{t.archived}</span>
            </label>
          </div>
        </div>
      </Panel>

      {/* Clients List / Cards Grid */}
      {filteredClients.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Users}
            title={query ? t.noResults : t.noClients}
            hint={query ? t.noResultsHint : t.noClientsHint}
            action={
              !query ? (
                <Button variant="primary" icon={Plus} onClick={onAddClient}>
                  {t.addClient}
                </Button>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filteredClients.map((client) => {
            const isCompany = client.type === 'company';
            return (
              <Panel
                key={client.id}
                className={cx(
                  'flex flex-col justify-between p-4 transition-colors hover:border-pine-mid/80',
                  client.archived && 'opacity-60 bg-desk/30'
                )}
              >
                <div className="space-y-3">
                  {/* Top Bar: Icon, Name & Type Badge */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div
                        className={cx(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white',
                          isCompany ? 'bg-pine' : 'bg-slate'
                        )}
                      >
                        {isCompany ? <Building2 className="h-5 w-5" /> : <User className="h-5 w-5" />}
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-ink leading-tight">{client.name}</h2>
                        <span
                          className={cx(
                            'mt-1 inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                            isCompany ? 'bg-pine/10 text-pine' : 'bg-desk text-slate'
                          )}
                        >
                          {isCompany ? t.company : t.person}
                        </span>
                      </div>
                    </div>

                    {client.archived && (
                      <span className="rounded bg-seal-tint px-2 py-0.5 text-[10px] font-semibold text-seal">
                        {t.archived}
                      </span>
                    )}
                  </div>

                  {/* Details */}
                  <div className="space-y-1.5 text-xs text-slate pt-1">
                    {client.location && (
                      <div className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-pine-mid" />
                        <span className="truncate">{client.location}</span>
                      </div>
                    )}

                    {isCompany && (client.nif || client.art) && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 font-mono text-[11px]">
                        {client.nif && (
                          <span className="rounded bg-paper border border-rule px-2 py-0.5 text-ink">
                            <strong>NIF :</strong> {client.nif}
                          </span>
                        )}
                        {client.art && (
                          <span className="rounded bg-paper border border-rule px-2 py-0.5 text-ink">
                            <strong>N/ART :</strong> {client.art}
                          </span>
                        )}
                      </div>
                    )}

                    {(client.phone || client.email) && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-slate">
                        {client.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3 shrink-0" /> {client.phone}
                          </span>
                        )}
                        {client.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="h-3 w-3 shrink-0" /> {client.email}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer stats & actions */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3 text-xs">
                  <button
                    type="button"
                    onClick={() => onSelectClientInvoices(client.id)}
                    className="flex items-center gap-1.5 font-semibold text-pine transition-colors hover:underline"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>
                      {client.invoiceCount || 0} {t.ledger.toLowerCase()} ({money(client.totalBilled || 0)})
                    </span>
                  </button>

                  <div className="flex items-center gap-1 ms-auto">
                    <button
                      type="button"
                      onClick={() => onEditClient(client)}
                      className="rounded p-1.5 text-slate transition-colors hover:bg-black/5 hover:text-ink"
                      title={t.edit}
                    >
                      {t.edit}
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleArchive(client)}
                      className="rounded p-1.5 text-slate transition-colors hover:bg-black/5 hover:text-ink"
                      title={client.archived ? t.restoreClient : t.archiveClient}
                    >
                      {client.archived ? (
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      ) : (
                        <Archive className="h-3.5 w-3.5" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => onDeleteClient(client)}
                      className="rounded p-1.5 text-seal/80 transition-colors hover:bg-seal-tint hover:text-seal"
                      title={t.delete}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
