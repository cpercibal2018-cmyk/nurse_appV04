import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function NursesPage() {
  return (
    <ModulePlaceholder
      titleKey="nurses"
      deliveredBy="Workforce (commit 7)"
      planned={[
        "Employee list with search and filters",
        "Onboarding: employee record + Draft contract + audit entry in one transaction (decision D-3)",
        "Employee detail and edit (full name is derived from first, middle and last name)",
      ]}
    />
  );
}
