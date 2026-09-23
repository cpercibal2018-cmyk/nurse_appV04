import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function ContractsPage() {
  return (
    <ModulePlaceholder
      titleKey="contracts"
      deliveredBy="Workforce (commit 7)"
      planned={[
        "Create and renew contracts (no overlapping Approved/Active periods)",
        "Status transitions: Draft, Approved, Active, Suspended, Terminated, Expired, Superseded",
        "Contract copy upload (PDF only, decision C-17)",
      ]}
    />
  );
}
