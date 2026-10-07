import { BoardView } from '@/components/board-view';
import { BridgeDown } from '@/components/bridge-down';
import { redirect } from 'next/navigation';
import { api, BRIDGE_URL, waitingCount } from '@/lib/api';
import { headerData } from '@/lib/header';
import { colorMapOf } from '@/lib/repo-colors';
import { identityHeaders } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string; bot?: string; item?: string; role?: string; board?: string }>;
}) {
  // `?item=` is what a notification about a piece of work links to, and
  // `?bot=` what one about a bot does: each opens what it names rather than
  // landing a person on the board to find it themselves.
  const { repo = 'all', bot, item, role, board: forceBoard } = await searchParams;

  // A board with no connected crew shows empty columns and a row of idle bots,
  // which looks like a broken product rather than an unfinished setup. Until
  // something can reach GitHub, the useful page is the one that gets you there.
  //
  // `?board=1` is the way past it, and is what onboarding's own "back to the
  // board" link uses — otherwise that link would bounce straight back here.
  //
  // Asked of `/v1/onboarding/complete`, not the walkthrough: this runs on every
  // refresh of an open board, and building the walkthrough asks GitHub about
  // every bot in every repository.
  if (!forceBoard) {
    const onboarding = await fetch(`${BRIDGE_URL}/v1/onboarding/complete`, {
      cache: 'no-store',
      headers: await identityHeaders(),
    })
      .then((response) => (response.ok ? (response.json() as Promise<{ complete?: boolean }>) : null))
      .catch(() => null);

    // Only on a clear answer. A bridge that cannot be reached is a different
    // problem, and redirecting on it would hide the board behind an error.
    if (onboarding?.complete === false) redirect('/onboarding');
  }

  try {
    // The costs and what needs you are the header's; a bridge that cannot
    // answer one of them still gets a board, with that part left out.
    const [board, crew, costs, attention, paused] = await Promise.all([
      api.board(repo),
      api.crew(),
      api.costs().catch(() => null),
      api.attention().then((body) => body.items).catch(() => null),
      api.workPauses().catch(() => null),
    ]);

    // Only an empty board files its first request, and only it needs to know
    // where on GitHub that would go.
    const empty = board.columns.every((column) => column.cards.length === 0);
    const repos = empty ? await api.repos().then((body) => body.repos).catch(() => []) : [];
    const target = repo !== 'all' ? repos.find((one) => one.name === repo) : repos.length === 1 ? repos[0] : undefined;

    return (
      <BoardView
        board={board}
        crew={crew.bots}
        repo={repo}
        header={headerData({
          repos: board.repos,
          repoColors: colorMapOf(board.repositories ?? []),
          crew: crew.bots,
          budget: costs?.budget ?? null,
          needsYou: attention ? waitingCount(attention) : null,
          attention,
        })}
        attention={attention ?? []}
        now={new Date().toISOString()}
        repoFullName={target?.fullName ?? null}
        openBotOnLoad={bot ?? null}
        openItemOnLoad={item ?? null}
        openRoleOnLoad={role ?? null}
        paused={paused?.paused ?? null}
        pausedRepos={paused?.repos ?? {}}
        dispatching={paused?.dispatching !== false}
      />
    );
  } catch (error) {
    return <BridgeDown error={error} />;
  }
}
