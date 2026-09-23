import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function SchedulingPage() {
  return (
    <ModulePlaceholder
      titleKey="scheduling"
      deliveredBy="Scheduling and attendance (commit 8)"
      planned={[
        "Week and month roster board",
        "Float pool",
        "Auto-generate a draft roster (dry run by default)",
        "Publish a roster",
        "Coverage against targets",
      ]}
    />
  );
}
