import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, FileDown, Plus, Save, Trash2, Upload, X } from 'lucide-react';
import type { Client, ClientType, Invoice, InvoiceDraft, InvoiceLine, Settings, Unit } from '../types';
import type { Dictionary } from '../lib/i18n';
import { computeLine, computeTotals, isVatExemptLine, money, percent, todayIso, toAmount } from '../lib/format';
import { amountInWords } from '../lib/numberToWords';
import { Button, Combobox, Field, Imprint, Modal, Panel, SectionTitle, cx, inputClass } from './ui';

interface InvoiceEditorProps {
  invoice: Invoice | null;
  units: Unit[];
  clients: Client[];
  defaultUnitId: number;
  nextNumber: string;
  settings: Settings;
  t: Dictionary;
  saving: boolean;
  onSave: (draft: InvoiceDraft) => void;
  onCancel: () => void;
  onAddNewClient?: () => void;
}

type DraftLine = InvoiceLine;

let lineKey = 0;
const newKey = () => `draft-${(lineKey += 1)}`;

function blankLine(settings: Settings, date: string): DraftLine {
  return {
    id: newKey(),
    police: '',
    echeance: date,
    nette: 0,
    fga: 0,
    timbre: settings.billing.defaultTimbre,
    obs: settings.billing.defaultObs,
  };
}

/** Amount cell: keeps the raw keystrokes so "1200." and "" stay typable. */
function AmountInput({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  label: string;
}) {
  const [text, setText] = useState<string | null>(null);

  return (
    <input
      type="number"
      inputMode="decimal"
      step="0.01"
      min="0"
      aria-label={label}
      value={text ?? (value === 0 ? '' : String(value))}
      placeholder="0,00"
      onChange={(event) => {
        setText(event.target.value);
        onChange(toAmount(event.target.value));
      }}
      onBlur={() => setText(null)}
      className={cx(inputClass, 'amount-input px-2 py-1.5 text-right font-mono tnum text-[13px]')}
    />
  );
}

