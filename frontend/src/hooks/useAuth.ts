// Session state (Zustand, per architecture plan §4: session + UI preferences
// only — server data lives in React Query). Login waits for the server; there
// is no email-based role guessing and no offline login (V03 conflict C-9, D-1).

import { create } from 'zustand';
import { http, refreshSession, setSessionExpiredHandler, setTokens } from '../services/http';
import type { MeResponse, RoleGrant, SessionUser, TokenResponse } from '../types/api';

type Status = 'checking' | 'anonymous' | 'authenticated';

interface AuthState {
  status: Status;
  user: SessionUser | null;
  roles: RoleGrant[];
  /** Restores a session from the HttpOnly refresh cookie at startup. */
  restore: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const signedOut = { status: 'anonymous' as const, user: null, roles: [] };

export const useAuth = create<AuthState>()((set) => ({
  status: 'checking',
  user: null,
  roles: [],

  restore: async () => {
    if (!(await refreshSession())) return set(signedOut);
    try {
      const me = await http.get<MeResponse>('/auth/me');
      set({ status: 'authenticated', user: me.user, roles: me.roles });
    } catch {
      setTokens(null);
      set(signedOut);
    }
  },

  login: async (email, password) => {
    const tokens = await http.post<TokenResponse>('/auth/login', { email, password });
    setTokens(tokens);
    const me = await http.get<MeResponse>('/auth/me');
    set({ status: 'authenticated', user: me.user, roles: me.roles });
  },

  logout: async () => {
    try { await http.post('/auth/logout'); } catch { /* the local session ends regardless */ }
    setTokens(null);
    set(signedOut);
  },
}));

// A refresh that fails mid-session signs the user out locally.
setSessionExpiredHandler(() => useAuth.setState(signedOut));
