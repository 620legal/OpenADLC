/**
 * How many GitHub calls one check has in flight at once. One at a time, a
 * check that asks per seat and per repository passed its time limit at about
 * twenty-five repositories, and from then on never answered; all at once, an
 * install with many repositories would spend GitHub's rate limit in a burst.
 */
export const GITHUB_CALLS_AT_ONCE = 6;

/**
 * The time limit of a check that asks GitHub per repository: the registry's
 * minute is for one answer, and these give one per repository.
 */
export const SLOW_CHECK_MS = 3 * 60_000;

/**
 * `items.map(fn)` with no more than `limit` calls running at once. The answers
 * come back in the order of `items`, whatever order the calls finish in.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      answers[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return answers;
}
