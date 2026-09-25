import React, { useState } from 'react';
import { Download, KeyRound, LogIn, ShieldCheck, ArrowLeft } from 'lucide-react';
import { authApi, setStoredToken } from '../lib/api';
import { getTranslation } from '../lib/i18n';
import { BrandLogo } from './Brand';
import { Button, cx, inputClass } from './ui';

type Screen = 'login' | 'setup' | 'reset' | 'recovery-key';

interface LoginPageProps {
  needsSetup: boolean;
  onAuthenticated: () => void;
}

export function LoginPage({ needsSetup, onAuthenticated }: LoginPageProps) {
  const [screen, setScreen] = useState<Screen>(needsSetup ? 'setup' : 'login');
  const [recoveryKey, setRecoveryKey] = useState('');
  const t = getTranslation();

  const handleAuth = (token: string, key?: string) => {
    setStoredToken(token);
    if (key) {
      setRecoveryKey(key);
      setScreen('recovery-key');
    } else {
      onAuthenticated();
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-desk p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <BrandLogo className="h-14 w-14" tone="pine" />
          <h1 className="font-narrow text-lg font-bold uppercase tracking-[0.1em] text-pine">
            {t.appName}
          </h1>
        </div>

        <div className="rounded-lg border border-rule bg-paper shadow-sm">
          {screen === 'login' && (
            <LoginForm
              t={t}
              onSuccess={handleAuth}
              onForgot={() => setScreen('reset')}
            />
          )}
          {screen === 'setup' && (
            <SetupForm t={t} onSuccess={handleAuth} />
          )}
          {screen === 'reset' && (
            <ResetForm
              t={t}
              onSuccess={handleAuth}
              onBack={() => setScreen('login')}
            />
          )}
          {screen === 'recovery-key' && (
            <RecoveryKeyDisplay
              t={t}
              recoveryKey={recoveryKey}
              onContinue={onAuthenticated}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LoginForm({
  t,
  onSuccess,
  onForgot,
}: {
  t: ReturnType<typeof getTranslation>;
  onSuccess: (token: string) => void;
  onForgot: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await authApi.login(username, password);
      onSuccess(result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de connexion.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <header className="border-b border-rule px-5 py-3.5">
        <h2 className="font-narrow text-sm font-bold uppercase tracking-[0.1em] text-pine">
          {t.authLogin}
        </h2>
      </header>
      <div className="space-y-4 px-5 py-5">
        {error && (
          <p className="rounded-md border border-seal/30 bg-seal-tint px-3 py-2 text-sm text-seal">
            {error}
          </p>
        )}
        <div className="space-y-1.5">
          <label
            htmlFor="login-user"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authUsername}
          </label>
          <input
            id="login-user"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputClass}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="login-pass"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authPassword}
          </label>
          <input
            id="login-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            autoComplete="current-password"
            required
          />
        </div>
      </div>
      <footer className="flex items-center justify-between border-t border-rule bg-desk/50 px-5 py-3.5">
        <button
          type="button"
          onClick={onForgot}
          className="text-xs text-slate transition-colors hover:text-pine"
        >
          {t.authForgotPassword}
        </button>
        <Button type="submit" variant="primary" busy={busy} icon={LogIn}>
          {busy ? t.authSigningIn : t.authSignIn}
        </Button>
      </footer>
    </form>
  );
}

function SetupForm({
  t,
  onSuccess,
}: {
  t: ReturnType<typeof getTranslation>;
  onSuccess: (token: string, recoveryKey: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError(t.authPasswordMismatch);
      return;
    }

    setBusy(true);
    try {
      const result = await authApi.setup(username, password);
      onSuccess(result.token, result.recoveryKey!);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <header className="border-b border-rule px-5 py-3.5">
        <h2 className="font-narrow text-sm font-bold uppercase tracking-[0.1em] text-pine">
          {t.authSetupTitle}
        </h2>
      </header>
      <div className="space-y-4 px-5 py-5">
        <p className="text-sm leading-relaxed text-slate">{t.authSetupHint}</p>
        {error && (
          <p className="rounded-md border border-seal/30 bg-seal-tint px-3 py-2 text-sm text-seal">
            {error}
          </p>
        )}
        <div className="space-y-1.5">
          <label
            htmlFor="setup-user"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authUsername}
          </label>
          <input
            id="setup-user"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputClass}
            autoComplete="username"
            autoFocus
            required
            minLength={2}
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="setup-pass"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authPassword}
          </label>
          <input
            id="setup-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
            required
            minLength={6}
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="setup-confirm"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authConfirmPassword}
          </label>
          <input
            id="setup-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
            required
            minLength={6}
          />
        </div>
      </div>
      <footer className="flex items-center justify-end border-t border-rule bg-desk/50 px-5 py-3.5">
        <Button type="submit" variant="primary" busy={busy} icon={ShieldCheck}>
          {busy ? t.authCreatingAccount : t.authCreateAccount}
        </Button>
      </footer>
    </form>
  );
}

