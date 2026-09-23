import { Alert, Card, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { TranslationKey } from '../lib/i18n';

interface Props {
  titleKey: TranslationKey;
  /** What the page will contain once its API exists (architecture plan §4). */
  planned: string[];
  /** Stage-2 commit that delivers the backend for this page. */
  deliveredBy: string;
  note?: string;
}

/**
 * Stand-in for a page whose domain API has not been built yet. V03 pages read
 * and wrote a browser-side store that enforced business rules; they are ported
 * together with the backend module that now owns those rules.
 */
export function ModulePlaceholder({ titleKey, planned, deliveredBy, note }: Props) {
  const { t } = useTranslation();
  return (
    <Card title={t(titleKey)}>
      <Alert type="info" showIcon title={t('notYetAvailable')} description={`Arrives with: ${deliveredBy}`} style={{ marginBottom: 16 }} />
      {note && <Alert type="warning" showIcon title={note} style={{ marginBottom: 16 }} />}
      <Typography.Title level={5}>{t('planned')}</Typography.Title>
      <ul>{planned.map((p) => <li key={p}>{p}</li>)}</ul>
    </Card>
  );
}
