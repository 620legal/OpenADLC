import { forwardRoutine } from './forward';

export const dynamic = 'force-dynamic';

/** Every routine and whether the caller may change them, as the page reads it again after a change. */
export async function GET(request: Request) {
  return forwardRoutine(request, 'GET', '');
}

/** Creates a routine; the caller becomes its owner. */
export async function POST(request: Request) {
  return forwardRoutine(request, 'POST', '');
}
