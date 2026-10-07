import type { ReactNode } from 'react';

/**
 * The line icons the console draws, at the stroke the design uses. Inline
 * rather than a package: there are a score of them, and each is a path or two.
 *
 * Several reproduce Lucide icons (https://lucide.dev, ISC License): ExternalIcon,
 * CheckIcon, QuestionIcon, CrewIcon, CostsIcon, CloseIcon, ComputerIcon,
 * TerminalIcon, PlusIcon and ChevronDownIcon. SettingsIcon, ShipIcon and
 * WarningIcon reproduce Feather icons (https://feathericons.com, MIT License,
 * Copyright (c) 2013-2017 Cole Bemis). The licence texts are in
 * THIRD_PARTY_NOTICES at the repository's root.
 */
function Icon({ size = 14, stroke = 2, className, children }: { size?: number; stroke?: number; className?: string; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

type Props = { size?: number; className?: string };

export const PlusIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ChevronDownIcon = (props: Props) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronRightIcon = (props: Props) => (
  <Icon {...props}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const ChevronLeftIcon = (props: Props) => (
  <Icon {...props}>
    <path d="m15 6-6 6 6 6" />
  </Icon>
);

export const ExternalIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Icon>
);

export const CheckIcon = (props: Props) => (
  <Icon {...props} stroke={2.5}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const QuestionIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Icon>
);

export const ShipIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </Icon>
);

export const WarningIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Icon>
);

export const BoardIcon = (props: Props) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
  </Icon>
);

export const CrewIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

export const CostsIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </Icon>
);

/** Insights: bars of different heights, for how fast work moves. */
export const InsightsIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M4 20V12M10 20V6M16 20v-9M22 20H2" />
  </Icon>
);

export const SettingsIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </Icon>
);

export const CloseIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const ComputerIcon = (props: Props) => (
  <Icon {...props}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);

export const TerminalIcon = (props: Props) => (
  <Icon {...props}>
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </Icon>
);

export const PauseIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M9 5v14M15 5v14" />
  </Icon>
);

export const PlayIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M7 5l11 7-11 7V5z" />
  </Icon>
);

/** To the front of the queue: play, then a bar. */
export const NextIcon = (props: Props) => (
  <Icon {...props}>
    <path d="M6 5l9 7-9 7V5zM18 5v14" />
  </Icon>
);

export const CancelIcon = (props: Props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </Icon>
);

