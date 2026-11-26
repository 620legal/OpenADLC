import { forwardRoutine, routinePath } from '../forward';

export const dynamic = 'force-dynamic';

/** Edits a routine; the caller becomes its owner. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return forwardRoutine(request, 'PATCH', routinePath((await params).id));
}

/** Deletes a routine; the requests it filed stay. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return forwardRoutine(request, 'DELETE', routinePath((await params).id));
}
