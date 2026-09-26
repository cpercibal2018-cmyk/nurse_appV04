// Telegram for the signed-in account (D-66): connected or not, a new link to
// connect, and disconnect. Messages carry no personal data — only a prompt to
// open the application — which the card says.

import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Modal, Popconfirm, Space, Tag } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../../lib/errors';
import { http } from '../../../services/http';
import type { TelegramLinkOffer as Offer, TelegramStatus } from '../../../types/api';
import { TelegramLinkOffer } from './TelegramLinkOffer';

export function TelegramCard() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  // The link on show, and when the account was linked as it was issued (null = not linked).
  const [shown, setShown] = useState<{ offer: Offer; linkedAtBefore: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // While a link is shown, watch for the chat to connect.
  const status = useQuery({ queryKey: ['me', 'telegram'], queryFn: () => http.get<TelegramStatus>('/me/telegram'), refetchInterval: shown ? 3000 : false });
  const s = status.data;

  // Connected (or reconnected to another chat): linkedAt changed since the link was issued.
  useEffect(() => {
    if (shown && s?.linkedAt && s.linkedAt !== shown.linkedAtBefore) {
      setShown(null);
      message.success(t('telegramConnected'));
    }
  }, [shown, s?.linkedAt, message, t]);

  async function connect() {
    setBusy(true);
    try {
      const offer = await http.post<Offer>('/me/telegram/link');
      setShown({ offer, linkedAtBefore: s?.linkedAt ?? null });
    } catch (e) {
      message.error(describeApiError(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    try {
      await http.delete('/me/telegram');
      message.success(t('saved'));
      await qc.invalidateQueries({ queryKey: ['me', 'telegram'] });
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  if (s && !s.available) return null;
  return (
    <Card title={t('telegram')} loading={status.isLoading} style={{ marginTop: 16 }}>
      {s && (
        <>
          <Alert type="info" showIcon title={t('telegramWhat')} style={{ marginBottom: 12 }} />
          <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('status')}>
              <Tag color={s.linked ? 'green' : 'default'}>{s.linked ? t('telegramLinked') : t('telegramNotLinked')}</Tag>
              {s.driver === 'mock' && <Tag>{t('telegramSimulated')}</Tag>}
            </Descriptions.Item>
            {s.linkedAt && <Descriptions.Item label={t('telegramSince')}>{new Date(s.linkedAt).toLocaleString()}</Descriptions.Item>}
          </Descriptions>
          <Space wrap>
            <Button type={s.linked ? 'default' : 'primary'} loading={busy} onClick={() => void connect()}>{s.linked ? t('telegramReconnect') : t('telegramConnect')}</Button>
            {s.linked && (
              <Popconfirm title={t('telegramDisconnect')} onConfirm={() => void disconnect()}>
                <Button danger>{t('telegramDisconnect')}</Button>
              </Popconfirm>
            )}
          </Space>
        </>
      )}
      <Modal open={shown !== null} footer={null} title={t('telegramConnect')} onCancel={() => setShown(null)} destroyOnHidden>
        {shown && <TelegramLinkOffer offer={shown.offer} />}
      </Modal>
    </Card>
  );
}
