import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function MyCredentialsPage() {
  return (
    <ModulePlaceholder
      titleKey="myCredentials"
      deliveredBy="Clinical eligibility (commit 6)"
      planned={[
        "Your own credentials and their status",
        "Upload evidence (PDF, JPEG, PNG or WebP)",
      ]}
    />
  );
}
