import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { withoutComments } from '@/lib/comments';

/**
 * A bot's words as it wrote them: GitHub-flavoured markdown.
 *
 * The bots write for GitHub, where their comments land, so a question arrives
 * with `**bold**`, backticks, numbered lists and links. Shown as plain text, a
 * four-part question from the intake bot was a wall of asterisks — in its
 * thread and on the board's "Needs you" card alike.
 *
 * Deliberately small: paragraphs, line breaks, headings, lists, fenced code,
 * and inline code, bold, italics and links. It builds React elements and never
 * HTML, so nothing a bot writes can become markup, and a link is kept only when
 * it goes to http or https. Anything it does not recognise stays as the text
 * it was. The fleetadlc markers (`<!-- fleetadlc:{…} -->`) are for the bridge, not for
 * a person, and are dropped.
 */

export type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; text: string };

/**
 * OpenADLC's header, as `headerFor` in @fleetadlc/shared writes it: a bold first line
 * followed by its invisible tag. The console reads the bridge and not the
 * packages, so the shape is repeated here; the tag is what keeps a bold first
 * line somebody wrote from being taken for it.
 */
const FLEETADLC_HEADER = /^\*\*[^\n]*\*\*<!-- fleet(?:adlc)?-header -->[ \t]*\n*/;

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
/**
 * The closing hashes are taken off after the match, not in it. As one pattern,
 * `(.*?)\s*#*\s*$`, a heading followed by a few thousand spaces and a letter
 * took seconds to read, cubic in its length, on the server, for every user.
 */
const HEADING = /^\s{0,3}#{1,6}\s(.*)$/s;
const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Past this many characters a message is shown as plain text after its
 * formatted part, not dropped: what a person reads first is formatted, and no
 * message, however long, costs the server more than this to format.
 */
export const FORMATTED_LIMIT = 20_000;

function headingText(rest: string): string {
  const text = rest.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  return text.slice(0, end).trimEnd();
}

/**
 * The text as blocks, with HTML comments — the fleetadlc markers — taken out, and
 * the header OpenADLC puts first on what it posts to GitHub (`**OpenADLC_x · design
 * agent**`): the console already shows which bot said it.
 */
export function parseMarkdown(text: string): Block[] {
  const lines = withoutComments(text.replace(FLEETADLC_HEADER, '')).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Extract<Block, { kind: 'list' }> | null = null;

  const closeParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = [];
  };
  const closeList = (): void => {
    if (list) blocks.push(list);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    const fence = FENCE.exec(line);
    if (fence) {
      closeParagraph();
      closeList();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence[1]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      blocks.push({ kind: 'heading', text: headingText(heading[1]!) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      closeParagraph();
      const ordered = Boolean(item[2]);
      const current = list as Extract<Block, { kind: 'list' }> | null;
      if (!current || current.ordered !== ordered) {
        closeList();
        list = { kind: 'list', ordered, start: ordered ? Number(item[2]) : 1, items: [item[3]!] };
      } else {
        current.items.push(item[3]!);
      }
      continue;
    }

    // A line that continues a list item, indented under it.
    const continuing = list as Extract<Block, { kind: 'list' }> | null;
    if (continuing && /^\s{2,}\S/.test(line)) {
      const last = continuing.items.length - 1;
      continuing.items[last] = `${continuing.items[last]} ${line.trim()}`;
      continue;
    }

    closeList();
    paragraph.push(line);
  }
  closeParagraph();
  closeList();
  return blocks;
}

/** A link a person may follow: http or https, nothing else. */
function safeHref(url: string): string | null {
  return /^https?:\/\/[^\s<>"]+$/i.test(url) ? url : null;
}

/**
 * One pass, left to right, over the earliest thing that is markup. A code span
 * is tried first wherever one starts, because nothing inside backticks is
 * markup; bold and link text are read again for what they hold, since a bot
 * writes `**What about \`make ci\`?**` as often as plain bold. Splitting on the
 * backticks first left that bold as two halves with a `**` on each.
 *
 * Each part is bounded. Unbounded, every `[` scanned to the end of its line
 * and back, so a line of many — a bot's, or anybody's with access to the
 * repository — took seconds to draw, on the server, for every user.
 */
const INLINE =
  /(`[^`\n]{1,1000}`)|\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)|\*\*(.{1,500}?)\*\*|__(.{1,500}?)__|(?<![\w*])\*([^*\n]{1,500}?)\*(?!\w)|(?<![\w_])_([^_\n]{1,500}?)_(?!\w)/g;

/** Longer than this, a line is drawn as it was written: no markup is worth its cost. */
const PLAIN_PAST = 4000;

function renderInline(text: string, key = 'i'): ReactNode[] {
  if (text.split('\n').some((line) => line.length > PLAIN_PAST)) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, code, linkText, href, bold, boldAlt, italic, italicAlt] = match;
    const id = `${key}-${n++}`;
    if (code !== undefined) {
      out.push(
        <code key={id} className="rounded bg-well px-1 py-px font-mono text-[0.92em] text-body">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (linkText !== undefined && href !== undefined) {
      const safe = safeHref(href);
      out.push(
        safe ? (
          <a key={id} href={safe} target="_blank" rel="noreferrer" className="text-link hover:underline">
            {renderInline(linkText, id)}
          </a>
        ) : (
          whole
        ),
      );
    } else if (bold !== undefined || boldAlt !== undefined) {
      out.push(
        <strong key={id} className="font-semibold">
          {renderInline(bold ?? boldAlt ?? '', id)}
        </strong>,
      );
    } else {
      out.push(<em key={id}>{italic ?? italicAlt}</em>);
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The text split where formatting stops: at the last line break before the limit, or at the limit. */
function splitAtLimit(text: string): { formatted: string; rest: string } {
  if (text.length <= FORMATTED_LIMIT) return { formatted: text, rest: '' };
  const lineBreak = text.lastIndexOf('\n', FORMATTED_LIMIT);
  const at = lineBreak > 0 ? lineBreak : FORMATTED_LIMIT;
  return { formatted: text.slice(0, at), rest: withoutComments(text.slice(at)).trim() };
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const { formatted, rest } = splitAtLimit(text);
  const blocks = parseMarkdown(formatted);
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 break-words', className)}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading':
            return (
              <p key={key} className="font-semibold">
                {renderInline(block.text, key)}
              </p>
            );
          case 'code':
            return (
              <pre key={key} className="overflow-x-auto rounded-md bg-well px-2.5 py-2 font-mono text-[12px] leading-relaxed text-body">
                {block.text}
              </pre>
            );
          case 'list': {
            const items = block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`} className="pl-0.5">
                {renderInline(item, `${key}-${itemIndex}`)}
              </li>
            ));
            return block.ordered ? (
              <ol key={key} start={block.start} className="flex list-decimal flex-col gap-1 pl-5">
                {items}
              </ol>
            ) : (
              <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
                {items}
              </ul>
            );
          }
          default:
            return (
              <p key={key}>
                {block.lines.map((line, lineIndex) => (
                  <span key={`${key}-${lineIndex}`}>
                    {lineIndex > 0 && <br />}
                    {renderInline(line, `${key}-${lineIndex}`)}
                  </span>
                ))}
              </p>
            );
        }
      })}
      {rest && <p className="whitespace-pre-wrap">{rest}</p>}
    </div>
  );
}
