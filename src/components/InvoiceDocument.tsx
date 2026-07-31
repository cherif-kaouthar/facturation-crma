import React, { useMemo } from 'react';
import type { Invoice, Language, Settings } from '../types';
import type { Dictionary } from '../lib/i18n';
import { computeLine, isVatExemptLine, longDate, money, percent } from '../lib/format';
import { amountInWords } from '../lib/numberToWords';
import { BrandLogo } from './Brand';
import { Imprint, cx } from './ui';

interface InvoiceDocumentProps {
  invoice: Invoice;
  settings: Settings;
  lang: Language;
  t: Dictionary;
}

/**
 * The A4 sheet. It sets its own type — Source Serif for Latin, Naskh for
 * Arabic — so the document reads as a printed record rather than as part of
 * the tool that produced it.
 */
export function InvoiceDocument({ invoice, settings, lang, t }: InvoiceDocumentProps) {
  const { company, client, branding, billing } = settings;
  const currency = billing.currency;

  const lines = useMemo(
    () => invoice.lines.map((line) => ({ ...line, ...computeLine(line, invoice.tvaRate) })),
    [invoice]
  );
  const totals = invoice.totals;
  const spelled = useMemo(() => amountInWords(totals.total, lang), [totals.total, lang]);

  const docFont = lang === 'ar' ? 'font-arabic-doc' : 'font-doc';

  const isLandscape = billing.pageOrientation === 'landscape';

  return (
    <article
      className={cx(
        'sheet mx-auto w-full bg-paper text-ink shadow-lg border border-rule',
        isLandscape ? 'max-w-[297mm] px-6 py-6 sm:px-8 sm:py-8' : 'max-w-[210mm] px-8 py-10 sm:px-12 sm:py-14',
        docFont
      )}
    >
      {/* ---------------- Header ---------------- */}
      <header className="flex flex-col gap-3 border-b-2 border-pine pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <BrandLogo logo={branding.logo} className={cx('shrink-0', isLandscape ? 'h-12 w-12' : 'h-16 w-16')} alt={company.name} />
          <div className="space-y-0.5 text-[10px] leading-snug">
            <h2 className="font-display text-sm font-bold uppercase tracking-wide text-pine">
              {company.name}
            </h2>
            {company.address && <p className="font-semibold text-ink">{company.address}</p>}
            {company.agrement && <p className="text-slate">{company.agrement}</p>}
            <dl className="pt-1 font-mono text-[10px] leading-relaxed text-slate">
              {company.nif && (
                <div className="flex gap-1.5">
                  <dt className="font-semibold text-ink">{t.nif}</dt>
                  <dd className="tnum">{company.nif}</dd>
                </div>
              )}
              {company.art && (
                <div className="flex gap-1.5">
                  <dt className="font-semibold text-ink">{t.art}</dt>
                  <dd className="tnum">{company.art}</dd>
                </div>
              )}
              {company.bna && <div className="tnum">{company.bna}</div>}
              {company.ccp && <div className="tnum">{company.ccp}</div>}
              {(company.tel || company.fax) && (
                <div className="tnum pt-0.5">
                  {company.tel && `${t.tel} ${company.tel}`}
                  {company.tel && company.fax && ' · '}
                  {company.fax && `${t.fax} ${company.fax}`}
                </div>
              )}
              {company.customFields?.map((field, i) =>
                field.label && field.value ? (
                  <div key={i} className="flex gap-1.5 pt-0.5">
                    <dt className="font-semibold text-ink">{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ) : null
              )}
            </dl>
          </div>
        </div>

        <div className="shrink-0 space-y-4 sm:ltr:text-right sm:rtl:text-left">
          <p className="text-xs text-slate">
            {t.issuedAt(company.city)}{' '}
            <span className="font-mono tnum font-semibold text-ink">{longDate(invoice.date, lang)}</span>
          </p>

          <div className="min-w-[16rem] border-pine bg-pine-tint/60 px-4 py-3 ltr:border-l-3 ltr:text-left rtl:border-r-3 rtl:text-right">
            <p className="font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pine">
              {t.billedTo}
            </p>
            <p className="mt-1 text-sm font-bold text-ink">
              {invoice.clientName || client.name || 'LAITERIE FROMAGERIE LFB'}
            </p>
            {invoice.clientLocation && (
              <p className="text-xs text-slate">{invoice.clientLocation}</p>
            )}
            {invoice.clientPhone && (
              <p className="text-xs text-slate">Tél : {invoice.clientPhone}</p>
            )}
            {invoice.clientType === 'company' && (invoice.clientNif || invoice.clientArt) && (
              <div className="mt-1 space-y-0.5 font-mono text-[10px] text-slate">
                {invoice.clientNif && (
                  <p>
                    <strong className="text-ink font-sans">NIF :</strong> {invoice.clientNif}
                  </p>
                )}
                {invoice.clientArt && (
                  <p>
                    <strong className="text-ink font-sans">N/ART :</strong> {invoice.clientArt}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ---------------- Title ---------------- */}
      <div className="flex flex-wrap items-center justify-center gap-4 py-7">
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.16em] text-pine sm:text-2xl">
          {t.invoiceTitle}
        </h1>
        <Imprint reference={invoice.reference} doc />
      </div>

      {/* ---------------- Lines ---------------- */}
      <table className="w-full border-collapse border border-ink text-[11px]">
        <thead>
          <tr className="bg-pine text-white">
            <th scope="col" className="w-8 border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider">
              #
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-left rtl:text-right">
              {t.police}
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-left rtl:text-right">
              {t.echeance}
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-right rtl:text-left">
              {t.nette}
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-right rtl:text-left">
              {`${t.tva} ${percent(invoice.tvaRate, lang)}`}
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-right rtl:text-left">
              {t.fga}
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-right rtl:text-left">
              {t.timbre}
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-right rtl:text-left">
              {t.lineTotal}
            </th>
            <th scope="col" className="border border-pine-dark px-2 py-2 font-display text-[9px] font-bold uppercase tracking-wider ltr:text-left rtl:text-right">
              {t.observations}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.id}>
              <td className="border border-rule px-2 py-1.5 text-center font-mono tnum text-slate">{index + 1}</td>
              <td className="border border-rule px-2 py-1.5 font-mono font-semibold ltr:text-left rtl:text-right">
                {line.police || '—'}
              </td>
              <td className="border border-rule px-2 py-1.5 font-mono tnum text-slate ltr:text-left rtl:text-right">
                {line.echeance ? longDate(line.echeance, lang) : '—'}
              </td>
              <td className="border border-rule px-2 py-1.5 font-mono tnum ltr:text-right rtl:text-left">
                {money(line.nette, currency)}
              </td>
              <td className="border border-rule px-2 py-1.5 font-mono tnum ltr:text-right rtl:text-left">
                {money(line.tva, currency)}
                {isVatExemptLine(line) && (
                  <span className="block text-[8px] text-slate font-sans italic font-normal">
                    Exonéré
                  </span>
                )}
              </td>
              <td className="border border-rule px-2 py-1.5 font-mono tnum ltr:text-right rtl:text-left">
                {money(line.fga, currency)}
              </td>
              <td className="border border-rule px-2 py-1.5 font-mono tnum ltr:text-right rtl:text-left">
                {money(line.timbre, currency)}
              </td>
              <td className="border border-rule px-2 py-1.5 font-mono tnum font-bold text-pine ltr:text-right rtl:text-left">
                {money(line.total, currency)}
              </td>
              <td className="border border-rule px-2 py-1.5 italic text-slate ltr:text-left rtl:text-right">
                {line.obs || '—'}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-desk font-bold">
            <td colSpan={3} className="border border-ink px-2 py-2.5 font-display text-[9px] uppercase tracking-[0.12em] ltr:text-right rtl:text-left">
              {t.grandTotal}
            </td>
            <td className="border border-ink px-2 py-2.5 font-mono tnum ltr:text-right rtl:text-left">
              {money(totals.nette, currency)}
            </td>
            <td className="border border-ink px-2 py-2.5 font-mono tnum ltr:text-right rtl:text-left">
              {money(totals.tva, currency)}
            </td>
            <td className="border border-ink px-2 py-2.5 font-mono tnum ltr:text-right rtl:text-left">
              {money(totals.fga, currency)}
            </td>
            <td className="border border-ink px-2 py-2.5 font-mono tnum ltr:text-right rtl:text-left">
              {money(totals.timbre, currency)}
            </td>
            <td colSpan={2} className="border border-ink bg-pine px-2 py-2.5 font-mono tnum text-[13px] text-white ltr:text-right rtl:text-left">
              {money(totals.total, currency)}
            </td>
          </tr>
        </tfoot>
      </table>

      {/* ---------------- Amount in words ---------------- */}
      <div className="avoid-break mt-6 border border-dashed border-pine/50 bg-pine-tint/40 px-4 py-3">
        <p className="font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pine">
          {t.amountInWords}
        </p>
        <p className="mt-1 text-[13px] font-semibold leading-relaxed">« {spelled} »</p>
      </div>

      {/* ---------------- Signature ---------------- */}
      <div className="avoid-break mt-6 flex justify-end">
        <p className="font-display text-xs font-bold text-pine ltr:text-right rtl:text-left">{t.signature}</p>
      </div>
    </article>
  );
}
