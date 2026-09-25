// Shared pieces of the data-subject request views (employee and HR).

import { Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { DataSubjectRequest, DsrStatus } from '../../types/api';

const COLOR: Record<DsrStatus, string> = { RECEIVED: 'blue', IN_REVIEW: 'gold', APPROVED: 'cyan', REJECTED: 'red', COMPLETED: 'green' };

export function DsrStatusTag({ r }: { r: DataSubjectRequest }) {
  const { t } = useTranslation();
  return (
    <>
      <Tag color={COLOR[r.status]}>{t(`dsrStatus_${r.status}`)}</Tag>
      {r.overdue && <Tag color="red">{t('dsrOverdue')}</Tag>}
    </>
  );
}

/** The evidence an erasure leaves (spec §8.3.3 "scope of erasure"). */
export function ErasureEvidence({ e }: { e: NonNullable<DataSubjectRequest['erasure']> }) {
  const { t } = useTranslation();
  return (
    <Typography.Text type="secondary">
      {t('dsrErasureEvidence', {
        destroyed: new Date(e.keyDestroyedAt).toLocaleString(),
        backups: new Date(e.backupsExpireAt).toLocaleDateString(),
        documents: e.documentsErased,
      })}
    </Typography.Text>
  );
}
