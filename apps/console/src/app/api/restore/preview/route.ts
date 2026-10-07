import { forwardRestore } from '@/lib/restore-body';

/** Opens a backup and says what it holds and what a restore would set up. Writes nothing. */
export async function POST(request: Request) {
  return forwardRestore(request, '/v1/restore/preview');
}
