import type { NextConfig } from 'next';
import { CONSOLE_HEADERS } from './src/lib/security-headers';

const config: NextConfig = {
  reactStrictMode: true,
  // The console holds no database of its own; every read goes to the bridge,
  // at the address in `FLEETADLC_BRIDGE_URL` when the console starts. Only server
  // code reads it, so it is not inlined here: listed under `env`, it was fixed
  // at build time, and a console built beside a live install talked to that
  // install's bridge whatever it was started with, and a cloud console to
  // whatever address the image was built with.
  env: {
    // Take-over connects straight to the gateway, which is admitted to fewer
    // people than the console itself. Browser code reads this, so it is fixed
    // when the console is built.
    NEXT_PUBLIC_FLEETADLC_TERMINAL_URL: process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL ?? '',
  },
  // No site may frame the console, so a click on a page elsewhere cannot land
  // on one of its buttons (src/lib/security-headers.ts).
  async headers() {
    return CONSOLE_HEADERS;
  },
  experimental: {
    // With middleware in front of `/api/*`, Next hands a route only this much
    // of a body (ten megabytes unless set). A backup with history is larger,
    // and reached the bridge cut short. This is the bridge's own limit,
    // `RESTORE_BODY_MAX` in apps/bridge/src/backup.ts, and `RESTORE_BODY_MAX`
    // in src/lib/restore-body.ts, which refuses a larger body before reading it.
    middlewareClientMaxBodySize: '96mb',
  },
};

export default config;
