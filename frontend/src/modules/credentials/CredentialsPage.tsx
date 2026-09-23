import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function CredentialsPage() {
  return (
    <ModulePlaceholder
      titleKey="credentials"
      deliveredBy="Clinical eligibility (commit 6)"
      planned={[
        "Credential catalog: categories and templates",
        "Requirements by unit, optionally narrowed by position",
        "Credential records per employee",
        "Verification queue",
      ]}
    />
  );
}
