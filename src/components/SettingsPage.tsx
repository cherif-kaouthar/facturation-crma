import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArchiveRestore, Archive, Building2, Database, Download, ImageUp, Plus, RotateCcw, Save, Trash2, Upload,
} from 'lucide-react';
import type { NextNumber, Settings, Unit } from '../types';
import type { Dictionary } from '../lib/i18n';
import { money } from '../lib/format';
import { api } from '../lib/api';
import { BrandLogo } from './Brand';
import { SyncSection } from './SyncSection';
import { Button, Field, Modal, Panel, SectionTitle, cx, inputClass } from './ui';
import type { CustomField } from '../types';

const MAX_LOGO_BYTES = 3 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

interface SettingsPageProps {
  settings: Settings;
  units: Unit[];
  t: Dictionary;
  saving: boolean;
  onSave: (patch: Partial<Settings>) => Promise<void> | void;
  onReset: () => void;
  onCreateUnit: () => void;
  onEditUnit: (unit: Unit) => void;
  onDeleteUnit: (unit: Unit) => void;
  onToggleArchive: (unit: Unit) => void;
  onSetNextSeq: (year: number, nextSeq: number) => void;
  nextNumbers: NextNumber[];
  notify: (text: string, tone?: 'success' | 'error') => void;
}

/* ------------------------------------------------------------------ */
/* Logo                                                                */
/* ------------------------------------------------------------------ */

