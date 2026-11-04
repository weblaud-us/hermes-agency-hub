import { Fragment, type ReactNode } from "react";

/**
 * Renders agent-written markdown as React elements, never as HTML.
 *
 * This text comes from an agent that reads customer messages, so it can carry
 * whatever a customer typed. Building elements means a `<script>` in a briefing
 * stays visible text, with no raw HTML to sanitise and nothing to get wrong.
 */

const SAFE_HREF = /^https?:\/\//i;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const token = match[0];
    const key = `${index}-${token.length}`;
    if (match[1]) {
      nodes.push(
        <code key={key} className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      nodes.push(
        <strong key={key} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (match[3]) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link && SAFE_HREF.test(link[2])) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-signal underline underline-offset-2">
            {link[1]}
          </a>,
        );
      } else {
        // A javascript: or data: link stays as its label, with no way to follow it.
        nodes.push(link ? link[1] : token);
      }
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BLOCK_START = /^(#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+|\s*(---|\*\*\*)\s*$)/;

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const key = blocks.length;

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={key} className="thin-scroll overflow-x-auto rounded-xl border border-white/7 bg-black/40 p-3 font-mono text-xs leading-relaxed text-ink-2">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        level <= 2 ? (
          <h3 key={key} className="pt-2 text-base font-semibold text-ink first:pt-0">
            {renderInline(heading[2])}
          </h3>
        ) : (
          <h4 key={key} className="pt-1.5 text-sm font-semibold text-ink first:pt-0">
            {renderInline(heading[2])}
          </h4>
        ),
      );
      index += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={key} className="border-white/8" />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={key} className="border-l-2 border-hyper/60 pl-3 text-ink-2">
          {renderInline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }

    if (line.includes("|") && TABLE_RULE.test(lines[index + 1] ?? "")) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div key={key} className="thin-scroll overflow-x-auto rounded-xl border border-white/7">
          <table className="w-full text-left text-[13px] tabular-nums">
            <thead className="bg-white/4 text-ink">
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-white/6">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2 text-ink-2">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const ordered = /^\s*\d+\.\s+/.test(line);
    if (ordered || /^\s*[-*]\s+/.test(line)) {
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(lines[index].replace(pattern, ""));
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key} className={`space-y-1.5 pl-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-ink-3`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !BLOCK_START.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length === 0) {
      // A line that looks like a block start but matched nothing above: never stall on it.
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key}>{renderInline(paragraph.join(" "))}</p>);
  }

  return blocks;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={`space-y-3 text-sm leading-relaxed text-ink-2 ${className ?? ""}`}>
      {renderBlocks(source).map((block, index) => (
        <Fragment key={index}>{block}</Fragment>
      ))}
    </div>
  );
}
