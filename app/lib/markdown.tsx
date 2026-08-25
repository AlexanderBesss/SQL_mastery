import type { ReactNode } from 'react';

const anchor = (value: string) => value.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`')) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={index}>{token.slice(2, -2)}</strong>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) return <span className="source-link" key={index}>{link[1]}</span>;
    return token;
  });
}

export function Markdown({ source, onCopy }: { source: string; onCopy: (code: string) => void }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim() || 'text';
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      const value = code.join('\n');
      if (language === 'mermaid') nodes.push(<div className="diagram-card" key={nodes.length}><div className="diagram-label">Relationship map</div><pre><code>{value}</code></pre></div>);
      else nodes.push(<div className="code-card" key={nodes.length}><div><span>{language}</span><button onClick={() => onCopy(value)}>Copy</button></div><pre><code>{value}</code></pre></div>);
      continue;
    }
    const heading = line.match(/^(##|###|####)\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/[*_]/g, '');
      const id = anchor(text);
      nodes.push(level === 2 ? <h2 id={id} key={nodes.length}>{inline(text)}</h2> : level === 3 ? <h3 id={id} key={nodes.length}>{inline(text)}</h3> : <h4 id={id} key={nodes.length}>{inline(text)}</h4>); i++; continue;
    }
    if (/^---+$/.test(line.trim())) { nodes.push(<hr key={nodes.length} />); i++; continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())); i++; }
      const [headers, , ...body] = rows;
      nodes.push(<div className="table-wrap" key={nodes.length}><table><thead><tr>{headers.map((cell, j) => <th key={j}>{inline(cell)}</th>)}</tr></thead><tbody>{body.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line); const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*+]\s+/.test(lines[i]))) items.push(lines[i++].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
      nodes.push(ordered ? <ol key={nodes.length}>{items.map((item, j) => <li key={j}>{inline(item)}</li>)}</ol> : <ul key={nodes.length}>{items.map((item, j) => <li key={j}>{inline(item)}</li>)}</ul>); continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      nodes.push(<blockquote key={nodes.length}>{inline(quote.join(' '))}</blockquote>); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{2,4}\s|```|>|\s*[-*+]\s+|\s*\d+\.\s+|\|)/.test(lines[i])) paragraph.push(lines[i++]);
    nodes.push(<p key={nodes.length}>{inline(paragraph.join(' '))}</p>);
  }
  return <>{nodes}</>;
}
