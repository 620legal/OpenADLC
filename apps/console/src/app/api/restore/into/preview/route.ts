import { forwardRestore } from '@/lib/restore-body';

/** Opens a backup and lays it beside this install, thing by thing, with each sign-in checked. Writes nothing. */
export async function POST(request: Request) {
  return forwardRestore(request, '/v1/restore/into/preview');
}
