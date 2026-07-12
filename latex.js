/* latex.js — converts a raw LaTeX article (pasted verbatim, preamble and all)
 * into HTML for the article reader. Math is left untouched for MathJax;
 * document structure (sections, lists, boxes, footnotes, refs) becomes HTML.
 *
 * Usage:  const { html, title } = LatexArticle.toHTML(texSource);
 */
window.LatexArticle = (function () {
  'use strict';

  /* math placeholders use private-use characters, so they can never
     collide with real prose */
  const T0 = '', T1 = '';

  function escapeHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* find the {...} group starting at str[open] === '{'; returns [content, endIndex] */
  function braceGroup(str, open) {
    let depth = 0;
    for (let i = open; i < str.length; i++) {
      const c = str[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return [str.slice(open + 1, i), i];
      }
    }
    return [str.slice(open + 1), str.length];
  }

  /* replace every \cmd{...} (brace-matched, so nesting works) via fn(content) */
  function replaceCommand(str, cmd, fn) {
    const needle = '\\' + cmd;
    let out = '', i = 0;
    while (true) {
      const at = str.indexOf(needle, i);
      if (at === -1) { out += str.slice(i); break; }
      /* not a longer command name (\text vs \texttt) */
      const after = str[at + needle.length];
      if (after && /[a-zA-Z]/.test(after)) {
        out += str.slice(i, at + needle.length); i = at + needle.length; continue;
      }
      out += str.slice(i, at);
      let j = at + needle.length;
      while (str[j] === ' ') j++;
      if (str[j] !== '{') { out += needle; i = at + needle.length; continue; }
      const [content, end] = braceGroup(str, j);
      out += fn(content);
      i = end + 1;
    }
    return out;
  }

  /* strip % comments (respecting \%) */
  function stripComments(src) {
    return src.split('\n').map(line => {
      let out = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '\\') { out += c + (line[i + 1] || ''); i++; continue; }
        if (c === '%') break;
        out += c;
      }
      return out;
    }).join('\n');
  }

  function toHTML(src) {
    src = src.replace(/\r\n?/g, '\n');
    src = stripComments(src);

    /* title from the preamble, if present */
    let title = '';
    const tAt = src.indexOf('\\title{');
    if (tAt !== -1) title = braceGroup(src, tAt + 6)[0].trim();

    /* body only */
    const b0 = src.indexOf('\\begin{document}');
    const b1 = src.lastIndexOf('\\end{document}');
    let body = src.slice(b0 === -1 ? 0 : b0 + '\\begin{document}'.length,
                         b1 === -1 ? src.length : b1);

    /* -------------------------------------------------------------- *
     * 1. stash math so nothing below touches it
     * -------------------------------------------------------------- */
    const math = []; // { tex, display, boxed }
    function stash(tex, display, boxed) {
      math.push({ tex, display, boxed: !!boxed });
      const tok = T0 + (math.length - 1) + T1;
      return display ? '\n\n' + tok + '\n\n' : tok;
    }

    /* empheq boxes -> plain env, flagged as boxed */
    body = body.replace(
      /\\begin\{empheq\}\[([^\]]*)\]\{(\w+\*?)\}([\s\S]*?)\\end\{empheq\}/g,
      (_, opts, env, inner) =>
        stash('\\begin{' + env + '}' + inner + '\\end{' + env + '}', true,
              /box\s*=/.test(opts)));

    /* display environments */
    body = body.replace(
      /\\begin\{(equation\*?|align\*?|flalign\*?|alignat\*?|gather\*?|multline\*?|eqnarray\*?)\}([\s\S]*?)\\end\{\1\}/g,
      (m) => stash(m, true));

    /* \[ ... \]  and  $$ ... $$ */
    body = body.replace(/\\\[([\s\S]*?)\\\]/g, (m) => stash(m, true));
    body = body.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => stash('\\[' + tex + '\\]', true));

    /* \( ... \) */
    body = body.replace(/\\\(([\s\S]*?)\\\)/g, (m) => stash(m, false));

    /* inline $...$ — manual scan so \$ is respected */
    {
      let out = '', i = 0, start = -1;
      while (i < body.length) {
        const c = body[i];
        if (c === '\\') {
          if (start === -1) out += c + (body[i + 1] || '');
          i += 2; continue;
        }
        if (c === '$') {
          if (start === -1) start = i;
          else { out += stash('\\(' + body.slice(start + 1, i) + '\\)', false); start = -1; }
          i++; continue;
        }
        if (start === -1) out += c;
        i++;
      }
      if (start !== -1) out += body.slice(start); /* unbalanced $ — leave as-is */
      body = out;
    }

    /* \eqref{x} in prose -> inline math so MathJax numbers & links it */
    body = body.replace(/\\eqref\{([^}]*)\}/g,
      (_, l) => stash('\\(\\eqref{' + l + '}\\)', false));

    /* -------------------------------------------------------------- *
     * 2. escape HTML in what remains (prose + structure only)
     * -------------------------------------------------------------- */
    body = escapeHTML(body);

    /* -------------------------------------------------------------- *
     * 3. structure
     * -------------------------------------------------------------- */

    /* sections & subsections, numbered; record labels */
    const labels = {}; // label -> { num, id }
    let sec = 0, sub = 0;
    body = body.replace(/\\(sub)?section\*?\s*\{([^}]*)\}(\s*\\label\{([^}]*)\})?/g,
      (_, isSub, titleTxt, __, label) => {
        let num;
        if (isSub) { sub++; num = sec + '.' + sub; }
        else { sec++; sub = 0; num = String(sec); }
        const id = label ? label.replace(/[^a-zA-Z0-9:_-]/g, '') : 'sec-' + num;
        if (label) labels[label] = { num, id };
        const tag = isSub ? 'h3' : 'h2';
        return '\n\n<' + tag + ' id="' + id + '"><span class="secnum">' + num +
               '</span>' + titleTxt + '</' + tag + '>\n\n';
      });

    /* stray labels in prose become anchors */
    body = body.replace(/\\label\{([^}]*)\}/g, (_, l) =>
      '<span id="' + l.replace(/[^a-zA-Z0-9:_-]/g, '') + '"></span>');

    /* \ref{...}: section labels -> linked number; unknown -> math \ref */
    body = body.replace(/\\ref\{([^}]*)\}/g, (_, l) => {
      const hit = labels[l];
      if (hit) return '<a class="secref" href="#' + hit.id + '">' + hit.num + '</a>';
      return stash('\\(\\ref{' + l + '}\\)', false);
    });
    body = body.replace(/\\S\b/g, '&sect;');

    /* boxes */
    body = body.replace(/\\begin\{mybox\}/g, '\n\n<div class="mybox">\n\n')
               .replace(/\\end\{mybox\}/g, '\n\n</div>\n\n');

    /* theorem-family environments (from dhortthms) */
    const thmKinds = {
      theorem: 'result', proposition: 'result', lemma: 'result', claim: 'result',
      corollary: 'followup', example: 'followup', note: 'followup', remark: 'followup',
      definition: 'presumption', notation: 'presumption', axiom: 'presumption',
      question: 'question'
    };
    const thmCount = {};
    body = body.replace(/\\begin\{(theorem|proposition|lemma|claim|corollary|example|note|remark|definition|notation|axiom|question)\}(\[([^\]]*)\])?/g,
      (_, env, __, opt) => {
        thmCount[env] = (thmCount[env] || 0) + 1;
        const numbered = !(env === 'remark' || env === 'note');
        const head = env.charAt(0).toUpperCase() + env.slice(1) +
                     (numbered ? ' ' + thmCount[env] : '') +
                     (opt ? ' (' + opt + ')' : '');
        return '\n\n<div class="thm thm-' + thmKinds[env] + '"><span class="thmhead">' +
               head + ':</span> ';
      });
    body = body.replace(/\\end\{(theorem|proposition|lemma|claim|corollary|example|note|remark|definition|notation|axiom|question)\}/g, '\n\n</div>\n\n');

    /* derivation environment — optional [title], collapsed by default */
    body = body.replace(/\\begin\{derivation\}(\[([^\]]*)\])?/g, (_, __, label) =>
      '\n\n<details class="derivation"><summary>' + (label || 'Show derivation') + '</summary>\n\n')
      .replace(/\\end\{derivation\}/g, '\n\n</details>\n\n');

    /* proof environment */
    body = body.replace(/\\begin\{proof\}/g, '\n\n<div class="proof"><em>Proof.</em> ')
               .replace(/\\end\{proof\}/g, ' <span class="qed">&#8718;</span></div>\n\n');

    /* lists — innermost first so nesting works */
    (function lists() {
      const re = /\\begin\{(enumerate|itemize)\}(\[([^\]]*)\])?((?:(?!\\begin\{(?:enumerate|itemize)\})[\s\S])*?)\\end\{\1\}/;
      let m;
      while ((m = body.match(re))) {
        const whole = m[0], env = m[1], opts = m[3], inner = m[4];
        let cls = '';
        if (opts && /roman/.test(opts)) cls = ' class="lroman"';
        else if (opts && /[Aa]lph/.test(opts)) cls = ' class="lalpha"';
        const items = inner.split(/\\item\b/).slice(1)
          .map(it => '<li>' + it.trim() + '</li>').join('\n');
        const tag = env === 'itemize' ? 'ul' : 'ol';
        body = body.replace(whole, '\n\n<' + tag + cls + '>\n' + items + '\n</' + tag + '>\n\n');
      }
    })();

    /* images: \includegraphics[opts]{path} */
    body = body.replace(/\\includegraphics(\[([^\]]*)\])?\s*\{([^}]*)\}/g, (_, __, opts, path) => {
      let style = '';
      const wm = opts && opts.match(/width\s*=\s*([0-9.]+)\s*\\(?:text|line|column)width/);
      if (wm) style = ' style="width:' + Math.round(parseFloat(wm[1]) * 100) + '%"';
      const src = /^(https?:|\/|content\/)/.test(path) ? path : 'content/' + path;
      return '<img class="figimg" src="' + src + '" alt=""' + style + ' />';
    });

    /* \websvg{path} — inlined after insertion so SVG animations run */
    body = body.replace(/\\websvg\s*\{([^}]*)\}/g, (_, path) => {
      const src = /^(https?:|\/|content\/)/.test(path) ? path : 'content/' + path;
      return '<span class="inline-svg" data-svg="' + src + '"></span>';
    });

    /* figure/center wrappers become plain divs */
    body = body.replace(/\\begin\{(figure|center)\}(\[[^\]]*\])?/g, '\n\n<div class="figure">\n\n')
               .replace(/\\end\{(figure|center)\}/g, '\n\n</div>\n\n');
    body = replaceCommand(body, 'caption', c => '<p class="caption">' + c + '</p>');

    /* -------------------------------------------------------------- *
     * 4. inline text commands
     * -------------------------------------------------------------- */
    body = replaceCommand(body, 'emph', c => '<em>' + c + '</em>');
    body = replaceCommand(body, 'textit', c => '<em>' + c + '</em>');
    body = replaceCommand(body, 'textbf', c => '<strong>' + c + '</strong>');
    body = replaceCommand(body, 'texttt', c => '<code>' + c + '</code>');
    body = replaceCommand(body, 'textsc', c => '<span class="smallcaps">' + c + '</span>');
    body = replaceCommand(body, 'underline', c => '<u>' + c + '</u>');
    body = replaceCommand(body, 'ul', c => '<u>' + c + '</u>');
    body = replaceCommand(body, 'url', c => '<a href="' + c + '">' + c + '</a>');

    /* accents (é, ö, à, …) */
    [
      [/\\'e/g, 'é'], [/\\'E/g, 'É'], [/\\`e/g, 'è'], [/\\`a/g, 'à'], [/\\'a/g, 'á'],
      [/\\"o/g, 'ö'], [/\\"u/g, 'ü'], [/\\"a/g, 'ä'], [/\\"i/g, 'ï'],
      [/\\\^o/g, 'ô'], [/\\\^e/g, 'ê'], [/\\~n/g, 'ñ'], [/\\c\{c\}/g, 'ç'],
      [/\\'\{e\}/g, 'é'], [/\\"\{o\}/g, 'ö']
    ].forEach(([re, ch]) => { body = body.replace(re, ch); });

    /* typographic quotes & dashes (math already stashed, so this is safe) */
    body = body.replace(/``/g, '“').replace(/''/g, '”')
               .replace(/---/g, '—').replace(/--/g, '–')
               .replace(/`/g, '‘')
               .replace(/\\(l?dots)\b/g, '…');

    /* commands to silently drop */
    body = body
      .replace(/\\(maketitle|tableofcontents|noindent|newpage|clearpage|centering|bigskip|medskip|smallskip|indent|frenchspacing|white|hfill|vfill|allowdisplaybreaks)\b/g, '')
      .replace(/\\(thispagestyle|pagestyle|vspace\*?|hspace\*?|setlength|setstretch|fontsize)\s*\{[^}]*\}/g, '')
      .replace(/\\selectfont\b/g, '')
      .replace(/\\(,|;|!|:)/g, ' ')
      .replace(/\\\\(\[[^\]]*\])?/g, '<br/>')
      .replace(/~/g, '&nbsp;')
      .replace(/\\&/g, '&amp;').replace(/\\%/g, '%').replace(/\\#/g, '#')
      .replace(/\\_/g, '_').replace(/\\\$/g, '$');

    /* footnotes — extracted after inline transforms so their content is
       already formatted; math tokens inside are restored with everything else */
    const notes = [];
    body = replaceCommand(body, 'footnote', (content) => {
      notes.push(content);
      const n = notes.length;
      return '<sup class="fnref"><a href="#fn-' + n + '" id="fnref-' + n + '">' + n + '</a></sup>';
    });

    /* -------------------------------------------------------------- *
     * 5. paragraphs
     * -------------------------------------------------------------- */
    const tokBlock = new RegExp('^' + T0 + '\\d+' + T1 + '$');
    body = body.split(/\n{2,}/).map(chunk => {
      const c = chunk.trim();
      if (!c) return '';
      if (/^<\/?(h2|h3|div|ol|ul|img|p\b|section|details|summary)/.test(c) || tokBlock.test(c)) return c;
      return '<p>' + c + '</p>';
    }).filter(Boolean).join('\n');

    /* footnotes section */
    if (notes.length) {
      body += '\n<section class="footnotes"><ol>' +
        notes.map((n, i) =>
          '<li id="fn-' + (i + 1) + '">' + n +
          ' <a class="fnback" href="#fnref-' + (i + 1) + '">&#8617;</a></li>').join('') +
        '</ol></section>';
    }

    /* -------------------------------------------------------------- *
     * 6. restore math
     * -------------------------------------------------------------- */
    body = body.replace(new RegExp(T0 + '(\\d+)' + T1, 'g'), (_, i) => {
      const m = math[+i];
      const tex = escapeHTML(m.tex);
      if (!m.display) return tex;
      return '<div class="' + (m.boxed ? 'mathbox' : 'disp') + '">' + tex + '</div>';
    });

    return { html: body, title };
  }

  /* fetch + inline any \websvg placeholders so CSS/SMIL animations run */
  function inlineSVGs(root) {
    root.querySelectorAll('.inline-svg[data-svg]').forEach(el => {
      fetch(el.dataset.svg).then(r => { if (!r.ok) throw 0; return r.text(); })
        .then(txt => {
          const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
          const svg = doc.documentElement;
          if (svg && svg.nodeName === 'svg') el.replaceWith(svg);
        }).catch(() => {});
    });
  }

  return { toHTML, inlineSVGs };
})();
