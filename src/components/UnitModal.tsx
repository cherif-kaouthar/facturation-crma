import React, { useEffect, useState } from 'react';
import type { Unit } from '../types';
import type { Dictionary } from '../lib/i18n';
import { Button, Field, Modal, inputClass } from './ui';

interface UnitModalProps {
  open: boolean;
  unit: Unit | null;
  t: Dictionary;
  saving: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; address: string }) => void;
}

export function UnitModal({ open, unit, t, saving, onClose, onSubmit }: UnitModalProps) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(unit?.name ?? '');
    setAddress(unit?.address ?? '');
    setError('');
  }, [open, unit]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t.requiredField);
      return;
    }
    onSubmit({ name: name.trim(), address: address.trim() });
  };

  return (
    <Modal
      open={open}
      title={unit ? t.unit : t.addUnit}
      onClose={onClose}
      closeLabel={t.dismiss}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t.cancel}
          </Button>
          <Button type="submit" form="unit-form" variant="primary" busy={saving}>
            {saving ? t.saving : unit ? t.save : t.createUnit}
          </Button>
        </>
      }
    >
      <form id="unit-form" onSubmit={submit} className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md border border-seal/30 bg-seal-tint px-3 py-2 text-sm text-seal">
            {error}
          </p>
        )}
        <Field label={t.unitName} hint={t.unitNameHint} htmlFor="unit-name">
          <input
            id="unit-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
            required
          />
        </Field>
        <Field label={t.unitAddress} hint={t.unitAddressHint} htmlFor="unit-address">
          <input
            id="unit-address"
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className={inputClass}
          />
        </Field>
      </form>
    </Modal>
  );
}