function ResetForm({
  t,
  onSuccess,
  onBack,
}: {
  t: ReturnType<typeof getTranslation>;
  onSuccess: (token: string, recoveryKey: string) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState('');
  const [key, setKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError(t.authPasswordMismatch);
      return;
    }

    setBusy(true);
    try {
      const result = await authApi.resetPassword(username, key.trim(), password);
      onSuccess(result.token, result.recoveryKey!);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <header className="border-b border-rule px-5 py-3.5">
        <h2 className="font-narrow text-sm font-bold uppercase tracking-[0.1em] text-pine">
          {t.authResetTitle}
        </h2>
      </header>
      <div className="space-y-4 px-5 py-5">
        {error && (
          <p className="rounded-md border border-seal/30 bg-seal-tint px-3 py-2 text-sm text-seal">
            {error}
          </p>
        )}
        <div className="space-y-1.5">
          <label
            htmlFor="reset-user"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authUsername}
          </label>
          <input
            id="reset-user"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputClass}
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="reset-key"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authRecoveryKey}
          </label>
          <input
            id="reset-key"
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className={cx(inputClass, 'font-mono text-xs')}
            required
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="reset-pass"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authNewPassword}
          </label>
          <input
            id="reset-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
            required
            minLength={6}
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="reset-confirm"
            className="block font-narrow text-[11px] font-semibold uppercase tracking-[0.09em] text-slate"
          >
            {t.authConfirmNewPassword}
          </label>
          <input
            id="reset-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
            required
            minLength={6}
          />
        </div>
      </div>
      <footer className="flex items-center justify-between border-t border-rule bg-desk/50 px-5 py-3.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-slate transition-colors hover:text-pine"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t.authBackToLogin}
        </button>
        <Button type="submit" variant="primary" busy={busy} icon={KeyRound}>
          {busy ? t.authResetting : t.authResetPassword}
        </Button>
      </footer>
    </form>
  );
}

function RecoveryKeyDisplay({
  t,
  recoveryKey,
  onContinue,
}: {
  t: ReturnType<typeof getTranslation>;
  recoveryKey: string;
  onContinue: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  const downloadKey = () => {
    const content = [
      `Facturation — ${t.authRecoveryKeyTitle}`,
      `${'─'.repeat(60)}`,
      ``,
      `${recoveryKey}`,
      ``,
      `${'─'.repeat(60)}`,
      t.authRecoveryKeyWarning,
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'facturation-cle-de-recuperation.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setConfirmed(true);
  };

  return (
    <div>
      <header className="border-b border-rule px-5 py-3.5">
        <h2 className="font-narrow text-sm font-bold uppercase tracking-[0.1em] text-pine">
          {t.authRecoveryKeyTitle}
        </h2>
      </header>
      <div className="space-y-4 px-5 py-5">
        <p className="text-sm leading-relaxed text-slate">{t.authRecoveryKeyHint}</p>
        <div className="rounded-md border border-pine-mid/30 bg-pine-tint p-4">
          <code className="block break-all font-mono text-xs leading-relaxed text-ink">
            {recoveryKey}
          </code>
        </div>
        <p className="rounded-md border border-seal/30 bg-seal-tint px-3 py-2 text-sm font-semibold text-seal">
          {t.authRecoveryKeyWarning}
        </p>
      </div>
      <footer className="flex items-center justify-between border-t border-rule bg-desk/50 px-5 py-3.5">
        <Button variant="secondary" icon={Download} onClick={downloadKey}>
          {t.authDownloadKey}
        </Button>
        <Button variant="primary" onClick={onContinue} disabled={!confirmed}>
          {t.authKeySaved}
        </Button>
      </footer>
    </div>
  );
}
