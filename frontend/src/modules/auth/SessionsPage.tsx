// Own sign-in history (spec §3.3; decision D-22). Only the caller's sessions.

import { Alert, Card, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSessions, type SessionRow } from '../audit/api';

export default function SessionsPage() {
  const { t } = useTranslation();
  const sessions = useSessions();
  return (
    <Card title={t('signInHistory')}>
      <Alert type="info" showIcon title={t('signInHistoryHint')} style={{ marginBottom: 12 }} />
      <Table<SessionRow>
        rowKey="signedInAt" size="small" loading={sessions.isLoading} dataSource={sessions.data?.items} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('signedIn'), render: (_, s) => new Date(s.signedInAt).toLocaleString() },
          { title: t('lastActive'), render: (_, s) => new Date(s.lastActiveAt).toLocaleString() },
          { title: t('address'), render: (_, s) => s.lastIp && s.lastIp !== s.signInIp ? `${s.signInIp} → ${s.lastIp}` : s.signInIp ?? '—' },
          { title: t('browser'), render: (_, s) => <span style={{ fontSize: 12 }}>{s.lastUserAgent ?? s.signInUserAgent ?? '—'}</span> },
          { title: t('status'), render: (_, s) => <>{s.current && <Tag color="blue">{t('thisSession')}</Tag>}<Tag color={s.active ? 'green' : 'default'}>{s.active ? t('active') : t('ended')}</Tag></> },
        ]}
      />
    </Card>
  );
}
