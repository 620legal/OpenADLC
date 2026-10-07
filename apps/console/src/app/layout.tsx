import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RoleProvider } from '../components/app-header';
import { EarlyClicks } from '../components/early-clicks';
import { NoAdmin, NotAUser } from '../components/not-a-user';
import { readMe } from '../lib/api';
import { EARLY_CLICKS_SCRIPT } from '../lib/early-clicks';
import { THEME_SCRIPT } from '../lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenADLC console',
  description:
    'A crew of agents that takes a request to a reviewed, deployed change. GitHub is the system of record.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Who is looking, once per page: a role picks which controls are drawn, and
  // someone the install does not know gets the one page they can use. The
  // bridge refuses them either way; this is what they see instead of a board
  // of errors. A bridge that did not answer leaves each page to say so.
  const me = await readMe();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Before first paint, and before any bundle has loaded. The onboarding
          page is server-rendered on purpose, so applying the mode from an effect
          would paint the default first — a white flash on a dark desktop, or the
          reverse, on every cold load.

          `suppressHydrationWarning` above is because this script writes an
          attribute onto <html> that the server did not render. That is the
          point: the server cannot know what is in this browser's storage.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/*
          Also before any bundle: a button pressed while the page is drawn but
          React has not started is noted, and <EarlyClicks /> presses it once
          it can answer. Without it that first click did nothing at all.
        */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_CLICKS_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        {me && !me.known ? (
          me.noAdmin ? <NoAdmin email={me.email} /> : <NotAUser email={me.email} admins={me.admins} />
        ) : (
          <RoleProvider role={me?.role ?? 'admin'}>{children}</RoleProvider>
        )}
        <EarlyClicks />
      </body>
    </html>
  );
}
