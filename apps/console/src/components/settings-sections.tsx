import type { ReactNode } from 'react';
import { CrewColors, RepositoryColors } from '@/components/color-choice';
import { ThemeToggle } from '@/components/theme-toggle';
import type { CrewMember } from '@/lib/api';

/** One section of settings, as a card with its heading and a line saying what it is. */
export function SettingsCard({
  id,
  title,
  line,
  action,
  children,
}: {
  id?: string;
  title: string;
  line?: string;
  /** A link beside the heading. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const heading = `${id ?? title.toLowerCase().replace(/\W+/g, '-')}-title`;
  return (
    <section
      id={id}
      aria-labelledby={heading}
      className="flex scroll-mt-7 flex-col gap-1 rounded-[10px] border border-edge bg-panel px-5 py-[18px]"
    >
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 id={heading} className="text-[13.5px] font-semibold text-body">
          {title}
        </h2>
        {line && <span className="text-[12.5px] text-muted">{line}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * A part of a settings card, with a heading of its own and an id a link can
 * land on: how the GitHub card keeps the app, the install name and the
 * connected accounts in one section while `#github-app`, `#install` and
 * `#github-accounts` still reach each of them.
 */
export function SettingsPart({
  id,
  title,
  line,
  action,
  children,
}: {
  id: string;
  title: string;
  line?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} role="group" aria-labelledby={`${id}-title`} className="flex scroll-mt-7 flex-col border-t border-well pt-3.5 first:border-t-0 first:pt-0 [&:not(:first-child)]:mt-3">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h3 id={`${id}-title`} className="text-[13px] font-semibold text-body">
          {title}
        </h3>
        {line && <span className="text-[12.5px] text-muted">{line}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * How the console looks: its color mode, each repository's color and each
 * crew member's. The two lists are the place to change every color at once;
 * a repository's own page offers its color too. A page that has neither list
 * to give, onboarding or a bridge that did not answer, shows the mode alone.
 */
export function AppearanceSection({
  repositories,
  crew,
}: {
  repositories?: readonly { name: string; color?: string | null }[];
  crew?: readonly CrewMember[];
} = {}) {
  return (
    <SettingsCard id="appearance" title="Appearance">
      <div className="flex flex-wrap items-center gap-3 border-t border-well pb-0.5 pt-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-body">Color mode</span>
          <span className="text-[12px] text-muted">System follows your computer’s setting, and changes when it does.</span>
        </div>
        <ThemeToggle />
      </div>
      {repositories && (
        <SettingsPart id="repository-colors" title="Repository colors" line="How the board tells repositories apart, always beside the name.">
          <RepositoryColors repositories={repositories} />
        </SettingsPart>
      )}
      {crew && (
        <SettingsPart id="crew-colors" title="Crew colors and avatars" line="Each avatar’s color, by role, and its mark, by engine, unless you choose.">
          <CrewColors crew={crew} />
        </SettingsPart>
      )}
    </SettingsCard>
  );
}
