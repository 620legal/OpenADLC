import { forwardRoutine, routinePath } from '../../forward';

export const dynamic = 'force-dynamic';

/** Resumes a paused routine from its next slot after now. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return forwardRoutine(request, 'POST', `${routinePath((await params).id)}/resume`);
}
