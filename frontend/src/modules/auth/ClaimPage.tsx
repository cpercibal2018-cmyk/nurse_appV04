import { useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Form, Input, Result } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { usePreferences } from '../../hooks/usePreferences';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';

interface Preview { fullName: string; jobNumber: string; unit: string | null; unitAr: string | null; position: string; positionAr: string | null; emailHint: string; expiresAt: string }

/** The invitation token arrives after "#" so it never reaches a server log (spec §3.2). */
const tokenFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';

// Registration by invitation (spec §3.2): Job Number → own details → e-mail and password.
export default function ClaimPage() {
  const { t } = useTranslation();
  const { language, setLanguage } = usePreferences();
  const [token, setToken] = useState(tokenFromHash);
  const [jobNumber, setJobNumber] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A second invitation link opened in the same tab changes only the "#" part: start over with it.
  useEffect(() => {
    const onHash = () => { setToken(tokenFromHash()); setPreview(null); setDone(false); setError(null); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  async function attempt(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(describeApiError(e)); } finally { setBusy(false); }
  }

  const ar = language === 'ar';
  return (
    <div className="login-backdrop">
      <Card style={{ width: 480, maxWidth: '100%' }} title={t('claimTitle')}>
        {!token ? <Alert type="error" showIcon title={t('claimNoToken')} />
          : done ? (
            <Result status="success" title={t('claimDone')} extra={<Link to="/login"><Button type="primary">{t('login')}</Button></Link>} />
          ) : (
            <>
              {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
              {!preview ? (
                <Form layout="vertical" requiredMark={false} onFinish={(v: { jobNumber: string }) => attempt(async () => {
                  setPreview(await http.post<Preview>('/auth/invitations/preview', { token, jobNumber: v.jobNumber }));
                  setJobNumber(v.jobNumber);
                })}>
                  <p>{t('claimIntro')}</p>
                  <Form.Item name="jobNumber" label={t('jobNumber')} rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item>
                  <Button type="primary" htmlType="submit" block loading={busy}>{t('claimContinue')}</Button>
                </Form>
              ) : (
                <Form layout="vertical" requiredMark={false} onFinish={(v: { email: string; password: string }) => attempt(async () => {
                  await http.post('/auth/invitations/claim', { token, jobNumber, email: v.email.trim(), password: v.password });
                  setDone(true);
                })}>
                  <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }} items={[
                    { key: 'n', label: t('name'), children: preview.fullName },
                    { key: 'j', label: t('jobNumber'), children: preview.jobNumber },
                    { key: 'u', label: t('unit'), children: (ar ? preview.unitAr : null) ?? preview.unit ?? '—' },
                    { key: 'p', label: t('position'), children: (ar ? preview.positionAr : null) ?? preview.position },
                  ]} />
                  <p>{t('claimNotYou')}</p>
                  <Form.Item name="email" label={t('email')} extra={t('claimEmailHint', { hint: preview.emailHint })} rules={[{ required: true, type: 'email' }]}>
                    <Input autoComplete="username" inputMode="email" />
                  </Form.Item>
                  <Form.Item name="password" label={t('newPassword')} rules={[{ required: true, min: 12, max: 72, message: t('passwordLength') }]}>
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Form.Item name="confirm" label={t('confirmPassword')} dependencies={['password']} rules={[{ required: true }, ({ getFieldValue }) => ({
                    validator: (_, value) => (value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error(t('passwordsDiffer')))),
                  })]}>
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block loading={busy}>{t('claimCreate')}</Button>
                </Form>
              )}
            </>
          )}
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>{language === 'en' ? 'العربية' : 'English'}</Button>
        </div>
      </Card>
    </div>
  );
}
