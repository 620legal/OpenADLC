# 0010. The console's name and logo are settings, the logo a data URL drawn only through `<img>`

- **Status:** accepted
- **Date:** 2026-10-23

## Context

#108 asked that an admin can put their company's name and logo at the top
left of the console, from Settings, in place of the fixed "OpenADLC". Every
person using the console sees them, so every role has to be able to read
them. The logo is a file a person gives, possibly an SVG, which a browser
runs as a page if it is inlined or served unsandboxed. `effectiveConfig`
reads every setting on most requests and on every webhook delivery (61 call
sites), and a 256 KB logo is about 350 KB of base64 that none of them needs.

## Decision

- **Two settings.** `consoleName` and `consoleLogo` are keys in
  `SETTING_KEYS`. `consoleLogo` holds a normalised `data:<type>;base64,…`
  whose type is the one its bytes were found to be: PNG, JPEG or WebP by
  `sniffBinary`, or an SVG whose root is `<svg` with no DOCTYPE or entity. It
  is 1 to 262 144 bytes (`apps/bridge/src/brand.ts`). No migration.
- **Large settings stay out of `allSettings`.** `LARGE_SETTING_KEYS`
  (`consoleLogo`) is left out of `allSettings()` unless it is called with
  `{ large: true }`, which the backup does, so a backup and a restore carry
  the logo and `effectiveConfig` never reads it. `settingDigest(key)` gives
  an md5 and the first 40 characters, which is what `GET /v1/brand` answers
  with: the logo's media type, and a version.
- **Every role reads it.** `GET /v1/brand` (name and logo version) and
  `GET /v1/brand/logo` (the bytes) are `user` routes. Changing either is
  `PATCH /v1/install`, an admin's, checked before anything in the request is
  written and audited as `install.configured` with the keys, never the values.
- **It reaches the header through the root layout.** The layout reads the
  brand once per request, beside who is asking, into a `BrandProvider` next to
  `RoleProvider`, so every page with `AppHeader` draws it without `HeaderData`
  changing, and a change shows on the next page load.
- **The logo is only ever an `<img>`, and served sandboxed.** The bridge and
  the console send it with `nosniff` and `sandbox; default-src 'none';
  style-src 'unsafe-inline'; img-src data:` (the console adds
  `frame-ancestors 'none'`). `security-headers.ts` leaves `/api/brand/logo`
  out of the config's frame policy, or Next would keep that one and drop the
  route's sandbox.
- **The console name is not the install name.** `installName` still heads
  every post on GitHub, and the tab title stays "OpenADLC console".

## What this rules out

- **The logo as an attachment row (ADR 0001's table).** Attachments belong to
  work items, are swept when nobody claims them within 24 hours, and are
  refused as SVG by design. A logo would need an exception in all three.
- **A `console_brand` table.** It needs a migration and a backup section of
  its own for one value, which the settings table holds already and the
  backup already carries.
- **The brand in `HeaderData` through `readHeader`.** Several pages build
  `headerData(...)` themselves rather than call `readHeader`, and a page that
  was missed would draw "OpenADLC".
- **The logo in `GET /v1/install` or `GET /v1/brand`.** That is 350 KB on
  every page load, and it cannot be cached.
- **An SVG sanitiser.** `<img>` and the sandboxed policy are the guarantee. A
  sanitiser would be a second guarantee to keep current, and a new
  dependency.

## What would make this worth revisiting

A logo that has to be larger than the settings table holds comfortably, or a
place that draws it other than through `<img>`, such as a favicon, an email or
a page inlining it. Either needs its own storage or its own sanitising. A
second large setting would also make `LARGE_SETTING_KEYS` worth a look.