export function InvoiceEditor({
  invoice,
  units,
  clients,
  defaultUnitId,
  nextNumber,
  settings,
  t,
  saving,
  onSave,
  onCancel,
  onAddNewClient,
}: InvoiceEditorProps) {
  const isEdit = invoice !== null;
  const [unitId, setUnitId] = useState<number>(invoice?.unitId ?? defaultUnitId);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(
    invoice?.clientId ?? null
  );
  const [clientName, setClientName] = useState<string>(
    invoice?.clientName ?? ''
  );
  const [clientType, setClientType] = useState<ClientType>(
    invoice?.clientType ?? 'company'
  );
  const [clientLocation, setClientLocation] = useState<string>(
    invoice?.clientLocation ?? ''
  );
  const [clientNif, setClientNif] = useState<string>(
    invoice?.clientNif ?? ''
  );
  const [clientArt, setClientArt] = useState<string>(
    invoice?.clientArt ?? ''
  );
  const [clientPhone, setClientPhone] = useState<string>(
    invoice?.clientPhone ?? ''
  );
  const [date, setDate] = useState<string>(invoice?.date ?? todayIso());
  const [notes, setNotes] = useState<string>(invoice?.notes ?? '');
  const [error, setError] = useState<string>('');

  const [showSuggestions, setShowSuggestions] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredClients = useMemo(() => {
    const query = clientName.trim().toLowerCase();
    const activeClients = clients.filter((c) => !c.archived);
    if (!query) return activeClients.slice(0, 8);
    return activeClients
      .filter((c) => {
        const nameMatch = c.name.toLowerCase().includes(query);
        const locMatch = c.location?.toLowerCase().includes(query);
        const nifMatch = c.nif?.toLowerCase().includes(query);
        const phoneMatch = c.phone?.toLowerCase().includes(query);
        return nameMatch || locMatch || nifMatch || phoneMatch;
      })
      .slice(0, 8);
  }, [clients, clientName]);

  const handleSelectClient = (chosen: Client) => {
    setSelectedClientId(chosen.id);
    setClientName(chosen.name);
    setClientType(chosen.type);
    setClientLocation(chosen.location || '');
    setClientNif(chosen.nif || '');
    setClientArt(chosen.art || '');
    setClientPhone(chosen.phone || '');
    setShowSuggestions(false);
  };

  const handleClientNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setClientName(val);
    setShowSuggestions(true);
    const match = clients.find((c) => c.name.toLowerCase() === val.trim().toLowerCase());
    if (match) {
      setSelectedClientId(match.id);
      setClientType(match.type);
      setClientLocation(match.location || '');
      setClientNif(match.nif || '');
      setClientArt(match.art || '');
      setClientPhone(match.phone || '');
    } else {
      setSelectedClientId(null);
    }
  };
  const [lines, setLines] = useState<DraftLine[]>(() =>
    invoice && invoice.lines.length > 0
      ? invoice.lines.map((line) => ({ ...line, id: newKey() }))
      : [blankLine(settings, invoice?.date ?? todayIso())]
  );

  // An issued invoice keeps the rate it was issued under; a new one takes today's.
  const tvaRate = invoice?.tvaRate ?? settings.billing.tvaRate;
  const currency = settings.billing.currency;

  const computed = useMemo(() => lines.map((line) => computeLine(line, tvaRate)), [lines, tvaRate]);
  const totals = useMemo(() => computeTotals(lines, tvaRate), [lines, tvaRate]);
  const spelled = useMemo(() => amountInWords(totals.total), [totals.total]);

  const patchLine = (id: string, patch: Partial<DraftLine>) =>
    setLines((previous) => previous.map((line) => (line.id === id ? { ...line, ...patch } : line)));

  const addLine = () => setLines((previous) => [...previous, blankLine(settings, date)]);

  const duplicateLine = (id: string) =>
    setLines((previous) => {
      const index = previous.findIndex((line) => line.id === id);
      if (index < 0) return previous;
      const copy = { ...previous[index], id: newKey() };
      return [...previous.slice(0, index + 1), copy, ...previous.slice(index + 1)];
    });

  const removeLine = (id: string) => {
    if (lines.length <= 1) {
      setError(t.atLeastOneLine);
      return;
    }
    setError('');
    setLines((previous) => previous.filter((line) => line.id !== id));
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    onSave({
      unitId,
      clientId: selectedClientId,
      clientName: clientName.trim(),
      clientType,
      clientLocation: clientLocation.trim(),
      clientNif: clientType === 'company' ? clientNif.trim() : '',
      clientArt: clientType === 'company' ? clientArt.trim() : '',
      clientPhone: clientPhone.trim(),
      date,
      year: Number(date.slice(0, 4)),
      notes,
      lines: lines.map(({ id, ...rest }) => rest),
    });
  };

  const selectedUnit = units.find((unit) => unit.id === unitId);
  const csvInputRef = useRef<HTMLInputElement>(null);

  interface CsvRow {
    police: string; echeance: string; nette: number; fga: number; timbre: number; obs: string; valid: boolean;
  }
  const [csvPreview, setCsvPreview] = useState<CsvRow[] | null>(null);

  const csvTemplate = `Police,Ã‰chÃ©ance,Nette,FGA,Timbre,Observations\n10/2026,2026-01-15,12500.00,2500.00,40,Assurance incendie\n11/2026,2026-02-15,8300.50,1660.00,40,Assurance tous risques`;

  function parseDate(raw: string): string {
    const s = raw.trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return s;
  }

  function parseCsv(text: string): CsvRow[] {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error();
    const header = lines[0];
    const delim = header.includes(';') ? ';' : ',';
    const rows: CsvRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim);
      if (cols.length < 3) continue;
      const parseNum = (s: string) => {
        if (!s) return 0;
        const normalized = s.trim().replace(',', '.').replace(/\s/g, '');
        const n = parseFloat(normalized);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
      };
      const nette = parseNum(cols[2]);
      const fga = parseNum(cols[3] ?? '');
      const timbre = parseNum(cols[4] ?? '');
      rows.push({
        police: (cols[0] ?? '').trim(),
        echeance: parseDate(cols[1] ?? ''),
        nette,
        fga,
        timbre,
        obs: (cols[5] ?? '').trim(),
        valid: nette + fga + timbre > 0,
      });
    }
    return rows;
  }

  const handleCsvFile = (file: File | undefined) => {
    if (!file) return;
    setError('');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = parseCsv(String(reader.result ?? ''));
        if (imported.length === 0) throw new Error();
        setCsvPreview(imported);
      } catch {
        setError(t.csvParseError);
      }
    };
    reader.readAsText(file);
  };

  const confirmCsvImport = () => {
    if (!csvPreview) return;
    const validRows = csvPreview.filter((r) => r.valid);
    if (validRows.length === 0) return;
    const newLines = validRows.map((row) => ({
      id: newKey(),
      police: row.police,
      echeance: row.echeance || date,
      nette: row.nette,
      fga: row.fga,
      timbre: row.timbre,
      obs: row.obs,
    }));
    setLines((prev) => {
      if (prev.length === 1 && !prev[0].police && prev[0].nette === 0 && prev[0].fga === 0) {
        return newLines;
      }
      return [...prev, ...newLines];
    });
    setCsvPreview(null);
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <Panel className="overflow-hidden">
        {/* Header: identity of the document being written */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule bg-desk/50 px-5 py-4">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="font-narrow text-lg font-bold uppercase tracking-[0.06em] text-pine">
                {isEdit ? t.editInvoiceTitle : t.newInvoiceTitle}
              </h1>
              <p className="mt-0.5 text-xs text-slate">
                {isEdit ? t.numberLocked : t.numberAssigned}
              </p>
            </div>
          </div>
          <Imprint
            reference={
              isEdit ? invoice.reference : `${nextNumber}/${new Date(`${date}T00:00:00`).getFullYear() || ''}`
            }
          />
        </header>

        <div className="space-y-7 px-5 py-6">
          {error && (
            <p role="alert" className="rounded-md border border-seal/30 bg-seal-tint px-4 py-2.5 text-sm text-seal">
              {error}
            </p>
          )}

          {/* Header fields */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t.unit} htmlFor="editor-unit" className="lg:col-span-2">
              <select
                id="editor-unit"
                value={unitId}
                onChange={(event) => setUnitId(Number(event.target.value))}
                className={inputClass}
                required
              >
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t.invoiceDate} htmlFor="editor-date">
              <input
                id="editor-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className={cx(inputClass, 'font-mono tnum')}
                required
              />
            </Field>

            <Field label={t.tva} htmlFor="editor-tva">
              <input
                id="editor-tva"
                type="text"
                value={percent(tvaRate)}
                readOnly
                tabIndex={-1}
                className={cx(inputClass, 'cursor-default bg-desk font-mono tnum text-slate')}
              />
            </Field>

            {/* Client Info (Doit) Section - Autocomplete Input */}
            <div className="lg:col-span-12 rounded-lg border border-rule bg-desk/30 p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-rule/60 pb-2">
                <p className="font-narrow text-xs font-bold uppercase tracking-[0.08em] text-pine">
                  {t.sectionClient} ({t.billedTo})
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {/* Client Name Input with Autocomplete */}
                <Field label={t.clientNameLabel} htmlFor="editor-client-name" className="lg:col-span-2 relative">
                  <div className="relative" ref={dropdownRef}>
                    <input
                      id="editor-client-name"
                      type="text"
                      value={clientName}
                      onChange={handleClientNameChange}
                      onFocus={() => setShowSuggestions(true)}
                      placeholder=""
                      className={inputClass}
                      autoComplete="off"
                      required
                    />
                    {showSuggestions && filteredClients.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-md border border-rule bg-paper shadow-lg py-1">
                        {filteredClients.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleSelectClient(c);
                            }}
                            className="w-full text-left px-3 py-2 text-xs hover:bg-desk transition-colors border-b border-rule/30 last:border-0 flex flex-col gap-1"
                          >
                            <div className="flex items-center justify-between font-semibold text-ink">
                              <span>{c.name}</span>
                              <span className="text-[10px] uppercase tracking-wider text-pine bg-pine/10 px-1.5 py-0.5 rounded font-mono">
                                {c.type === 'company' ? 'Entreprise' : 'Particulier'}
                              </span>
                            </div>
                            {(c.location || c.nif || c.phone || c.art) && (
                              <div className="text-[11px] text-slate flex flex-wrap gap-x-3 gap-y-0.5">
                                {c.location && <span>ðŸ“ {c.location}</span>}
                                {c.phone && <span>ðŸ“ž {c.phone}</span>}
                                {c.nif && <span>NIF: {c.nif}</span>}
                                {c.art && <span>NÂ°Art: {c.art}</span>}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Field>

                {/* Client Location / Address Input */}
                <Field label={t.clientLocationLabel} htmlFor="editor-client-location">
                  <input
                    id="editor-client-location"
                    type="text"
                    value={clientLocation}
                    onChange={(e) => setClientLocation(e.target.value)}
                    placeholder="ex. Wilaya de Tizi Ouzou"
                    className={inputClass}
                  />
                </Field>

                {/* Client Phone Input */}
                <Field label={t.phone} htmlFor="editor-client-phone">
                  <input
                    id="editor-client-phone"
                    type="text"
                    value={clientPhone}
                    onChange={(e) => setClientPhone(e.target.value)}
                    placeholder="ex. 026 34 12 80"
                    className={inputClass}
                  />
                </Field>

                {/* Company Identifiers: NIF & N/ART Inputs */}
                {clientType === 'company' && (
                  <>
                    <Field label={t.clientNifLabel} htmlFor="editor-client-nif" className="lg:col-span-2">
                      <input
                        id="editor-client-nif"
                        type="text"
                        value={clientNif}
                        onChange={(e) => setClientNif(e.target.value)}
                        placeholder="ex. 000115019008821"
                        className={inputClass}
                      />
                    </Field>

                    <Field label={t.clientArtLabel} htmlFor="editor-client-art" className="lg:col-span-2">
                      <input
                        id="editor-client-art"
                        type="text"
                        value={clientArt}
                        onChange={(e) => setClientArt(e.target.value)}
                        placeholder="ex. 1501004523"
                        className={inputClass}
                      />
                    </Field>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Lines */}
          <div>
            <SectionTitle
              aside={
                <div className="flex items-center gap-2">
                  <input
                    ref={csvInputRef}
                    type="file"
                    accept=".csv"
                    className="sr-only"
                    onChange={(e) => { handleCsvFile(e.target.files?.[0]); e.target.value = ''; }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const blob = new Blob(['\ufeff' + csvTemplate], { type: 'text/csv;charset=utf-8;' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'lfb-template.csv';
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    title={t.downloadTemplate}
                    aria-label={t.downloadTemplate}
                    className="rounded p-1.5 text-mute transition-colors hover:bg-black/5 hover:text-pine"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => csvInputRef.current?.click()}
                    title={t.importCsv}
                    aria-label={t.importCsv}
                    className="rounded p-1.5 text-mute transition-colors hover:bg-black/5 hover:text-pine"
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </button>
                  <span className="font-mono tnum text-xs text-slate">{lines.length}</span>
                </div>
              }
            >
              {t.lines}
            </SectionTitle>

            <div className="overflow-x-auto rounded-md border border-rule">
              <table className="w-full min-w-[58rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-rule bg-desk/60 font-narrow text-[10px] uppercase tracking-[0.1em] text-slate">
                    <th scope="col" className="w-8 px-2 py-2 font-semibold">#</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-left">{t.police}</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-left">{t.echeance}</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-right">{t.nette}</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-right">{t.tva}</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-right">{t.fga}</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-right">{t.timbre}</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-right">{t.lineTotal}</th>
                    <th scope="col" className="px-2 py-2 font-semibold text-left">{t.observations}</th>
                    <th scope="col" className="w-16 px-2 py-2"><span className="sr-only">{t.removeLine}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.id} className="ledger-row align-middle">
                      <td className="px-2 py-1.5 text-center font-mono tnum text-xs text-mute">
                        {index + 1}
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          value={line.police}
                          onChange={(event) => patchLine(line.id, { police: event.target.value })}
                          placeholder="10/2026"
                          aria-label={`${t.police} ${index + 1}`}
                          className={cx(inputClass, 'min-w-[7rem] px-2 py-1.5 font-mono text-[13px]')}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="date"
                          value={line.echeance}
                          onChange={(event) => patchLine(line.id, { echeance: event.target.value })}
                          aria-label={`${t.echeance} ${index + 1}`}
                          className={cx(inputClass, 'min-w-[8.5rem] px-2 py-1.5 font-mono tnum text-[13px]')}
                        />
                      </td>
                      <td className="w-32 px-2 py-1.5">
                        <AmountInput
                          value={line.nette}
                          onChange={(nette) => patchLine(line.id, { nette })}
                          label={`${t.nette} ${index + 1}`}
                        />
                      </td>
                      <td className="w-28 bg-desk/40 px-3 py-1.5 font-mono tnum text-[13px] text-slate text-right">
                        {money(computed[index].tva, currency)}
                        {isVatExemptLine(line) && (
                          <span className="block text-[10px] text-pine font-sans italic font-normal">
                            ExonÃ©rÃ©
                          </span>
                        )}
                      </td>
                      <td className="w-28 px-2 py-1.5">
                        <AmountInput
                          value={line.fga}
                          onChange={(fga) => patchLine(line.id, { fga })}
                          label={`${t.fga} ${index + 1}`}
                        />
                      </td>
                      <td className="w-24 px-2 py-1.5">
                        <AmountInput
                          value={line.timbre}
                          onChange={(timbre) => patchLine(line.id, { timbre })}
                          label={`${t.timbre} ${index + 1}`}
                        />
                      </td>
                      <td className="w-32 bg-pine-tint/50 px-3 py-1.5 font-mono tnum text-[13px] font-semibold text-pine text-right">
                        {money(computed[index].total, currency)}
                      </td>
                      <td className="px-2 py-1.5">
                        <Combobox
                          value={line.obs}
                          onChange={(obs) => patchLine(line.id, { obs })}
                          options={settings.billing.observationPresets}
                          placeholder={settings.billing.defaultObs}
                          ariaLabel={`${t.observations} ${index + 1}`}
                          className="min-w-[12rem] text-[13px]"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <button
                            type="button"
                            onClick={() => duplicateLine(line.id)}
                            title={t.duplicateLine}
                            aria-label={`${t.duplicateLine} ${index + 1}`}
                            className="rounded p-1.5 text-mute transition-colors hover:bg-black/5 hover:text-pine"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeLine(line.id)}
                            title={t.removeLine}
                            aria-label={`${t.removeLine} ${index + 1}`}
                            className="rounded p-1.5 text-mute transition-colors hover:bg-seal-tint hover:text-seal"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-rule bg-desk/70 font-mono tnum text-[13px] font-semibold text-ink">
                    <td colSpan={3} className="px-3 py-2.5 font-narrow text-[10px] font-bold uppercase tracking-[0.12em] text-slate text-right">
                      {t.grandTotal}
                    </td>
                    <td className="px-3 py-2.5 text-right">{money(totals.nette, currency)}</td>
                    <td className="px-3 py-2.5 text-right">{money(totals.tva, currency)}</td>
                    <td className="px-3 py-2.5 text-right">{money(totals.fga, currency)}</td>
                    <td className="px-3 py-2.5 text-right">{money(totals.timbre, currency)}</td>
                    <td className="bg-pine px-3 py-2.5 text-white text-right">
                      {money(totals.total, currency)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mt-3">
              <Button type="button" variant="secondary" size="sm" icon={Plus} onClick={addLine}>
                {t.addLine}
              </Button>
            </div>
          </div>

          {/* Amount in words â€” a live preview of the legal sentence on the sheet */}
          <div className="rounded-md border border-rule bg-desk/40 px-4 py-3.5">
            <p className="font-narrow text-[10px] font-semibold uppercase tracking-[0.12em] text-slate">
              {t.amountInWords}
            </p>
            <p
              className="mt-1.5 text-[15px] leading-relaxed text-ink font-doc italic"
            >
              {spelled}
            </p>
          </div>

          {/* Internal note */}
          <Field label={t.notes} hint={t.notesHint} htmlFor="editor-notes">
            <textarea
              id="editor-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              maxLength={500}
              className={cx(inputClass, 'resize-y')}
            />
          </Field>
        </div>

        {/* CSV preview confirmation modal */}
        <Modal
          open={csvPreview !== null}
          title={t.csvPreviewTitle}
          onClose={() => setCsvPreview(null)}
          closeLabel={t.dismiss}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCsvPreview(null)}>{t.cancel}</Button>
              <Button
                variant="primary"
                icon={Upload}
                disabled={!csvPreview?.some((r) => r.valid)}
                onClick={confirmCsvImport}
              >
                {t.csvConfirmImport}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-slate">{t.csvPreviewHint}</p>
          {csvPreview && (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-rule">
              {csvPreview.map((row, i) => (
                <div
                  key={i}
                  className={cx(
                    'flex items-center gap-3 px-3 py-2 text-xs',
                    i > 0 && 'border-t border-rule-soft',
                    row.valid ? 'bg-pine-tint/20' : 'bg-seal-tint/40'
                  )}
                >
                  <span
                    className={cx(
                      'shrink-0 rounded px-1.5 py-0.5 font-narrow text-[9px] font-bold uppercase tracking-wider',
                      row.valid
                        ? 'bg-pine-tint text-pine'
                        : 'bg-seal-tint text-seal'
                    )}
                  >
                    {row.valid ? t.csvValid : t.csvInvalid}
                  </span>
                  <span className="min-w-[6rem] truncate font-mono">{row.police || 'â€”'}</span>
                  <span className="font-mono tnum text-slate">{row.echeance || 'â€”'}</span>
                  <span className="ml-auto font-mono tnum font-semibold">
                    {money(row.nette + row.fga + row.timbre, currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {csvPreview && (
            <div className="mt-2 flex gap-3 text-xs text-mute">
              <span>{t.csvRowTotal(csvPreview.length)}</span>
              <span className="text-pine">Â· {t.csvValidCount(csvPreview.filter((r) => r.valid).length)}</span>
            </div>
          )}
        </Modal>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-rule bg-desk/50 px-5 py-4">
          <p className="text-xs text-slate">
            {selectedUnit ? `${selectedUnit.name}${selectedUnit.address ? ` â€” ${selectedUnit.address}` : ''}` : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" icon={X} onClick={onCancel} disabled={saving}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="primary" icon={Save} busy={saving}>
              {saving ? t.saving : t.save}
            </Button>
          </div>
        </footer>
      </Panel>
    </form>
  );
}
