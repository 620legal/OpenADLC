import { AppShell } from '@/components/app-header';
import { BridgeDown } from '@/components/bridge-down';
import { api } from '@/lib/api';
import { readHeader } from '@/lib/read-header';
import { RoutinesList } from './routines-list';

export const dynamic = 'force-dynamic';

/**
 * Routines (#369, docs/adr/0090): console requests that file themselves on
 * a schedule, as the approver who last set them. Anyone may watch them;
 * creating, editing, pausing, resuming and deleting one takes Approves on in
 * People, which the bridge checks and the page follows by drawing no
 * controls for anyone else.
 */
export default async function RoutinesPage() {
  let read;
  try {
    const [view, header] = await Promise.all([api.routines(), readHeader()]);
    read = { view, header };
  } catch (error) {
    return <BridgeDown error={error} />;
  }
  const { view, header } = read;

  return (
    <AppShell page="routines" data={header}>
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 md:px-6 md:py-7">
        <h1 className="text-[16px] font-semibold text-body">Routines</h1>
        <p className="text-[12.5px] text-soft">
          Requests that file themselves on a schedule: each time one runs, it sends its request to intake as the person who last set it. A run is skipped while its last request is
          still open, while work is paused, while the monthly cap is reached, or once that person no longer has Approves on.
        </p>
        <RoutinesList view={view} repos={header.repos} />
      </main>
    </AppShell>
  );
}
