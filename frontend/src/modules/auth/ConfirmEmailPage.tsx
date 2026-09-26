import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Result, Spin } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { usePreferences } from '../../hooks/usePreferences';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';

/** The token arrives after "#" so it never reaches a server log (D-67, as D-50). */
const tokenFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';

// The link from the NEW mailbox (D-67): confirms the sign-in e-mail change.
// Every session of the account is signed out, this browser's included.
export default function ConfirmEmailPage() {
  const { t } = useTranslation();
  const { language, setLanguage } = usePreferences();
  const logout = useAuth((s) => s.logout);
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'done'; email: string } | { kind: 'error'; message: string }>({ kind: 'working' });
  const ran = useRef(false); // once, also under React's development double effects

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = tokenFromHash();
    if (!token) { setState({ kind: 'error', message: t('emailConfirmNoToken') }); return; }
    http.post<{ email: string }>('/auth/email-change/confirm', { token })
      .then(async (out) => {
        await logout().catch(() => undefined); // the server already ended the sessions; clear this tab too
        setState({ kind: 'done', email: out.email });
      })
      .catch((e) => setState({ kind: 'error', message: describeApiError(e) }));
  }, [logout, t]);

  return (
    <div className="login-backdrop">
      <Card style={{ width: 440, maxWidth: '100%' }} title={t('emailConfirmTitle')}>
        {state.kind === 'working' && <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>}
        {state.kind === 'done' && (
          <Result status="success" title={t('emailConfirmDone')} subTitle={<span dir="ltr">{state.email}</span>}
            extra={<Link to="/login"><Button type="primary">{t('login')}</Button></Link>} />
        )}
        {state.kind === 'error' && (
          <>
            <Alert type="error" showIcon title={state.message} style={{ marginBottom: 16 }} />
            <Link to="/login"><Button>{t('backToLogin')}</Button></Link>
          </>
        )}
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>{language === 'en' ? 'العربية' : 'English'}</Button>
        </div>
      </Card>
    </div>
  );
}
