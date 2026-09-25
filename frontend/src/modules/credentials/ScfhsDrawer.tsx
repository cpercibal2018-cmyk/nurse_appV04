// SCFHS licence checks of one credential (spec §5.4, D-64, HR): check now, and
// every earlier check — on submission, on demand, nightly — with what SCFHS
// answered and what the system did about it.

import { Alert, App, Button, Drawer, Space, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useScfhsCheckNow, useScfhsChecks, type ScfhsCheck, type ScfhsStatus } from './api';

const COLOR: Record<ScfhsStatus, string> = { VERIFIED: 'green', EXPIRED: 'orange', SUSPENDED: 'red', REVOKED: 'red', NOT_FOUND: 'gold', ERROR: 'default' };

export function ScfhsStatusTag({ status }: { status: ScfhsStatus }) {
  const { t } = useTranslation();
  return <Tag color={COLOR[status]}>{t(`scfhsStatus_${status}`)}</Tag>;
}

export function ScfhsDrawer({ credential, onClose }: { credential: { id: number; title: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const checks = useScfhsChecks(credential?.id ?? null);
  const checkNow = useScfhsCheckNow();

  async function run() {
    if (!credential) return;
    try {
      const r = await checkNow.mutateAsync(credential.id);
      const text = t(`scfhsResult_${r.action}`, { status: t(`scfhsStatus_${r.status}`) });
      if (r.status === 'ERROR') message.warning(text); else if (r.matched) message.success(text); else message.info(text);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <Drawer open={credential !== null} onClose={onClose} title={credential ? `${t('scfhsChecks')} — ${credential.title}` : ''} size="large" destroyOnHidden>
      {checks.data?.driver === 'mock' && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('scfhsMockNotice')} />}
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" loading={checkNow.isPending} onClick={run}>{t('scfhsCheckNow')}</Button>
      </Space>
      <Table<ScfhsCheck>
        rowKey="id" size="small" loading={checks.isLoading} dataSource={checks.data?.items} pagination={false} scroll={{ x: 760 }}
        columns={[
          { title: t('scfhsCheckedAt'), width: 170, render: (_, r) => new Date(r.requestedAt).toLocaleString() },
          { title: t('scfhsTrigger'), width: 120, render: (_, r) => t(`scfhsTrigger_${r.requestType}`) },
          { title: t('scfhsAnswer'), width: 150, render: (_, r) => <ScfhsStatusTag status={r.responseStatus} /> },
          {
            title: t('scfhsDetails'), width: 260, render: (_, r) => (
              <Typography.Text type={r.matched === false ? 'danger' : undefined} style={{ fontSize: 13 }}>
                {r.errorMessage ?? (r.discrepancies.length ? r.discrepancies.join('; ') : [r.scfhsExpiryDate && `${t('expiryDate')}: ${r.scfhsExpiryDate}`, r.scfhsSpecialty].filter(Boolean).join(' · ') || '—')}
              </Typography.Text>
            ),
          },
          { title: t('scfhsAction'), width: 150, render: (_, r) => (r.action === 'NONE' ? '—' : <Tag color={r.action === 'SUSPENDED' ? 'red' : 'blue'}>{t(`scfhsAction_${r.action}`)}</Tag>) },
        ]}
      />
    </Drawer>
  );
}
