// Job Post (City) selection (owner decision 2026-10-03): a form control showing
// "Qassim Region - Buraydah" that opens "Select Job Post Location": step 1 the region,
// step 2 a city of that region only (disabled until a region is chosen; cleared when
// the region changes), both searchable; Select is enabled once both are chosen and
// Cancel keeps the current value. Regions and cities come from the location master.

import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useCities, useRegions } from '../modules/workforce/api';

export interface JobPostValue { regionCode: string; cityId: number }

const pick = (n: { name: string; nameAr: string | null }, ar: boolean) => (ar && n.nameAr ? n.nameAr : n.name);
export const jobPostLabel = (region: { name: string; nameAr: string | null } | null, city: { name: string; nameAr: string | null } | null, ar: boolean) =>
  region && city ? `${pick(region, ar)} - ${pick(city, ar)}` : '';

export function JobPostPicker({ value, onChange, id }: { value?: JobPostValue | null; onChange?: (v: JobPostValue) => void; id?: string }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [open, setOpen] = useState(false);
  const [regionCode, setRegionCode] = useState<string | null>(null);
  const [cityId, setCityId] = useState<number | null>(null);
  // Everything (inactive too) to name the current value; only active records are offered.
  const regions = useRegions(true);
  const currentCities = useCities(value?.regionCode ?? null, true, !!value);
  const modalCities = useCities(regionCode, false, open && !!regionCode);

  const regionOf = (code: string | null | undefined) => regions.data?.items.find((r) => r.code === code) ?? null;
  const shown = value ? jobPostLabel(regionOf(value.regionCode), currentCities.data?.items.find((c) => c.id === value.cityId) ?? null, ar) : '';
  const chosenCity = modalCities.data?.items.find((c) => c.id === cityId) ?? null;
  const preview = jobPostLabel(regionOf(regionCode), chosenCity, ar);

  const show = () => { setRegionCode(value?.regionCode ?? null); setCityId(value?.cityId ?? null); setOpen(true); };
  const search = { filterOption: (input: string, o?: { label?: unknown }) => String(o?.label ?? '').toLowerCase().includes(input.trim().toLowerCase()) };

  return (
    <>
      <Space.Compact style={{ width: '100%' }}>
        <Input id={id} readOnly value={shown} placeholder={t('jobPostSelect')} onClick={show} style={{ cursor: 'pointer' }} />
        <Button icon={<SearchOutlined />} onClick={show} aria-label={t('jobPostSelectTitle')} />
      </Space.Compact>
      <Modal title={t('jobPostSelectTitle')} open={open} onCancel={() => setOpen(false)} destroyOnHidden
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>{t('cancel')}</Button>,
          <Button key="select" type="primary" disabled={!regionCode || !chosenCity}
            onClick={() => { if (regionCode && chosenCity) { onChange?.({ regionCode, cityId: chosenCity.id }); setOpen(false); } }}>{t('select')}</Button>,
        ]}>
        <Form layout="vertical" component="div">
          <Form.Item label={t('jobPostStep1')}>
            <Select<string> value={regionCode ?? undefined} placeholder={t('jobPostRegionSelect')} showSearch={search} loading={regions.isLoading}
              options={(regions.data?.items ?? []).filter((r) => r.isActive).map((r) => ({ value: r.code, label: pick(r, ar) }))}
              onChange={(code) => { if (code !== regionCode) { setRegionCode(code); setCityId(null); } }} />
          </Form.Item>
          <Form.Item label={t('jobPostStep2')}>
            <Select<number> value={cityId ?? undefined} disabled={!regionCode} placeholder={regionCode ? t('jobPostCitySelect') : t('jobPostRegionFirst')}
              showSearch={search} loading={modalCities.isFetching}
              options={(modalCities.data?.items ?? []).map((c) => ({ value: c.id, label: pick(c, ar) }))} onChange={setCityId} />
          </Form.Item>
          <Alert type={preview ? 'success' : 'info'} showIcon title={preview ? `${t('jobPostSelected')}: ${preview}` : t('jobPostChooseBoth')} />
        </Form>
      </Modal>
    </>
  );
}
