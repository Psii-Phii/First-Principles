/* Shared with your First Principles site (published there as latex.js) so Panopticon's viewer and the website render alike. */
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

  /* theorem-like environments: the common names, plus whatever your preamble declares (Panopticon passes opts.thms) */
  const KIND = t => /theorem|proposition|lemma|corollary|claim|conjecture|fact|principle|law|result/i.test(t) ? 'result'
    : /definition|notation|axiom|assumption|postulate|convention|hypothesis/i.test(t) ? 'definition'
    : /example|exercise|problem|question|puzzle/i.test(t) ? 'example'
    : /remark|note|observation|aside|comment|warning|caution|intuition|summary|recall/i.test(t) ? 'remark' : 'result';
  const DEFAULT_THMS = {};
  [['theorem','Theorem'],['thm','Theorem'],['proposition','Proposition'],['prop','Proposition'],['lemma','Lemma'],['lem','Lemma'],
   ['corollary','Corollary'],['cor','Corollary'],['claim','Claim'],['conjecture','Conjecture'],['conj','Conjecture'],['fact','Fact'],
   ['definition','Definition'],['defn','Definition'],['defi','Definition'],['dfn','Definition'],['notation','Notation'],['axiom','Axiom'],['assumption','Assumption'],
   ['example','Example'],['ex','Example'],['exmp','Example'],['eg','Example'],['exercise','Exercise'],['exer','Exercise'],['problem','Problem'],['prob','Problem'],['question','Question'],
   ['remark','Remark','u'],['rem','Remark','u'],['rmk','Remark','u'],['note','Note','u'],['observation','Observation','u'],['obs','Observation','u'],['intuition','Intuition','u'],['recall','Recall','u'],['summary','Summary','u']
  ].forEach(([n, t, u]) => { DEFAULT_THMS[n] = { title: t, ctr: n, within: '', numbered: !u }; });

  /* ---- used when the website renders an article on its own (no Panopticon viewer around it) ---- */
  function parseThms(pre) {
    const T = {};
    for (const m of pre.matchAll(/\\newtheorem(\*?)\s*\{([^}]+)\}\s*(?:\[([^\]]+)\])?\s*\{([^}]+)\}\s*(?:\[([^\]]+)\])?/g)) {
      const [, star, name, share, title, within] = m;
      T[name.trim()] = { title: title.trim(), ctr: (share || name).trim(), within: (within || '').trim(), numbered: !star };
    }
    for (const m of pre.matchAll(/\\declaretheorem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
      const o = m[1] || '', g = k => { const r = new RegExp(k + '\\s*=\\s*\\{?([^,}\\]]+)').exec(o); return r ? r[1].trim() : ''; };
      for (const name of m[2].split(',').map(x => x.trim()))
        T[name] = { title: g('name') || name[0].toUpperCase() + name.slice(1), ctr: g('sibling') || g('sharenumber') || name,
                    within: g('numberwithin') || g('parent'), numbered: !/numbered\s*=\s*no/.test(o) };
    }
    for (const m of pre.matchAll(/\\newtcbtheorem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}\s*\{([^}]+)\}/g)) {
      const o = m[1] || '', n = m[2].trim();
      T[n] = { title: m[3].trim(), ctr: n, within: /number within\s*=\s*section/.test(o) ? 'section' : '', numbered: true, tcb: true };
      T[n + '*'] = { title: m[3].trim(), ctr: n, numbered: false, tcb: true };
    }
    return T;
  }
  /* the preamble's own macros (\newcommand, \DeclareMathOperator, \def, \let), handed to MathJax */
  const FALLBACK_DEFS = '\\newcommand{\\qedhere}{}\\newcommand{\\oiint}{\\mathop{\\unicode{x222F}}\\nolimits}' +
    '\\newcommand{\\oiiint}{\\mathop{\\unicode{x2230}}\\nolimits}\\newcommand{\\varoiint}{\\mathop{\\unicode{x222F}}\\nolimits}' +
    '\\newcommand{\\ointclockwise}{\\mathop{\\unicode{x2232}}\\nolimits}\\newcommand{\\bm}[1]{\\boldsymbol{#1}}' +
    '\\newcommand{\\mathds}[1]{\\mathbb{#1}}\\newcommand{\\textsc}[1]{\\text{#1}}\\newcommand{\\slashed}[1]{{\\not{#1}}}';
  function preambleDefs(pre, known) {
    const out = [];
    const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)\s*/g; let m;
    while ((m = re.exec(pre))) {
      let i = re.lastIndex, name;
      if (pre[i] === '{') { const g = braceGroup(pre, i); name = g[0].trim(); i = g[1] + 1; }
      else { const n = /^\\[A-Za-z]+/.exec(pre.slice(i)); if (!n) continue; name = n[0]; i += name.length; }
      if (!/^\\[A-Za-z]+$/.test(name)) continue;
      let args = '', opt = ''; while (/\s/.test(pre[i])) i++;
      if (m[1] !== 'DeclareMathOperator') {
        const a = /^\[(\d)\]/.exec(pre.slice(i));
        if (a) { args = a[0]; i += a[0].length; const o = /^\[([^\]]*)\]/.exec(pre.slice(i)); if (o) { opt = o[0]; i += o[0].length; } }
      }
      while (/\s/.test(pre[i])) i++; if (pre[i] !== '{') continue;
      const [body, e] = braceGroup(pre, i); re.lastIndex = e + 1;
      if (m[1] === 'providecommand' && known && known[name.slice(1)]) continue;
      if (/\\(par\b|section|begin\{(?:tikz|figure)|makeatletter|@)/.test(body)) continue;
      out.push({ i: m.index, t: m[1] === 'DeclareMathOperator' ? '\\newcommand{' + name + '}{\\operatorname' + m[2] + '{' + body + '}}'
                                                               : '\\newcommand{' + name + '}' + args + opt + '{' + body + '}' });
    }
    for (const d of pre.matchAll(/\\def\s*(\\[A-Za-z]+)\s*\{/g)) {
      const [body] = braceGroup(pre, d.index + d[0].length - 1);
      if (!/\\(par\b|section|begin\{(?:tikz|figure))|#|@/.test(body)) out.push({ i: d.index, t: '\\newcommand{' + d[1] + '}{' + body + '}' });
    }
    for (const d of pre.matchAll(/\\let\s*(\\[A-Za-z]+)\s*=?\s*(\\[A-Za-z]+)/g))
      if (!/^\\(relax|undefined|@undefined|empty)$/.test(d[2])) out.push({ i: d.index, t: '\\newcommand{' + d[1] + '}{' + d[2] + '}' });
    return out.sort((a, b) => a.i - b.i).map(x => x.t).join('');
  }
  /* small text commands the structure pass leaves alone */
  function tidy(t) {
    return t.replace(/\\S(?![a-zA-Z])\s?/g, '§').replace(/\\P(?![a-zA-Z])\s?/g, '¶')
      .replace(/\\href\s*\{[^}]*\}\s*\{([^}]*)\}/g, '$1').replace(/\\(?:cite|citep|citet)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g, '[$1]')
      .replace(/\\(?:mbox|textup|textnormal|textrm|textmd|textsf)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\(?:hfill|vfill|linebreak|nopagebreak|pagebreak|newpage|clearpage|noindent|medskip|bigskip|smallskip)\b/g, ' ')
      .replace(/\\(?:TeX)\b/g, 'TeX').replace(/\\(?:LaTeX)\b/g, 'LaTeX');
  }
  /* numbers for sections' theorems, as LaTeX would count them */
  function numberThms(html) {
    let sec = 0; const tc = {};
    return html.replace(/<h2\b|<span class="thmhead" data-ctr="([^"]*)" data-within="([^"]*)">([\s\S]*?)<span class="th-n"><\/span>/g, (m, ctr, within, mid) => {
      if (m === '<h2') { sec++; for (const k in tc) if (tc[k].w) tc[k].n = 0; return m; }
      const c = tc[ctr] || (tc[ctr] = { n: 0, w: false }); if (within === 'section') c.w = true; c.n++;
      return '<span class="thmhead" data-ctr="' + ctr + '" data-within="' + within + '">' + mid + '<span class="th-n">' + (c.w && sec ? sec + '.' : '') + c.n + '</span>';
    });
  }

  function toHTML(src, opts) {
    opts = opts || {};
    src = src.replace(/\r\n?/g, '\n');
    src = stripComments(src);
    /* on the website (no viewer passing theorem definitions): read them, and the macros, from the preamble */
    const SITE = !opts.thms;
    let siteDefs = '';
    if (SITE) {
      const pre0 = src.split('\\begin{document}')[0];
      const MJ = (typeof window !== 'undefined' && window.MathJax) || {};
      const known = (MJ.config && MJ.config.tex && MJ.config.tex.macros) || (MJ.tex && MJ.tex.macros) || {};
      opts = Object.assign({}, opts, { thms: parseThms(pre0) });
      siteDefs = FALLBACK_DEFS + preambleDefs(pre0, known);
    }

    /* title from the preamble, if present */
    let title = '';
    const tAt = src.indexOf('\\title{');
    if (tAt !== -1) title = braceGroup(src, tAt + 6)[0].trim();

    /* body only */
    const b0 = src.indexOf('\\begin{document}');
    const b1 = src.lastIndexOf('\\end{document}');
    let body = src.slice(b0 === -1 ? 0 : b0 + '\\begin{document}'.length,
                         b1 === -1 ? src.length : b1);
    if (SITE) body = tidy(body);

    /* -------------------------------------------------------------- *
     * 1. stash math so nothing below touches it
     * -------------------------------------------------------------- */
    const math = []; // { tex, display, boxed }
    function stash(tex, display, boxed) {
      math.push({ tex, display, boxed: !!boxed });
      const tok = T0 + (math.length - 1) + T1;
      return display ? '\n\n' + tok + '\n\n' : tok;
    }

    /* TikZ / PGF drawings can't be drawn in a browser: a clear placeholder says where to see them */
    body = body.replace(/\\begin\{(tikzpicture|tikzcd|circuitikz|pgfpicture|forest|pspicture)\}([\s\S]*?)\\end\{\1\}/g, (m, env) => {
      math.push({ html: '<div class="tikzph" data-env="' + env + '"><span class="tikzph-i">◇</span><span><b>' +
        (env === 'tikzcd' ? 'Commutative diagram' : 'Diagram') + '</b> (' + env + ') — drawn in the PDF only. ' +
        'Open Preview to see it; for the website, export it as an SVG and use <code>\\websvg</code>.</span></div>' });
      return '\n\n' + T0 + (math.length - 1) + T1 + '\n\n';
    });

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
    body = body.replace(/\\qquad\b/g, '&emsp;&emsp;').replace(/\\quad\b/g, '&emsp;').replace(/\\(?:ldots|dots)\b/g, '…').replace(/\\[ ,;]/g, ' ');   /* spacing in prose (math is stashed away by now) */

    /* -------------------------------------------------------------- *
     * 3. structure
     * -------------------------------------------------------------- */

    /* sections & subsections, numbered; record labels */
    body = body.replace(/\\subsubsection\*?\s*\{([^}]*)\}/g, (_, t) => '\n\n<h4>' + t + '</h4>\n\n')
               .replace(/\\paragraph\*?\s*\{([^}]*)\}/g, (_, t) => '<strong class="runin">' + t + '.</strong> ');
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

    /* \begin{textbox}[any title] … \end{textbox}: a box you name yourself */
    body = body.replace(/\\begin\{textbox\}(\[([^\]]*)\])?/g, (_, __, t) => '\n\n<div class="thm thm-box">' +
      (t ? '<span class="thmhead"><span class="th-t">' + t + '</span><span class="th-p">.</span></span> ' : ''))
               .replace(/\\end\{textbox\}/g, '\n\n</div>\n\n');

    /* theorem-family environments — sleek boxes; numbers are filled in by the viewer (so they count across the whole document) */
    const TH = Object.assign({}, DEFAULT_THMS, opts.thms || {});
    const envRe = Object.keys(TH).sort((a, b) => b.length - a.length).map(n => n.replace(/[*]/g, '\\*')).join('|');
    body = body.replace(new RegExp('\\\\begin\\{(' + envRe + ')\\}(\\[([^\\]]*)\\])?(?:\\{([^}]*)\\}\\{[^}]*\\})?', 'g'),
      (m, env, _o, opt, tcbTitle) => {
        const t = TH[env] || { title: env, ctr: env, within: '', numbered: true };
        const name = opt || (t.tcb ? tcbTitle : '');
        return '\n\n<div class="thm thm-' + (t.kind || KIND(t.title)) + '"><span class="thmhead" data-ctr="' + (t.ctr || env) + '" data-within="' + (t.within || '') + '">' +
               '<span class="th-t">' + t.title + '</span>' + (t.numbered === false ? '' : ' <span class="th-n"></span>') +
               (name ? ' <span class="thmname">(' + name + ')</span>' : '') + '<span class="th-p">.</span></span> ';
      });
    body = body.replace(new RegExp('\\\\end\\{(' + envRe + ')\\}', 'g'), '\n\n</div>\n\n');

    /* derivation environment — optional [title], collapsed by default */
    body = body.replace(/\\begin\{derivation\}(\[([^\]]*)\])?/g, (_, __, label) =>
      '\n\n<details class="derivation"><summary>' + (label || 'Show derivation') + '</summary>\n\n')
      .replace(/\\end\{derivation\}/g, '\n\n</details>\n\n');

    /* proof environment */
    body = body.replace(/\\begin\{proof\}(\[([^\]]*)\])?/g, (_, __, t) => '\n\n<div class="proof"><span class="pfhead">' + (t || 'Proof') + '.</span> ')
               .replace(/\\end\{proof\}/g, ' <span class="qed">&#8718;</span></div>\n\n')
               .replace(/\\begin\{(solution|soln|sol|answer)\}(\[([^\]]*)\])?/g, (_, e, __, t) => '\n\n<div class="proof sol"><span class="pfhead">' + (t || (e === 'answer' ? 'Answer' : 'Solution')) + '.</span> ')
               .replace(/\\end\{(solution|soln|sol|answer)\}/g, '</div>\n\n');

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

    /* any other environment: never left as raw \\begin{…} (which would reach the maths renderer and show as an error) */
    body = body.replace(/\\begin\{(quote|quotation|verse)\}/g, '\n\n<blockquote>\n\n').replace(/\\end\{(quote|quotation|verse)\}/g, '\n\n</blockquote>\n\n');
    body = body.replace(/\\begin\{([A-Za-z*]+)\}(\[[^\]]*\])?((?:\{[^}]*\})*)/g, (_, e) => '\n\n<div class="env env-' + e.replace('*', '') + '">\n\n')
               .replace(/\\end\{([A-Za-z*]+)\}/g, '\n\n</div>\n\n');

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
      if (/^<\/?(h2|h3|h4|div|ol|ul|img|p\b|section|details|summary)/.test(c) || tokBlock.test(c)) return c;
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
      if (m.html) return m.html;
      const tex = escapeHTML(m.tex);
      if (!m.display) return tex;
      return '<div class="' + (m.boxed ? 'mathbox' : 'disp') + '">' + tex + '</div>';
    });

    if (SITE && opts.number !== false) body = numberThms(body);
    if (siteDefs) body = '<div class="tex-defs" hidden aria-hidden="true">\\(' + escapeHTML(siteDefs) + '\\)</div>\n' + body;
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
