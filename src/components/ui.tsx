import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-pine text-white hover:bg-pine-dark disabled:bg-pine/40',
  secondary: 'bg-paper text-ink border border-rule hover:bg-pine-tint hover:border-pine-mid',
  ghost: 'text-slate hover:text-ink hover:bg-black/5',
  danger: 'bg-seal-tint text-seal border border-seal/30 hover:bg-seal hover:text-white',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  icon: Icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-semibold',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2.5 text-sm',
        VARIANTS[variant],
        className
      )}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        Icon && <Icon className="h-4 w-4" aria-hidden />
      )}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Form fields                                                         */
/* ------------------------------------------------------------------ */

export const inputClass =
  'w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink ' +
  'placeholder:text-mute transition-colors hover:border-pine-mid/60 ' +
  'focus:border-pine-mid focus:outline-none disabled:bg-desk disabled:text-slate';

interface FieldProps {
  label: React.ReactNode;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, hint, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cx('space-y-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-snug text-mute">{hint}</p>}
    </div>
  );
}

/** Section heading used across Settings and the editor. */
export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4 border-b border-rule pb-2">
      <h2 className="font-narrow text-xs font-bold uppercase tracking-[0.14em] text-pine">
        {children}
      </h2>
      {aside}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section className={cx('rounded-lg border border-rule bg-paper', className)}>{children}</section>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  closeLabel: string;
}

export function Modal({ open, title, onClose, children, footer, closeLabel }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so keyboard users are not left behind it.
    panelRef.current?.querySelector<HTMLElement>('input, button, textarea')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="no-print fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-rule bg-paper shadow-2xl"
      >
        <header className="flex items-center justify-between gap-4 border-b border-rule px-5 py-3.5">
          <h2 className="font-narrow text-sm font-bold uppercase tracking-[0.1em] text-pine">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="rounded p-1 text-slate transition-colors hover:bg-black/5 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-5 py-5">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-rule bg-desk/50 px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'error';
}

export function Toaster({
  toasts,
  onDismiss,
  closeLabel,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
  closeLabel: string;
}) {
  return (
    <div
      className="no-print fixed bottom-5 left-1/2 z-60 flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            'flex items-start gap-3 rounded-md border px-4 py-3 text-sm shadow-lg',
            toast.tone === 'error'
              ? 'border-seal/30 bg-seal text-white'
              : 'border-pine-dark bg-pine text-white'
          )}
        >
          {toast.tone === 'error' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <p className="flex-1 leading-snug">{toast.text}</p>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label={closeLabel}
            className="rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <Icon className="h-7 w-7 text-mute" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {hint && <p className="text-sm text-slate">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-slate">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/** The app's signature mark: an invoice reference. */
export function Imprint({ reference, doc = false }: { reference: string; doc?: boolean }) {
  return <span className={cx('imprint', doc && 'imprint-doc')}>{reference}</span>;
}

/* ------------------------------------------------------------------ */
/* Combobox                                                            */
/* ------------------------------------------------------------------ */

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const listId = React.useId();
  const [inputValue, setInputValue] = useState(value);
  const [showCustom, setShowCustom] = useState(false);

  const isPreset = options.includes(value);

  useEffect(() => {
    setInputValue(value);
    setShowCustom(false);
  }, [value]);

  const handleSelect = (next: string) => {
    setInputValue(next);
    setShowCustom(false);
    onChange(next);
  };

  if (showCustom || (!isPreset && value && !options.includes(value))) {
    return (
      <div className="flex gap-1">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cx(inputClass, className)}
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            setShowCustom(false);
            if (options.length > 0) onChange(options[0]);
          }}
          title="Retour aux observations prédéfinies"
          className="shrink-0 rounded-md border border-rule bg-paper px-2 text-xs text-slate hover:bg-desk"
        >
          ←
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-1">
      <select
        value={isPreset ? value : ''}
        onChange={(e) => handleSelect(e.target.value)}
        aria-label={ariaLabel}
        className={cx(inputClass, className)}
      >
        {!value && <option value="">{placeholder || 'Sélectionner…'}</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
        {value && !isPreset && <option value={value}>{value}</option>}
      </select>
      <button
        type="button"
        onClick={() => setShowCustom(true)}
        title="Saisir une observation libre"
        className="shrink-0 rounded-md border border-rule bg-paper px-2 text-xs text-slate hover:bg-desk"
      >
        ✎
      </button>
    </div>
  );
}
