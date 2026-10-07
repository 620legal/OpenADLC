'use client';

import { useState } from 'react';
import { AppClientSecretField, InstallField, SettingsUnread, useInstallSettings, type InstallSettings, type SettingKey } from '@/components/install-settings';
import { SignedPostsInfo } from '@/components/signed-posts-info';
import { Button } from '@/components/ui/button';
import { SettingsPart } from '@/components/settings-sections';
import { SIGNED_POSTS_LINE, type SharedReviewers } from '@/lib/signed-posts';

/**
 * What every post OpenADLC writes to GitHub is headed with — a part of the GitHub card, since it is what GitHub shows.
 *
 * With one GitHub account for the whole crew, every issue, comment and review
 * is by the same user; the header — `**OpenADLC_exampleco · design agent**` — is
 * how a reader tells which install, and which stage, wrote it.
 */
export function InstallNamePart({ initial = null }: { initial?: InstallSettings | null }) {
  const { settings, error, save, reload } = useInstallSettings(initial);
  return (
    <SettingsPart
      id="install"
      title="Install name"
      line="Every post OpenADLC writes on GitHub starts with this name and the stage that wrote it."
    >
      {settings ? (
        <div className="pt-1">
          <InstallField
            settingKey="installName"
            label="Name"
            placeholder={settings.installName ?? `OpenADLC_${settings.organization || 'example'}`}
            hint={`Posts begin like this: **${settings.installName ?? 'OpenADLC'} · design agent**`}
            settings={settings}
            save={save}
          />
          {settings.attributionMode && <SignedPosts mode={settings.attributionMode} save={save} />}
          <AppClientSecretField settings={settings} save={save} />
        </div>
      ) : error ? (
        // Said, with a way to ask again: one failed read said "Reading…" for good.
        <SettingsUnread error={error} reload={reload} />
      ) : (
        <p className="text-[12px] text-muted">Reading the install’s settings…</p>
      )}
    </SettingsPart>
  );
}

/**
 * Whether OpenADLC counts only what it signed.
 *
 * The line says why a signature is there. The (i) opens what it proves, what
 * counting only signed posts changes, and the trade-offs — the same words an
 * unsigned post's steps use (`signed-posts.ts`).
 */
export function SignedPosts({
  mode,
  save,
  shared,
}: {
  mode: 'audit' | 'enforce';
  save: (key: SettingKey, value: string) => Promise<void>;
  /**
   * When the caller already knows whether reviewer seats share an account.
   * Omitted, the explanation reads it.
   */
  shared?: SharedReviewers | null;
}) {
  const [state, setState] = useState<{ working: boolean; error: string | null }>({ working: false, error: null });
  /** Turning enforcement off is asked twice: an unsigned review counts again from then on. */
  const [asking, setAsking] = useState(false);
  const next = mode === 'enforce' ? 'audit' : 'enforce';
  const change = async (): Promise<void> => {
    setAsking(false);
    setState({ working: true, error: null });
    try {
      await save('attributionMode', next);
      setState({ working: false, error: null });
    } catch (cause) {
      setState({ working: false, error: cause instanceof Error ? cause.message : 'could not change it' });
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-well pt-3 text-[12.5px]">
      <div className="flex items-center gap-1.5">
        <p className="font-medium text-body">Signed posts</p>
        <SignedPostsInfo shared={shared} />
      </div>
      <p className="text-muted">{SIGNED_POSTS_LINE}</p>
      {/* The mode is said, and the button by what it does: "Only record unsigned
          posts" turned enforcement off, after which unsigned posts count again. */}
      <p className="text-body">{mode === 'enforce' ? 'Counting only signed posts.' : 'Recording only: unsigned posts still count.'}</p>
      <div className="flex flex-wrap items-center gap-3">
        {asking ? (
          <>
            <span className="text-body">Count unsigned posts again?</span>
            <Button size="sm" variant="danger" disabled={state.working} onClick={() => void change()}>
              Yes, count unsigned posts too
            </Button>
            <Button size="sm" variant="ghost" disabled={state.working} onClick={() => setAsking(false)}>
              Not now
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant={mode === 'enforce' ? undefined : 'primary'}
            disabled={state.working}
            onClick={() => (mode === 'enforce' ? setAsking(true) : void change())}
          >
            {state.working ? 'Saving…' : mode === 'enforce' ? 'Count unsigned posts too' : 'Count only signed posts'}
          </Button>
        )}
        {state.error && <span className="text-[12px] text-alarm">{state.error}</span>}
      </div>
    </div>
  );
}
