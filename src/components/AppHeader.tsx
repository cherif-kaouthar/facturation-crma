import React from 'react';
import { FileText, Plus, Settings as SettingsIcon, Users } from 'lucide-react';
import type { Language, Settings, Unit } from '../types';
import type { Dictionary } from '../lib/i18n';
import { BrandLogo } from './Brand';
import { cx } from './ui';

interface AppHeaderProps {
  settings: Settings;
  units: Unit[];
  selectedUnitId: number | 'all';
  currentViewName: 'ledger' | 'clients' | 'settings' | 'invoice' | 'editor';
  lang: Language;
  t: Dictionary;
  showUnitBar: boolean;
  onSelectUnit: (value: number | 'all') => void;
  onChangeLanguage: (lang: Language) => void;
  onOpenLedger: () => void;
  onOpenClients: () => void;
  onOpenSettings: () => void;
  onAddUnit: () => void;
  onGoHome: () => void;
}

export function AppHeader({
  settings,
  units,
  selectedUnitId,
  currentViewName,
  lang,
  t,
  showUnitBar,
  onSelectUnit,
  onChangeLanguage,
  onOpenLedger,
  onOpenClients,
  onOpenSettings,
  onAddUnit,
  onGoHome,
}: AppHeaderProps) {
  const visibleUnits = units.filter((unit) => !unit.archived || unit.id === selectedUnitId);
  const selected = units.find((unit) => unit.id === selectedUnitId);

  return (
    <header className="no-print sticky top-0 z-30">
      {/* Identity bar */}
      <div className="bg-pine text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={onGoHome}
            className="flex min-w-0 items-center gap-3 rounded text-start focus:outline-none"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white">
              <BrandLogo logo={settings.branding.logo} className="h-full w-full rounded-full" tone="pine" objectFit="cover" />
            </span>
            <span className="flex min-w-0 flex-col justify-center">
              <span className="block truncate font-narrow text-base sm:text-lg font-bold uppercase tracking-[0.05em] leading-tight">
                {t.appName}
              </span>
              <span className="block truncate text-[11px] sm:text-xs font-medium text-white/80 leading-tight mt-0.5">
                {t.appSubtitle}
              </span>
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {/* View navigation buttons */}
            <button
              type="button"
              onClick={onOpenLedger}
              className={cx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                currentViewName === 'ledger' || currentViewName === 'invoice' || currentViewName === 'editor'
                  ? 'bg-white text-pine'
                  : 'text-white/80 hover:bg-black/20 hover:text-white'
              )}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t.ledger}</span>
            </button>

            <button
              type="button"
              onClick={onOpenClients}
              className={cx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                currentViewName === 'clients'
                  ? 'bg-white text-pine'
                  : 'text-white/80 hover:bg-black/20 hover:text-white'
              )}
            >
              <Users className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t.clients}</span>
            </button>

            {/* Language switch */}
            <div
              role="group"
              aria-label={t.language}
              className="flex items-center gap-0.5 rounded-md bg-black/20 p-0.5"
            >
              {(['fr', 'ar'] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => onChangeLanguage(code)}
                  aria-pressed={lang === code}
                  className={cx(
                    'rounded px-2.5 py-1 text-xs font-semibold transition-colors',
                    code === 'ar' && 'font-arabic',
                    lang === code ? 'bg-white text-pine' : 'text-white/70 hover:text-white'
                  )}
                >
                  {code === 'fr' ? 'FR' : 'ع'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={onOpenSettings}
              className={cx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                currentViewName === 'settings'
                  ? 'bg-white text-pine'
                  : 'text-white/80 hover:bg-black/20 hover:text-white'
              )}
            >
              <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t.settings}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Scope bar — which unit the ledger below is showing */}
      {showUnitBar && (
        <div className="border-b border-rule bg-paper">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6 lg:px-8">
            <label
              htmlFor="unit-scope"
              className="font-narrow text-[10px] font-semibold uppercase tracking-[0.12em] text-slate"
            >
              {t.unit}
            </label>
            <select
              id="unit-scope"
              value={String(selectedUnitId)}
              onChange={(event) =>
                onSelectUnit(event.target.value === 'all' ? 'all' : Number(event.target.value))
              }
              className="max-w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-sm font-semibold text-ink transition-colors hover:border-pine-mid focus:outline-none"
            >
              <option value="all">{t.allUnits}</option>
              {visibleUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                  {unit.archived ? ` (${t.archived})` : ''}
                </option>
              ))}
            </select>

            {selected?.address && (
              <span className="truncate text-xs text-slate">{selected.address}</span>
            )}

            <button
              type="button"
              onClick={onAddUnit}
              className="ms-auto flex items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold text-pine transition-colors hover:bg-pine-tint"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t.addUnit}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
