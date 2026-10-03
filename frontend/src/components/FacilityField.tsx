// Actual Work Place / Facility (owner decision 2026-10-03): a searchable dropdown of the
// active facilities, with Manage Facilities beside it for hospital-wide administrators.
// Managing opens a window over the form, so what was typed in the form stays. A facility
// added there is selected at once; if the facility chosen (and not yet saved) is deleted
// or deactivated there, the choice is cleared and the user is asked to pick another.
// A saved facility that has since been deactivated still shows on that employee.

import { useMemo, useState } from 'react';
import { App, Button, Modal, Select, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import { FacilitiesManager } from '../modules/workforce/FacilitiesManager';
import { useFacilities } from '../modules/workforce/api';

export const facilityLabel = (f: { name: string; nameAr: string | null }, ar: boolean) => (ar && f.nameAr ? f.nameAr : f.name);

export function FacilityField({ value, onChange, id, savedId, canManage }: {
  value?: number | null; onChange?: (id: number | undefined) => void; id?: string; savedId?: number | null; canManage: boolean;
}) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const { message } = App.useApp();
  const [managing, setManaging] = useState(false);
  const list = useFacilities(true);
  const options = useMemo(() => (list.data?.items ?? [])
    .filter((f) => f.isActive || f.id === value)
    .map((f) => ({ value: f.id, label: f.isActive ? facilityLabel(f, ar) : `${facilityLabel(f, ar)} (${t('inactive')})` })), [list.data, value, ar, t]);

  return (
    <>
      <Space.Compact style={{ width: '100%' }}>
        <Select<number> id={id} value={value ?? undefined} onChange={(v) => onChange?.(v)} placeholder={t('facilitySelect')} loading={list.isLoading}
          options={options} showSearch={{ optionFilterProp: 'label' }} style={{ width: '100%' }} />
        {canManage && <Button onClick={() => setManaging(true)}>{t('manageFacilities')}</Button>}
      </Space.Compact>
      <Modal title={t('manageFacilities')} open={managing} onCancel={() => setManaging(false)} footer={<Button onClick={() => setManaging(false)}>{t('close')}</Button>}
        width={820} destroyOnHidden>
        <FacilitiesManager canWrite={canManage}
          onCreated={(f) => { onChange?.(f.id); setManaging(false); }}
          onWithdrawn={(gone) => {
            if (gone === value && value !== savedId) { onChange?.(undefined); message.warning(t('facilityChooseAnother')); }
          }} />
      </Modal>
    </>
  );
}
