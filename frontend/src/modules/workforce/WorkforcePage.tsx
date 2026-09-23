import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function WorkforcePage() {
  return (
    <ModulePlaceholder
      titleKey="workforce"
      deliveredBy="Workforce (commit 7)"
      planned={[
        "Departments",
        "Units with the bed-capacity grid and CSV import",
        "Positions and position assignment",
        "Coverage targets (minimum staff per unit and shift)",
      ]}
    />
  );
}
