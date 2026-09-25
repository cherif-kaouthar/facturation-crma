import React, { useCallback, useEffect, useState } from 'react';
import { authApi, getStoredToken, setStoredToken } from '../lib/api';
import { getTranslation } from '../lib/i18n';
import { LoginPage } from './LoginPage';
import { Spinner } from './ui';
import App from '../App';

type AuthState = 'checking' | 'needs-setup' | 'needs-login' | 'authenticated';

export function AuthGate() {
  const [state, setState] = useState<AuthState>('checking');
  const t = getTranslation();

  const checkAuth = useCallback(async () => {
    try {
      const { needsSetup } = await authApi.status();
      if (needsSetup) {
        setStoredToken(null);
        setState('needs-setup');
        return;
      }
      const token = getStoredToken();
      if (!token) {
        setState('needs-login');
        return;
      }
      setState('authenticated');
    } catch {
      const token = getStoredToken();
      if (token) {
        setState('authenticated');
      } else {
        setState('needs-login');
      }
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    const handler = () => setState('needs-login');
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  if (state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-desk">
        <Spinner label={t.loading} />
      </div>
    );
  }

  if (state === 'needs-setup' || state === 'needs-login') {
    return (
      <LoginPage
        needsSetup={state === 'needs-setup'}
        onAuthenticated={() => setState('authenticated')}
      />
    );
  }

  return <App onLogout={() => { setStoredToken(null); setState('needs-login'); }} />;
}
