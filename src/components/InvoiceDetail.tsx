import React, { useEffect, useState } from 'react';
import { ArrowLeft, Copy, Pencil, Printer, Trash2 } from 'lucide-react';
import type { Invoice, Settings } from '../types';
import type { Dictionary } from '../lib/i18n';
import { InvoiceDocument } from './InvoiceDocument';
import { Button, cx } from './ui';

interface InvoiceDetailProps {
  invoice: Invoice;
  settings: Settings;
  t: Dictionary;
  busy: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function InvoiceDetail({
  invoice: initialInvoice,
  settings,
  t,
  busy,
  onBack,
  onEdit,
  onDuplicate,
  onDelete,
}: InvoiceDetailProps) {
  const [invoice, setInvoice] = useState(initialInvoice);

  useEffect(() => { setInvoice(initialInvoice); }, [initialInvoice]);

  const orientation = invoice.pageOrientation || 'portrait';

  return (
    <div className="print-root mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <style>{`@page { size: A4 ${orientation}; margin: 10mm 12mm 14mm; }`}</style>

      {/* Action bar */}
      <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
          {t.backToLedger}
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-2 flex items-center gap-1 rounded-md border border-rule bg-desk/60 px-2 py-1">
            <button
              type="button"
              onClick={() => setInvoice({ ...invoice, pageOrientation: 'portrait' })}
              className={cx(
                'rounded px-2 py-1 text-xs font-semibold transition-colors',
                orientation === 'portrait' ? 'bg-pine text-white' : 'text-slate hover:text-ink'
              )}
            >
              {t.portrait}
            </button>
            <button
              type="button"
              onClick={() => setInvoice({ ...invoice, pageOrientation: 'landscape' })}
              className={cx(
                'rounded px-2 py-1 text-xs font-semibold transition-colors',
                orientation === 'landscape' ? 'bg-pine text-white' : 'text-slate hover:text-ink'
              )}
            >
              {t.landscape}
            </button>
          </div>

          <Button variant="secondary" icon={Pencil} onClick={onEdit}>
            {t.edit}
          </Button>
          <Button variant="secondary" icon={Copy} onClick={onDuplicate} busy={busy}>
            {t.duplicate}
          </Button>
          <Button variant="danger" icon={Trash2} onClick={onDelete}>
            {t.delete}
          </Button>
          <Button variant="primary" icon={Printer} onClick={() => window.print()}>
            {t.print}
          </Button>
        </div>
      </div>

      <InvoiceDocument invoice={invoice} settings={{ ...settings, billing: { ...settings.billing, pageOrientation: orientation } }} t={t} />
    </div>
  );
}
