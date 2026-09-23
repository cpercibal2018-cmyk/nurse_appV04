import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../services/queryClient';
import { http, setSessionExpiredHandler, setTokens } from '../services/http';
import type { MeResponse } from '../types/api';
import { useAuth } from './useAuth';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

const me = (id: number): MeResponse => ({
  user: { id, email: `user${id}@test.sa`, displayName: `User ${id}`, employeeId: id, isBreakGlass: false },
  roles: [], effectiveRoles: ['EMPLOYEE'], pam: null, breakGlass: null,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setSessionExpiredHandler(() => useAuth.getState().endLocalSession());
  useAuth.getState().endLocalSession();
});
afterEach(() => { queryClient.clear(); vi.unstubAllGlobals(); });

describe('session boundaries and protected query data', () => {
  it('discards the old account cache when a refresh fails mid-session', async () => {
    useAuth.setState({ status: 'authenticated', user: me(1).user });
    setTokens({ token: 'old', csrfToken: 'old-csrf' });
    queryClient.setQueryData(['my-credentials'], { employeeId: 1, documents: ['private.pdf'] });
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'REFRESH_INVALID', message: 'no' } }));

    await expect(http.get('/credentials/me')).rejects.toMatchObject({ status: 401 });
    expect(useAuth.getState().status).toBe('anonymous');
    expect(queryClient.getQueryData(['my-credentials'])).toBeUndefined();
  });

  it('clears a previous user cache on login even when the old session ended unexpectedly', async () => {
    queryClient.setQueryData(['my-credentials'], { employeeId: 1, documents: ['private.pdf'] });
    fetchMock
      .mockResolvedValueOnce(json(200, { token: 'new', csrfToken: 'new-csrf', expiresIn: 900 }))
      .mockResolvedValueOnce(json(200, me(2)));

    await useAuth.getState().login('user2@test.sa', 'password');
    expect(useAuth.getState().user?.id).toBe(2);
    expect(queryClient.getQueryData(['my-credentials'])).toBeUndefined();
  });

  it('discards cached data on logout even when the logout request fails', async () => {
    useAuth.setState({ status: 'authenticated', user: me(1).user });
    queryClient.setQueryData(['accounts'], { items: [me(1).user] });
    fetchMock.mockRejectedValueOnce(new TypeError('network failure'));

    await useAuth.getState().logout();
    expect(useAuth.getState().status).toBe('anonymous');
    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
  });

  it('clears privileged data after a PAM/scope reload', async () => {
    useAuth.setState({ status: 'authenticated', user: me(1).user });
    queryClient.setQueryData(['accounts'], { sensitive: 'prior privileges' });
    fetchMock.mockResolvedValueOnce(json(200, me(1)));

    await useAuth.getState().reload();
    expect(useAuth.getState().status).toBe('authenticated');
    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
  });
});
