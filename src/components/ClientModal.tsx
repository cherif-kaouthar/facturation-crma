import React, { useEffect, useState } from 'react';
import { Building2, User } from 'lucide-react';
import type { Client, ClientType, Language } from '../types';
import type { Dictionary } from '../lib/i18n';
import { Button, Field, inputClass, Modal } from './ui';

interface ClientModalProps {
  open: boolean;
  client?: Client | null;
  busy: boolean;
  lang: Language;
  t: Dictionary;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    type: ClientType;
    location: string;
    nif: string;
    art: string;
    phone: string;
    email: string;
    archived?: boolean;
  }) => Promise<void>;
}

export function ClientModal({
  open,
  client,
  busy,
  t,
  onClose,
  onSubmit,
}: ClientModalProps) {
  const [type, setType] = useState<ClientType>('company');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [nif, setNif] = useState('');
  const [art, setArt] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (client) {
        setType(client.type || 'company');
        setName(client.name || '');
        setLocation(client.location || '');
        setNif(client.nif || '');
        setArt(client.art || '');
        setPhone(client.phone || '');
        setEmail(client.email || '');
      } else {
        setType('company');
        setName('');
        setLocation('');
        setNif('');
        setArt('');
        setPhone('');
        setEmail('');
      }
      setError(null);
    }
  }, [open, client]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t.requiredField);
      return;
    }
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        type,
        location: location.trim(),
        nif: type === 'company' ? nif.trim() : '',
        art: type === 'company' ? art.trim() : '',
        phone: phone.trim(),
        email: email.trim(),
        archived: client?.archived || false,
      });
    } catch (err: any) {
      setError(err?.message || 'Erreur lors de l’enregistrement');
    }
  };

  return (
    <Modal
      open={open}
      title={client ? t.editClient : t.addClient}
      onClose={onClose}
      closeLabel={t.cancel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.cancel}
          </Button>
          <Button variant="primary" busy={busy} onClick={handleSubmit}>
            {t.save}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-md border border-seal/30 bg-seal-tint p-3 text-xs text-seal">
            {error}
          </div>
        )}

        {/* Client Type Selector */}
        <Field label={t.clientType}>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setType('company')}
              className={`flex items-center justify-center gap-2 rounded-md border p-2.5 text-xs font-semibold transition-colors ${
                type === 'company'
                  ? 'border-pine bg-pine/10 text-pine'
                  : 'border-rule bg-paper text-slate hover:border-pine-mid hover:text-ink'
              }`}
            >
              <Building2 className="h-4 w-4 shrink-0" />
              <span>{t.company}</span>
            </button>
            <button
              type="button"
              onClick={() => setType('person')}
              className={`flex items-center justify-center gap-2 rounded-md border p-2.5 text-xs font-semibold transition-colors ${
                type === 'person'
                  ? 'border-pine bg-pine/10 text-pine'
                  : 'border-rule bg-paper text-slate hover:border-pine-mid hover:text-ink'
              }`}
            >
              <User className="h-4 w-4 shrink-0" />
              <span>{t.person}</span>
            </button>
          </div>
        </Field>

        {/* Name / Raison sociale */}
        <Field label={t.clientNameLabel} htmlFor="client-name">
          <input
            id="client-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'company' ? 'ex. LAITERIE FROMAGERIE LFB' : 'ex. Kamel Haddad'}
            className={inputClass}
            required
            autoFocus
          />
        </Field>

        {/* Location / Address */}
        <Field label={t.clientLocationLabel} hint={t.locationHint} htmlFor="client-location">
          <input
            id="client-location"
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="ex. Draâ El Mizan, Wilaya de Tizi Ouzou"
            className={inputClass}
          />
        </Field>

        {/* Conditional Company Info: NIF & N/ART */}
        {type === 'company' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t.clientNifLabel} htmlFor="client-nif">
              <input
                id="client-nif"
                type="text"
                value={nif}
                onChange={(e) => setNif(e.target.value)}
                placeholder="ex. 000115019008821"
                className={inputClass}
              />
            </Field>

            <Field label={t.clientArtLabel} htmlFor="client-art">
              <input
                id="client-art"
                type="text"
                value={art}
                onChange={(e) => setArt(e.target.value)}
                placeholder="ex. 1501004523"
                className={inputClass}
              />
            </Field>
          </div>
        )}

        {/* Phone & Email */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t.phone} htmlFor="client-phone">
            <input
              id="client-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="ex. 026 34 12 80"
              className={inputClass}
            />
          </Field>

          <Field label={t.email} htmlFor="client-email">
            <input
              id="client-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ex. contact@client.dz"
              className={inputClass}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
