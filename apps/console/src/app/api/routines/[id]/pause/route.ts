import { forwardRoutine, routinePath } from '../../forward';

export const dynamic = 'force-dynamic';

/** Pauses a routine: it keeps everything and fires no more until resumed. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return forwardRoutine(request, 'POST', `${routinePath((await params).id)}/pause`);
}
