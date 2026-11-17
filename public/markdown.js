/* Small, dependency-free markdown renderer. Everything is HTML-escaped before any markup is added,
   so model output can never inject tags or attributes. Works on partial text, so it can run while streaming. */
(function (root) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

  const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
  const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
  const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function inline(text) {
    const codes = [];
    let out = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) => {
      codes.push(code.trim());
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = esc(out);
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g,
      (_m, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }

  function codeBlock(code, lang) {
    return '<div class="codeblock"><div class="cb-head"><span>' + esc(lang || 'text')
      + '</span><button type="button" class="copy-code">Copy</button></div><pre><code>' + esc(code) + '</code></pre></div>';
  }

  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function table(lines) {
    const head = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
    const cell = (tag, c, i) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(c)}</${tag}>`;
    const body = lines.slice(2).map((l) => `<tr>${splitRow(l).map((c, i) => cell('td', c, i)).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head.map((c, i) => cell('th', c, i)).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const indentOf = (line) => line.match(/^\s*/)[0].length;

  function parseList(lines, start) {
    const first = lines[start].match(LIST_RE);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let i = start;

    while (i < lines.length) {
      const m = lines[i].match(LIST_RE);
      if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
      const content = [lines[i].slice(m[0].length)];
      const nested = [];
      i += 1;
      while (i < lines.length) {
        const line = lines[i];
        if (/^\s*$/.test(line)) {
          let j = i + 1;
          while (j < lines.length && /^\s*$/.test(lines[j])) j += 1;
          if (j < lines.length && indentOf(lines[j]) > base) { nested.push(''); i = j; continue; }
          break;
        }
        if (indentOf(line) > base) { nested.push(line.slice(Math.min(indentOf(line), base + 2))); i += 1; continue; }
        break;
      }
      const inner = nested.length ? render(nested.join('\n')) : '';
      items.push(`<li>${inline(content.join(' '))}${inner}</li>`);
      if (i < lines.length && /^\s*$/.test(lines[i])) {
        let j = i;
        while (j < lines.length && /^\s*$/.test(lines[j])) j += 1;
        const nm = j < lines.length && lines[j].match(LIST_RE);
        if (nm && nm[1].length === base && /\d/.test(nm[2]) === ordered) i = j;
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    return [`<${tag}${attr}>${items.join('')}</${tag}>`, i];
  }

  function startsBlock(lines, i) {
    const line = lines[i];
    return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || /^\s*>/.test(line) || LIST_RE.test(line)
      || (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-'));
  }

  function render(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i += 1; continue; }

      let m = line.match(FENCE_RE);
      if (m) {
        const fence = m[1];
        const buf = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) { buf.push(lines[i]); i += 1; }
        i += 1;
        out.push(codeBlock(buf.join('\n'), m[2]));
        continue;
      }
      if ((m = line.match(HEADING_RE))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i += 1; continue; }
      if (HR_RE.test(line)) { out.push('<hr>'); i += 1; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const buf = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        out.push(table(buf));
        continue;
      }
      if (LIST_RE.test(line)) {
        const [html, next] = parseList(lines, i);
        out.push(html);
        i = next;
        continue;
      }
      const buf = [line];
      i += 1;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !startsBlock(lines, i)) { buf.push(lines[i]); i += 1; }
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  root.renderMarkdown = render;
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown: render };
})(typeof window !== 'undefined' ? window : globalThis);
