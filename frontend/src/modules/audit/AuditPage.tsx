import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function AuditPage() {
  return (
    <ModulePlaceholder
      titleKey="audit"
      deliveredBy="Notifications and audit (commit 9)"
      planned={[
        "Search the audit trail",
        "Verify the hash chain and list any breaks",
      ]}
    />
  );
}
