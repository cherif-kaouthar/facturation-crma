import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, FileText } from 'lucide-react';
import type { ServiceStat, Settings, YearlyStats } from '../types';
import type { Dictionary } from '../lib/i18n';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { EmptyState, Panel, Spinner, cx } from './ui';

interface StatisticsPageProps {
  settings: Settings;
  t: Dictionary;
}

/**
 * Palette cycled through chart segments. Services are dynamic (they come from
 * the observations actually used in the selected year), so the colours are
 * assigned by position rather than by a fixed category.
 */
const CHART_COLORS = [
  '#16503b',
  '#a32a1e',
  '#2c6b53',
  '#b08a2e',
  '#42546b',
  '#7a4d2d',
  '#3d8b7d',
  '#8c5aa3',
];

const colorFor = (index: number) => CHART_COLORS[index % CHART_COLORS.length];

function numberFormat() {
  return new Intl.NumberFormat('fr-FR');
}

function percentFormat() {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
}

/* ------------------------------------------------------------------ */
/* Donut chart — purely visual, synced hover emphasis only.            */
/* ------------------------------------------------------------------ */

function Donut({
  services,
  hovered,
  onHover,
}: {
  services: ServiceStat[];
  hovered: number | null;
  onHover: (index: number | null) => void;
}) {
  const total = services.reduce((sum, s) => sum + s.invoiceCount, 0);
  const size = 240;
  const stroke = 34;
  const radius = (size - stroke) / 2;
  const centre = size / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-56 w-56 sm:h-64 sm:w-64" role="img" aria-label="Donut">
      {total === 0 ? (
        <circle cx={centre} cy={centre} r={radius} fill="none" stroke="#e6eaec" strokeWidth={stroke} />
      ) : (
        services.map((service, index) => {
          const dash = (service.invoiceCount / total) * circumference;
          const gap = 2;
          const emphasized = hovered === index;
          const segment = (
            <circle
              key={service.key}
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              stroke={colorFor(index)}
              strokeWidth={emphasized ? stroke + 6 : stroke}
              strokeOpacity={hovered === null ? 1 : emphasized ? 1 : 0.45}
              strokeDasharray={`${Math.max(dash - gap, 0)} ${circumference - Math.max(dash - gap, 0)}`}
              strokeDashoffset={-offset}
              className="cursor-pointer transition-all duration-150"
              onMouseEnter={() => onHover(index)}
              onMouseLeave={() => onHover(null)}
            >
              <title>{service.label ?? ''}</title>
            </circle>
          );
          offset += dash;
          return segment;
        })
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Statistics page                                                     */
/* ------------------------------------------------------------------ */

export function StatisticsPage({ settings, t }: StatisticsPageProps) {
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [stats, setStats] = useState<YearlyStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [error, setError] = useState<string>('');

  const currency = settings.billing.currency;
  const tNum = useMemo(() => numberFormat(), []);
  const tPct = useMemo(() => percentFormat(), []);

  const load = useCallback(async (selected: number) => {
    setLoading(true);
    setError('');
    try {
      setStats(await api.getYearlyStats(selected));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Le chargement des statistiques a échoué.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(year);
  }, [year, load]);

  const services = useMemo<ServiceStat[]>(
    () => (stats?.services ?? []).map((service) => ({ ...service, label: service.label || t.statisticsNoLabel })),
    [stats, t]
  );

  const totalInvoices = stats?.totalInvoices ?? 0;
  const years = stats?.years?.length ? stats.years : [year];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header & year selector */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-narrow text-xl font-bold uppercase tracking-[0.08em] text-pine">
            <BarChart3 className="h-5 w-5" aria-hidden />
            {t.statisticsTitle}
          </h1>
          {stats && <p className="mt-0.5 text-xs text-slate">{t.statisticsTitle} — {stats.year}</p>}
        </div>

        <label className="flex items-center gap-2 text-sm font-semibold text-slate">
          <span className="font-narrow text-[10px] font-bold uppercase tracking-[0.12em]">
            {t.statisticsYear}
          </span>
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            className="rounded-md border border-rule bg-paper px-3 py-2 font-mono tnum text-sm font-semibold text-ink transition-colors hover:border-pine-mid focus:outline-none"
            aria-label={t.statisticsYear}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-seal/30 bg-seal-tint px-4 py-2.5 text-sm text-seal">
          {error}
        </p>
      )}

      {loading && !stats ? (
        <Spinner label={t.loading} />
      ) : !stats || totalInvoices === 0 ? (
        <Panel>
          <EmptyState icon={FileText} title={t.statisticsEmpty} hint={t.statisticsEmptyHint} />
        </Panel>
      ) : (
        <>
          {/* Main statistic cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Panel className="flex items-center justify-between p-5">
              <p className="font-narrow text-[11px] font-semibold uppercase tracking-[0.1em] text-slate">
                {t.statisticsTotalInvoices}
              </p>
              <p className="font-narrow text-3xl font-bold text-pine tnum">{tNum.format(totalInvoices)}</p>
            </Panel>
            <Panel className="flex items-center justify-between p-5">
              <p className="font-narrow text-[11px] font-semibold uppercase tracking-[0.1em] text-slate">
                {t.statisticsTotalAmount}
              </p>
              <p className="font-narrow text-2xl font-bold text-ink tnum">{money(stats.totalAmount, currency)}</p>
            </Panel>
          </div>

          {/* Distribution by service */}
          <Panel className="p-5 sm:p-6">
            <h2 className="mb-5 font-narrow text-xs font-bold uppercase tracking-[0.14em] text-pine">
              {t.statisticsDistribution}
            </h2>

            <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-center">
              {/* Chart — hover emphasizes the matching section */}
              <div className="relative shrink-0">
                <Donut services={services} hovered={hovered} onHover={setHovered} />
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                  <p className="text-[11px] text-slate">{t.statisticsTotalInvoices}</p>
                  <p className="font-narrow text-3xl font-bold text-ink tnum">{tNum.format(totalInvoices)}</p>
                  <p className="text-[11px] text-slate">100 %</p>
                </div>
              </div>

              {/* Per-service breakdown */}
              <div className="w-full flex-1 space-y-2">
                {services.map((service, index) => {
                  const share = totalInvoices > 0 ? (service.invoiceCount / totalInvoices) * 100 : 0;
                  return (
                    <button
                      key={service.key}
                      type="button"
                      onMouseEnter={() => setHovered(index)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(index)}
                      onBlur={() => setHovered(null)}
                      className={cx(
                        'grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 rounded-md border px-4 py-3 text-start transition-colors',
                        hovered === index
                          ? 'border-pine-mid bg-pine-tint/40'
                          : 'border-rule bg-paper hover:border-pine-mid/60 hover:bg-pine-tint/25'
                      )}
                    >
                      <span
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: colorFor(index) }}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-ink">{service.label}</span>
                        <span className="block text-xs text-slate">
                          {t.statisticsInvoices}: {tNum.format(service.invoiceCount)} · {t.statisticsShare}:{' '}
                          {tPct.format(share)} %
                        </span>
                      </span>
                      <span className="font-mono tnum text-sm font-semibold text-pine sm:text-base">
                        {money(service.totalAmount, currency)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}