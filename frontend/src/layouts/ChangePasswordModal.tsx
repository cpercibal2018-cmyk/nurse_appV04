import { App, Form, Input, Modal } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { describeApiError } from '../lib/errors';
import { http, setTokens } from '../services/http';

interface Values { currentPassword: string; newPassword: string; confirm: string }

/** Spec §3.3: verifies the current password; the server then ends every session, so we sign out. */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit() {
    const v = await form.validateFields();
    try {
      await http.post('/auth/password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
      message.success(t('passwordChanged'), 6);
      setTokens(null);
      useAuth.setState({ status: 'anonymous', user: null, roles: [], effectiveRoles: [], pam: null, breakGlass: null });
      queryClient.clear();
      navigate('/login', { replace: true });
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <Modal title={t('changePassword')} open={open} onCancel={onClose} onOk={submit} okText={t('submit')} cancelText={t('cancel')} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Form.Item name="currentPassword" label={t('currentPassword')} rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="newPassword" label={t('newPassword')} extra={t('passwordRule')} rules={[{ required: true, min: 12, max: 72 }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label={t('newPassword')}
          dependencies={['newPassword']}
          rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, v) => (v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('≠'))) })]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
