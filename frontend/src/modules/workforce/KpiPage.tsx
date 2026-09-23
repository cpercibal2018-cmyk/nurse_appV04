import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function KpiPage() {
  return (
    <ModulePlaceholder
      titleKey="kpi"
      deliveredBy="Workforce (commit 7)"
      note="KPI thresholds: source not in repository — verify against the MoH Ada'a card (decision D-11)."
      planned={[
        "Nursing KPI dashboard (MoH Ada'a indicators)",
      ]}
    />
  );
}
