// Session state (Zustand, per architecture plan §4: session + UI preferences
// only — server data lives in React Query). Login waits for the server; there
// is no email-based role guessing and no offline login (V03 conflict C-9, D-1).

import { create } from 'zustand';
import { http, refreshSession, setSessionExpiredHandler, setTokens } from '../services/http';
import { queryClient } from '../services/queryClient';
import type { EffectiveRole, MeResponse, MfaPrompt, RoleGrant, SessionUser, TokenResponse } from '../types/api';

type Status = 'checking' | 'anonymous' | 'authenticated';

interface AuthState {
  status: Status;
  user: SessionUser | null;
  roles: RoleGrant[];
  effectiveRoles: EffectiveRole[];
  pam: MeResponse['pam'];
  breakGlass: MeResponse['breakGlass'];
  /** Re-reads /auth/me (after PAM elevation, a role change, …). */
  reload: () => Promise<void>;
  /** Restores a session from the HttpOnly refresh cookie at startup. */
  restore: () => Promise<void>;
  /** Resolves to the second step when one is due (spec §3.5), else null once signed in. */
  login: (email: string, password: string) => Promise<MfaPrompt['mfa'] | null>;
  /** Starts the session from tokens the server issued (after the second step). */
  completeLogin: (tokens: TokenResponse) => Promise<void>;
  logout: () => Promise<void>;
  /** Local teardown after server-side invalidation (e.g. a password change). */
  endLocalSession: () => void;
}

const signedOut = { status: 'anonymous' as const, user: null, roles: [], effectiveRoles: [], pam: null, breakGlass: null };
const fromMe = (me: MeResponse) => ({
  status: 'authenticated' as const, user: me.user, roles: me.roles, effectiveRoles: me.effectiveRoles, pam: me.pam, breakGlass: me.breakGlass,
});

function discardSession() {
  // Cancel in-flight reads and discard every identity-bound result before
  // another account can reuse an unscoped React Query key in the same tab.
  setTokens(null);
  queryClient.clear();
  useAuth.setState(signedOut);
}

export const useAuth = create<AuthState>()((set) => ({
  status: 'checking',
  user: null,
  roles: [],
  effectiveRoles: [],
  pam: null,
  breakGlass: null,

  reload: async () => {
    const me = await http.get<MeResponse>('/auth/me');
    queryClient.clear(); // scope/PAM may have changed while this session was active
    set(fromMe(me));
  },

  restore: async () => {
    if (!(await refreshSession())) return discardSession();
    try {
      const me = await http.get<MeResponse>('/auth/me');
      queryClient.clear();
      set(fromMe(me));
    } catch {
      discardSession();
    }
  },

  login: async (email, password) => {
    const out = await http.post<TokenResponse | MfaPrompt>('/auth/login', { email, password });
    if ('mfa' in out) return out.mfa;
    await useAuth.getState().completeLogin(out);
    return null;
  },

  completeLogin: async (tokens) => {
    setTokens(tokens);
    try {
      const me = await http.get<MeResponse>('/auth/me');
      queryClient.clear();
      set(fromMe(me));
    } catch (err) {
      discardSession();
      throw err;
    }
  },

  logout: async () => {
    try { await http.post('/auth/logout'); } catch { /* the local session ends regardless */ }
    discardSession();
  },
  endLocalSession: discardSession,
}));

// A refresh that fails mid-session must also discard protected server data.
setSessionExpiredHandler(discardSession);