function LogoSection({
  settings,
  t,
  onChange,
  notify,
}: {
  settings: Settings;
  t: Dictionary;
  onChange: (logo: string) => void;
  notify: SettingsPageProps['notify'];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const hasLogo = Boolean(settings.branding.logo);

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      notify('Choisissez une image PNG, JPEG, GIF, WebP ou SVG.', 'error');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      notify('Cette image dépasse 3 Mo. Choisissez-en une plus légère.', 'error');
      return;
    }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      setReading(false);
      onChange(String(reader.result ?? ''));
    };
    reader.onerror = () => {
      setReading(false);
      notify('La lecture de l’image a échoué. Réessayez.', 'error');
    };
    reader.readAsDataURL(file);
  };

  return (
    <Panel className="p-5">
      <SectionTitle>{t.sectionLogo}</SectionTitle>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        {/* The preview sits on paper because that is where the logo lands. */}
        <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-md border border-rule bg-paper p-3">
          <BrandLogo logo={settings.branding.logo} className="h-full w-full" />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm leading-relaxed text-slate">{t.logoHint}</p>
          {!hasLogo && <p className="text-xs text-mute">{t.logoFallback}</p>}

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(',')}
            className="sr-only"
            onChange={(event) => {
              pickFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              icon={hasLogo ? Upload : ImageUp}
              busy={reading}
              onClick={() => inputRef.current?.click()}
            >
              {hasLogo ? t.replaceLogo : t.uploadLogo}
            </Button>
            {hasLogo && (
              <Button type="button" variant="danger" icon={Trash2} onClick={() => onChange('')}>
                {t.removeLogo}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Numbering                                                           */
/* ------------------------------------------------------------------ */

function NumberingSection({
  t,
  nextNumbers,
  onSetNextSeq,
}: Pick<SettingsPageProps, 't' | 'nextNumbers' | 'onSetNextSeq'>) {
  const [values, setValues] = useState<Record<number, string>>({});

  return (
    <div>
      <SectionTitle>{t.numberings}</SectionTitle>
      <p className="-mt-1 mb-3 text-xs text-mute">{t.numberingHint}</p>
      {nextNumbers.length === 0 ? (
        <p className="text-sm text-slate">{t.noInvoices}</p>
      ) : (
        <ul className="space-y-2">
          {nextNumbers.map((item) => (
            <li
              key={item.year}
              className="flex flex-wrap items-center gap-3 rounded-md border border-rule bg-desk/40 px-4 py-3"
            >
              <span className="font-narrow text-sm font-bold text-pine tnum">{item.year}</span>
              <span className="font-mono text-sm font-semibold text-ink tnum">
                → {item.number}/{item.year}
              </span>
              <div className="ms-auto flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={values[item.year] ?? ''}
                  placeholder={String(item.seq)}
                  onChange={(event) =>
                    setValues((previous) => ({ ...previous, [item.year]: event.target.value }))
                  }
                  className={cx(inputClass, 'w-28 font-mono tnum')}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!(values[item.year] ?? '').trim()}
                  onClick={() => {
                    const parsed = Number(values[item.year]);
                    if (Number.isInteger(parsed) && parsed > 0) {
                      onSetNextSeq(item.year, parsed);
                      setValues((previous) => ({ ...previous, [item.year]: '' }));
                    }
                  }}
                >
                  {t.applyNumbering}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Custom fields editor                                                */
/* ------------------------------------------------------------------ */

function CustomFieldsEditor({
  fields,
  onChange,
  t,
}: {
  fields: CustomField[];
  onChange: (fields: CustomField[]) => void;
  t: Dictionary;
}) {
  const add = () => onChange([...fields, { label: '', value: '' }]);
  const remove = (index: number) => onChange(fields.filter((_, i) => i !== index));
  const patch = (index: number, key: keyof CustomField, value: string) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, [key]: value } : f)));

  return (
    <div className="space-y-2">
      {fields.map((field, index) => (
        <div key={index} className="flex items-start gap-2">
          <Field label={t.customFieldLabel} className="flex-1">
            <input
              type="text"
              value={field.label}
              onChange={(e) => patch(index, 'label', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={t.customFieldValue} className="flex-1">
            <input
              type="text"
              value={field.value}
              onChange={(e) => patch(index, 'value', e.target.value)}
              className={inputClass}
            />
          </Field>
          <button
            type="button"
            onClick={() => remove(index)}
            aria-label={t.removeCustomField}
            className="mt-6 rounded p-2 text-mute transition-colors hover:bg-seal-tint hover:text-seal"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" icon={Plus} onClick={add}>
        {t.addCustomField}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Observation presets editor                                          */
/* ------------------------------------------------------------------ */

function ObsPresetsEditor({
  presets,
  onChange,
  t,
}: {
  presets: string[];
  onChange: (presets: string[]) => void;
  t: Dictionary;
}) {
  const add = () => onChange([...presets, '']);
  const remove = (index: number) => onChange(presets.filter((_, i) => i !== index));
  const patch = (index: number, value: string) =>
    onChange(presets.map((p, i) => (i === index ? value : p)));

  return (
    <div className="space-y-2">
      <p className="text-xs leading-snug text-mute">{t.observationPresetHint}</p>
      {presets.map((preset, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="text"
            value={preset}
            onChange={(e) => patch(index, e.target.value)}
            className={cx(inputClass, 'flex-1')}
          />
          <button
            type="button"
            onClick={() => remove(index)}
            aria-label={t.removeObservationPreset}
            className="rounded p-2 text-mute transition-colors hover:bg-seal-tint hover:text-seal"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" icon={Plus} onClick={add}>
        {t.addObservationPreset}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function SettingsPage({
  settings,
  units,
  t,
  saving,
  onSave,
  onReset,
  onCreateUnit,
  onEditUnit,
  onDeleteUnit,
  onToggleArchive,
  onSetNextSeq,
  nextNumbers,
  notify,
}: SettingsPageProps) {
  const [draft, setDraft] = useState<Settings>(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const patchCompany = (key: keyof Omit<Settings['company'], 'customFields'>, value: string) =>
    setDraft((previous) => ({ ...previous, company: { ...previous.company, [key]: value } }));

  const patchBilling = (key: keyof Settings['billing'], value: number | string) =>
    setDraft((previous) => ({ ...previous, billing: { ...previous.billing, [key]: value } }));

  const setLogo = (logo: string) => {
    setDraft((previous) => ({ ...previous, branding: { logo } }));
  };

  const companyFields: Array<[keyof Omit<Settings['company'], 'customFields'>, string]> = [
    ['name', t.companyName],
    ['address', t.companyAddress],
    ['agrement', t.companyAgrement],
    ['nif', t.companyNif],
    ['art', t.companyArt],
    ['bna', t.companyBna],
    ['ccp', t.companyCcp],
    ['tel', t.companyTel],
    ['fax', t.companyFax],
    ['city', t.companyCity],
  ];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <header>
        <h1 className="font-narrow text-2xl font-bold uppercase tracking-[0.05em] text-pine">
          {t.settingsTitle}
        </h1>
        <p className="mt-1 text-sm text-slate">{t.settingsSubtitle}</p>
      </header>

      <SyncSection t={t} notify={notify} />

      <LogoSection settings={draft} t={t} onChange={setLogo} notify={notify} />

      {/* Company profile */}
      <Panel className="p-5">
        <SectionTitle>{t.sectionCompany}</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          {companyFields.map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`company-${key}`}>
              <input
                id={`company-${key}`}
                type="text"
                value={draft.company[key]}
                onChange={(event) => patchCompany(key, event.target.value)}
                className={cx(inputClass, ['nif', 'art', 'bna', 'ccp', 'tel', 'fax'].includes(key) && 'font-mono tnum')}
              />
            </Field>
          ))}
        </div>
        <div className="mt-4 border-t border-rule pt-4">
          <SectionTitle>{t.customFields}</SectionTitle>
          <CustomFieldsEditor
            fields={draft.company.customFields}
            onChange={(customFields) =>
              setDraft((previous) => ({ ...previous, company: { ...previous.company, customFields } }))
            }
            t={t}
          />
        </div>
      </Panel>

      {/* Billing & numbering */}
      <Panel className="p-5">
        <SectionTitle>{t.sectionBilling}</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.tvaRate} hint={t.tvaRateHint} htmlFor="tva-rate">
            <div className="relative">
              <input
                id="tva-rate"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={Math.round(draft.billing.tvaRate * 10000) / 100}
                onChange={(event) => patchBilling('tvaRate', Number(event.target.value) / 100)}
                className={cx(inputClass, 'font-mono tnum pr-8')}
              />
              <span className="pointer-events-none absolute top-1/2 -translate-y-1/2 font-mono text-sm text-mute right-3">
                %
              </span>
            </div>
          </Field>

          <Field label={t.defaultTimbre} htmlFor="default-timbre">
            <input
              id="default-timbre"
              type="number"
              min={0}
              step={1}
              value={draft.billing.defaultTimbre}
              onChange={(event) => patchBilling('defaultTimbre', Number(event.target.value) || 0)}
              className={cx(inputClass, 'font-mono tnum')}
            />
          </Field>

          <Field label={t.defaultObs} htmlFor="default-obs" className="sm:col-span-2">
            <input
              id="default-obs"
              type="text"
              value={draft.billing.defaultObs}
              onChange={(event) => patchBilling('defaultObs', event.target.value)}
              className={inputClass}
            />
          </Field>

          <div className="sm:col-span-2">
            <SectionTitle>{t.observationPresets}</SectionTitle>
            <ObsPresetsEditor
              presets={draft.billing.observationPresets}
              onChange={(observationPresets) =>
                setDraft((previous) => ({ ...previous, billing: { ...previous.billing, observationPresets } }))
              }
              t={t}
            />
          </div>

          <Field label={t.numberPadding} hint={t.numberPaddingHint} htmlFor="number-padding">
            <input
              id="number-padding"
              type="number"
              min={1}
              max={8}
              step={1}
              value={draft.billing.numberPadding}
              onChange={(event) =>
                patchBilling('numberPadding', Math.min(8, Math.max(1, Number(event.target.value) || 4)))
              }
              className={cx(inputClass, 'font-mono tnum')}
            />
          </Field>
        </div>

        <div className="sm:col-span-2 mt-4 border-t border-rule pt-4">
          <Field label={t.pageOrientation}>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="orientation"
                  value="portrait"
                  checked={draft.billing.pageOrientation === 'portrait'}
                  onChange={() => patchBilling('pageOrientation', 'portrait')}
                  className="text-pine focus:ring-pine-mid"
                />
                <span className="text-sm text-ink">{t.portrait}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="orientation"
                  value="landscape"
                  checked={draft.billing.pageOrientation === 'landscape'}
                  onChange={() => patchBilling('pageOrientation', 'landscape')}
                  className="text-pine focus:ring-pine-mid"
                />
                <span className="text-sm text-ink">{t.landscape}</span>
              </label>
            </div>
          </Field>
        </div>

        <div className="mt-4">
          <NumberingSection t={t} nextNumbers={nextNumbers} onSetNextSeq={onSetNextSeq} />
        </div>
      </Panel>

      {/* Units */}
      <Panel className="p-5">
        <SectionTitle
          aside={
            <Button type="button" variant="secondary" size="sm" icon={Plus} onClick={onCreateUnit}>
              {t.addUnit}
            </Button>
          }
        >
          {t.sectionUnits}
        </SectionTitle>

        {units.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate">{t.noUnits}</p>
        ) : (
          <ul className="divide-y divide-rule-soft">
            {units.map((unit) => (
              <li key={unit.id} className="flex flex-wrap items-center gap-3 py-3">
                <Building2 className="h-4 w-4 shrink-0 text-mute" aria-hidden />
                <button
                  type="button"
                  onClick={() => onEditUnit(unit)}
                  className="min-w-0 flex-1 text-start"
                >
                  <span
                    className={cx(
                      'block truncate text-sm font-semibold',
                      unit.archived ? 'text-mute line-through' : 'text-ink'
                    )}
                  >
                    {unit.name}
                  </span>
                  <span className="block truncate text-xs text-slate">
                    {unit.address || '—'}
                    {' · '}
                    <span className="font-mono tnum">
                      {t.invoicesCount(unit.invoiceCount)} · {money(unit.totalBilled, settings.billing.currency)}
                    </span>
                  </span>
                </button>

                {unit.archived && (
                  <span className="rounded border border-rule px-2 py-0.5 font-narrow text-[10px] uppercase tracking-wider text-mute">
                    {t.archived}
                  </span>
                )}

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onToggleArchive(unit)}
                    title={unit.archived ? t.restoreUnit : t.archiveUnit}
                    aria-label={unit.archived ? t.restoreUnit : t.archiveUnit}
                    className="rounded p-2 text-mute transition-colors hover:bg-black/5 hover:text-pine"
                  >
                    {unit.archived ? (
                      <ArchiveRestore className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteUnit(unit)}
                    title={t.deleteUnit}
                    aria-label={`${t.deleteUnit} — ${unit.name}`}
                    className="rounded p-2 text-mute transition-colors hover:bg-seal-tint hover:text-seal"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Database Backup & Restore */}
      <DatabaseBackupRestoreSection t={t} notify={notify} />

      {/* Save bar sticks to the bottom so long forms never hide their action. */}
      <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper/95 px-4 py-3 shadow-lg backdrop-blur">
        <Button type="button" variant="ghost" size="sm" icon={RotateCcw} onClick={onReset}>
          {t.resetSettings}
        </Button>
        <Button
          type="button"
          variant="primary"
          icon={Save}
          busy={saving}
          disabled={!dirty}
          onClick={() => onSave(draft)}
        >
          {saving ? t.saving : t.saveSettings}
        </Button>
      </div>
    </div>
  );
}

function DatabaseBackupRestoreSection({
  t,
  notify,
}: {
  t: Dictionary;
  notify: SettingsPageProps['notify'];
}) {
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCreateBackup = async () => {
    setBackingUp(true);
    try {
      await api.downloadDatabaseBackup();
      notify(t.backupSuccess, 'success');
    } catch (err: any) {
      notify(err?.message || 'Échec de la création de la sauvegarde.', 'error');
    } finally {
      setBackingUp(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'db' && ext !== 'sqlite') {
      notify(t.invalidDbFile, 'error');
      return;
    }

    if (file.size === 0) {
      notify('Le fichier sélectionné est vide.', 'error');
      return;
    }

    setPendingFile(file);
  };

  const handleConfirmRestore = async () => {
    if (!pendingFile) return;
    setRestoring(true);
    try {
      await api.restoreDatabaseBackup(pendingFile);
      notify(t.restoreSuccess, 'success');
      setPendingFile(null);
      setTimeout(() => {
        window.location.reload();
      }, 1200);
    } catch (err: any) {
      notify(err?.message || 'Échec de la restauration de la base de données.', 'error');
      setRestoring(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <Panel className="p-5">
      <SectionTitle>{t.sectionBackupRestore}</SectionTitle>

      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-slate">
          {t.backupRestoreDesc}
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".db,.sqlite"
          className="sr-only"
          onChange={handleFileChange}
        />

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button
            type="button"
            variant="primary"
            icon={Download}
            busy={backingUp}
            onClick={handleCreateBackup}
          >
            {backingUp ? t.creatingBackup : t.createBackup}
          </Button>

          <Button
            type="button"
            variant="secondary"
            icon={Upload}
            busy={restoring}
            onClick={() => fileInputRef.current?.click()}
          >
            {restoring ? t.restoringDatabase : t.restoreDatabase}
          </Button>
        </div>
      </div>

      {/* Confirmation Modal */}
      <Modal
        open={pendingFile !== null}
        title={t.confirmRestoreTitle}
        onClose={() => !restoring && setPendingFile(null)}
        closeLabel="Fermer"
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={restoring}
              onClick={() => setPendingFile(null)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant="danger"
              icon={Database}
              busy={restoring}
              onClick={handleConfirmRestore}
            >
              {restoring ? t.restoringDatabase : t.restoreDatabase}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-seal/30 bg-seal-tint/40 p-3 text-sm text-seal">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <p className="leading-snug">{t.confirmRestoreBody}</p>
          </div>

          {pendingFile && (
            <div className="rounded-md border border-rule bg-desk/40 p-3 text-xs space-y-1 font-mono">
              <div className="text-ink font-sans font-medium">{t.selectedFile} :</div>
              <div className="text-pine font-bold break-all">{pendingFile.name}</div>
              <div className="text-mute font-sans">{t.fileSize} : {formatSize(pendingFile.size)}</div>
            </div>
          )}
        </div>
      </Modal>
    </Panel>
  );
}
