// Translated text with markup inside: the string carries tags, e.g.
//   "settings.tip": "Press <kbd>Enter</kbd> to send, or read the <link>guide</link>."
// and the caller says what each tag becomes:
//   <Trans k="settings.tip" tags={{ kbd: (s) => <kbd>{s}</kbd>, link: (s) => <a onClick={…}>{s}</a> }} />
// Tags don't nest. {variables} are filled first, as in t().
import { Fragment, type ReactNode } from "react";
import { fill, message, type MsgKey, type Vars } from "../lib/i18n";

export type Tags = Record<string, (inner: string) => ReactNode>;

/** Splits a filled string into text and tagged parts. Exported for tests. */
export function renderTags(s: string, tags: Tags = {}): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<(\w+)>(.*?)<\/\1>/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const f = tags[m[1]];
    out.push(<Fragment key={i++}>{f ? f(m[2]) : m[2]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function Trans(props: { k: MsgKey; vars?: Vars; tags?: Tags }) {
  return <>{renderTags(fill(message(props.k, props.vars), props.vars), props.tags)}</>;
}
