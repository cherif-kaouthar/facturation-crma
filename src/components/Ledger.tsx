import React from 'react';
import { ChevronRight, Download, FileText, Plus, Search, SearchX, X } from 'lucide-react';
import type { Invoice, Settings, Stats } from '../types';
import type { Dictionary } from '../lib/i18n';
import { money, shortDate } from '../lib/format';
import { Button, EmptyState, Imprint, Panel, Spinner, cx, inputClass } from './ui';

interface LedgerProps {
  invoices: Invoice[];
  stats: Stats | null;
  settings: Settings;
  t: Dictionary;
  loading: boolean;
  search: string;
  scopedToUnit: boolean;
  exportUrl: string;
  onSearchChange: (value: string) => void;
  onOpenInvoice: (invoice: Invoice) => void;
  onNewInvoice: () => void;
}

/**
 * A stat strip rather than stat cards: two readings sharing one ruled band,
 * so the numbers line up and the eye lands on the ledger below. Yearly
 * figures and numbering live in the dedicated "Statistiques" section.
 */
function StatStrip({ stats, settings, t }: Pick<LedgerProps, 'stats' | 'settings' | 't'>) {
  const currency = settings.billing.currency;
  const readings = [
    { label: t.statInvoices, value: stats ? String(stats.count) : 'â€”', mono: true },
    { label: t.statBilled, value: stats ? money(stats.billed, currency) : 'â€”', mono: true },
  ];

  return (
    <dl className="grid grid-cols-2 divide-rule border-b border-rule divide-x ">
      {readings.map((reading) => (
        <div key={reading.label} className="px-4 py-3.5">
          <dt className="font-narrow text-[10px] font-semibold uppercase tracking-[0.12em] text-slate">
            {reading.label}
          </dt>
          <dd className="mt-1">
            <span
              className={cx(
                'text-[15px] font-semibold text-ink',
                reading.mono && 'font-mono tnum tracking-tight'
              )}
            >
              {reading.value}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Ledger({
  invoices,
  stats,
  settings,
  t,
  loading,
  search,
  scopedToUnit,
  exportUrl,
  onSearchChange,
  onOpenInvoice,
  onNewInvoice,
}: LedgerProps) {
  const currency = settings.billing.currency;
  const searching = search.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <Panel className="overflow-hidden">
        <StatStrip stats={stats} settings={settings} t={t} />

        {/* Command row */}
        <div className="flex flex-col gap-3 border-b border-rule px-4 py-3.5 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-mute left-3"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t.search}
              aria-label={t.search}
              className={cx(inputClass, 'pl-9')}
            />
            {searching && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label={t.clearSearch}
                className="absolute top-1/2 -translate-y-1/2 rounded p-1 text-mute transition-colors hover:text-ink right-2"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={Download}
              title={t.export}
              onClick={() => {
                window.location.href = exportUrl;
              }}
              disabled={invoices.length === 0}
            >
              <span className="hidden sm:inline">{t.export}</span>
            </Button>
            <Button variant="primary" icon={Plus} onClick={onNewInvoice}>
              {t.newInvoice}
            </Button>
          </div>
        </div>

        {loading ? (
          <Spinner label={t.loading} />
        ) : invoices.length === 0 ? (
          <EmptyState
            icon={searching ? SearchX : FileText}
            title={searching ? t.noResults : t.noInvoices}
            hint={searching ? t.noResultsHint : t.noInvoicesHint}
            action={
              searching ? (
                <Button variant="secondary" icon={X} onClick={() => onSearchChange('')}>
                  {t.clearSearch}
                </Button>
              ) : (
                <Button variant="primary" icon={Plus} onClick={onNewInvoice}>
                  {t.newInvoice}
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule bg-desk/60 font-narrow text-[10px] uppercase tracking-[0.12em] text-slate">
                  <th scope="col" className="px-4 py-2.5 font-semibold text-left">
                    {t.colNumber}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-left">
                    {t.colDate}
                  </th>
                  {!scopedToUnit && (
                    <th scope="col" className="px-4 py-2.5 font-semibold text-left">
                      {t.colUnit}
                    </th>
                  )}
                  <th scope="col" className="px-4 py-2.5 font-semibold text-left">
                    {t.sectionClient}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-left">
                    {t.colPolicies}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-right">
                    {t.colLines}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-right">
                    {t.colAmount}
                  </th>
                  <th scope="col" className="w-10 px-2 py-2.5">
                    <span className="sr-only">{t.ledger}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr
                    key={invoice.id}
                    tabIndex={0}
                    role="button"
                    onClick={() => onOpenInvoice(invoice)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpenInvoice(invoice);
                      }
                    }}
                    className="ledger-row group cursor-pointer transition-colors hover:bg-pine-tint/60 focus-visible:bg-pine-tint"
                  >
                    <td className="px-4 py-3 text-left">
                      <Imprint reference={invoice.reference} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate text-left">
                      {shortDate(invoice.date)}
                    </td>
                    {!scopedToUnit && (
                      <td className="max-w-[14rem] truncate px-4 py-3 text-ink text-left">
                        {invoice.unitName}
                      </td>
                    )}
                    <td className="max-w-[12rem] truncate px-4 py-3 text-ink font-semibold text-left">
                      {invoice.clientName || 'â€”'}
                    </td>
                    <td className="max-w-[14rem] truncate px-4 py-3 font-mono text-xs text-slate text-left">
                      {invoice.policies || 'â€”'}
                    </td>
                    <td className="px-4 py-3 font-mono tnum text-slate text-right">
                      {invoice.lineCount}
                    </td>
                    <td className="px-4 py-3 font-mono tnum font-semibold whitespace-nowrap text-ink text-right">
                      {money(invoice.totalAmount, currency)}
                    </td>
                    <td className="px-2 py-3 text-mute">
                      <ChevronRight
                        className="h-4 w-4 transition-transform group-hover:text-pine group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {invoices.length > 0 && (
          <p className="border-t border-rule px-4 py-2.5 font-narrow text-[11px] uppercase tracking-[0.1em] text-mute">
            {t.invoicesCount(invoices.length)}
          </p>
        )}
      </Panel>
    </div>
  );
}
