/**
 * Text with its HTML comments — the fleetadlc markers — taken out.
 *
 * The pattern this replaces, `/<!--[\s\S]*?-->/g`, scanned from every `<!--`
 * to the end of the text when none was closed, so a message of many `<!--`
 * took seconds to draw on the console's one server process. This walks the
 * text once. An unclosed `<!--` keeps the rest as it was, as the pattern did.
 */
export function withoutComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start < 0) break;
    const end = text.indexOf('-->', start + 4);
    if (end < 0) break;
    out += text.slice(from, start);
    from = end + 3;
  }
  return from === 0 ? text : out + text.slice(from);
}
