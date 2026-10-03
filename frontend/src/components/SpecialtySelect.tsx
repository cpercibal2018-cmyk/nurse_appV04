// Nursing Specialty dropdown (owner decision 2026-10-03): the active records of the
// Nursing Specialty master, in the master's sort order (not alphabetical), searchable
// by code, name, Arabic name or description. The value is the code. A specialty the
// employee already holds stays shown even after it is deactivated.

import { useMemo } from 'react';
import { Select, type SelectProps } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSpecialties } from '../modules/workforce/api';

export function specialtyLabel(s: { name: string; nameAr?: string | null }, ar: boolean) {
  return ar && s.nameAr ? s.nameAr : s.name;
}

export function SpecialtySelect(props: Omit<SelectProps<string>, 'options' | 'showSearch'>) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const list = useSpecialties(true);
  const options = useMemo(() => (list.data?.items ?? [])
    .filter((s) => s.isActive || s.code === props.value)
    .map((s) => ({
      value: s.code, label: s.isActive ? specialtyLabel(s, ar) : `${specialtyLabel(s, ar)} (${t('inactive')})`,
      search: `${s.code} ${s.name} ${s.nameAr ?? ''} ${s.description ?? ''}`.toLowerCase(),
    })), [list.data, ar, props.value, t]);
  return (
    <Select<string> placeholder={t('specialtySelect')} loading={list.isLoading} options={options}
      showSearch={{ filterOption: (input, o) => (o?.search ?? '').includes(input.trim().toLowerCase()) }} {...props} />
  );
}
