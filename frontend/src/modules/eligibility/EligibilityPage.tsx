import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function EligibilityPage() {
  return (
    <ModulePlaceholder
      titleKey="eligibility"
      deliveredBy="Clinical eligibility (commit 6)"
      planned={[
        "Eligibility state per employee with the reasons behind it",
        "Waivers (at most 72 hours)",
      ]}
    />
  );
}
