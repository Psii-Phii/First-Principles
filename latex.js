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
  /* the name of a TikZ picture's drawing: FNV-1a of its text with comments and whitespace removed (texctl.py computes the same) */
  function tikzKey(block) {
    const b = new TextEncoder().encode(block.replace(/\s+/g, ''));
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
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
  /* what panopticon-thm.sty defines the moment it is loaded (problem, exercise, question wait for \\begin{document}) */
  const PKG_THMS = {
    theorem: { title: 'Theorem', ctr: 'theorem', within: 'section' }, proposition: { title: 'Proposition', ctr: 'theorem' },
    lemma: { title: 'Lemma', ctr: 'theorem' }, conjecture: { title: 'Conjecture', ctr: 'theorem' },
    claim: { title: 'Claim', ctr: 'claim', within: 'theorem' }, corollary: { title: 'Corollary', ctr: 'claim' },
    definition: { title: 'Definition', ctr: 'definition', within: 'section' }, notation: { title: 'Notation', ctr: 'definition' },
    axiom: { title: 'Axiom', ctr: 'axiom', within: 'section' }, example: { title: 'Example', ctr: 'example', within: 'section' },
    remark: { title: 'Remark', numbered: false }, note: { title: 'Note', numbered: false } };
  const PKG_LATE = { exercise: 'Exercise', problem: 'Problem', question: 'Question' };
  function parseThms(pre) {
    const T = {};
    pre = pre.replace(/(^|[^\\])%[^\n]*/g, '$1');
    const pk = pre.search(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bpanopticon-thm\b[^}]*\}/);
    const pkgNames = new Set();
    for (const m of pre.matchAll(/\\newtheorem(\*?)\s*\{([^}]+)\}\s*(?:\[([^\]]+)\])?\s*\{([^}]+)\}\s*(?:\[([^\]]+)\])?/g)) {
      const [, star, name, share, title, within] = m, n = name.trim();
      // with the package loaded, its definitions come first: a later \\newtheorem of the same name (always guarded by
      // \\@ifundefined in your preambles) never happens in LaTeX, so it doesn't count here either
      if (pk >= 0 && m.index > pk && PKG_THMS[n] && !(n in T)) continue;
      T[n] = { title: title.trim(), ctr: (share || name).trim(), within: (within || '').trim(), numbered: !star };
    }
    if (pk >= 0) {
      for (const n in PKG_THMS) if (!(n in T)) { const d = PKG_THMS[n]; T[n] = { title: d.title, ctr: d.ctr || n, within: d.within || '', numbered: d.numbered !== false }; pkgNames.add(n); }
      for (const n in PKG_LATE) if (!(n in T) && !new RegExp('\\\\newenvironment\\s*\\{' + n + '\\}').test(pre)) T[n] = { title: PKG_LATE[n], ctr: n, within: 'section', numbered: true };
      // a shared counter that doesn't exist falls back to its own, numbered within the section (as the package does)
      for (const n of pkgNames) { const t = T[n]; if (t.ctr !== n && !Object.values(T).some(x => x.ctr === t.ctr && x !== t && (x.ctr === t.ctr))) { t.ctr = n; t.within = 'section'; } }
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
  /* LaTeX's counters: numbered within the section (1.2) or within another counter (claim 2.1.1 inside theorem 2.1) */
  function Counters() {
    let sec = 0; const tc = {}, lab = {};
    return {
      section() { sec++; for (const k in tc) if (tc[k].w === 'section') tc[k].n = 0; },
      next(ctr, within) {
        const c = tc[ctr] || (tc[ctr] = { n: 0, w: '' }); if (within) c.w = within; c.n++;
        for (const k in tc) if (tc[k].w === ctr) tc[k].n = 0;
        const pre = c.w === 'section' ? (sec ? sec + '.' : '') : c.w ? (lab[c.w] || '0') + '.' : '';
        return (lab[ctr] = pre + c.n);
      } };
  }
  function numberThms(html) {
    const C = Counters();
    return html.replace(/<h2\b|<span class="thmhead" data-ctr="([^"]*)" data-within="([^"]*)">([\s\S]*?)<span class="th-n"><\/span>/g, (m, ctr, within, mid) => {
      if (m === '<h2') { C.section(); return m; }
      return '<span class="thmhead" data-ctr="' + ctr + '" data-within="' + within + '">' + mid + '<span class="th-n">' + C.next(ctr, within) + '</span>';
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
    /* Panopticon draws each picture to figures/tikz/tikz-<hash>.svg when the document compiles; the viewer swaps that in */
    body = body.replace(/\\begin\{(tikzpicture|tikzcd|circuitikz|pgfpicture|forest|pspicture)\}([\s\S]*?)\\end\{\1\}/g, (m, env) => {
      math.push({ html: '<div class="tikzph" data-env="' + env + '" data-tikz="' + tikzKey(m) + '"><span class="tikzph-i">◇</span><span><b>' +
        (env === 'tikzcd' ? 'Commutative diagram' : 'Diagram') + '</b>' + (SITE ? ' — shown in the PDF version of these notes.'
          : ' (' + env + ') — appears here after the next compile (or open Preview).') + '</span></div>' });
      return '\n\n' + T0 + (math.length - 1) + T1 + '\n\n';
    });
    if (SITE) body = tidy(body);

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
    /* \ref, \autoref, \cref: a link whose number is filled in from what it points at (section, theorem or equation),
       so it is right across the whole document; hovering it shows the target (see enhance below) */
    body = body.replace(/\\(ref|autoref|cref|Cref)\*?\{([^}]*)\}/g, (_, cmd, l) => {
      l = l.split(',')[0].trim();
      const hit = labels[l], id = hit ? hit.id : l.replace(/[^a-zA-Z0-9:_-]/g, '');
      return '<a class="xref' + (hit ? ' secref' : '') + '" href="#' + id + '" data-ref="' + id + '"' + (cmd !== 'ref' ? ' data-auto="1"' : '') + '>' +
             (hit ? (cmd !== 'ref' ? 'Section ' : '') + hit.num : '?') + '</a>';
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
        return '\n\n<div class="thm thm-' + (t.kind || KIND(t.title)) + '"><span class="thmhead" data-ctr="' + (t.ctr || env) + '" data-within="' + (t.within || ((TH[t.ctr] && (TH[t.ctr].ctr || t.ctr) === t.ctr) ? TH[t.ctr].within || '' : '')) + '">' +
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

    /* lists — innermost first so nesting works. \item[(a)] and enumitem's label=(\alph*) keep their own labels;
       description lists become term/definition pairs */
    (function lists() {
      const re = /\\begin\{(enumerate|itemize|description)\}(\[([^\]]*)\])?((?:(?!\\begin\{(?:enumerate|itemize|description)\})[\s\S])*?)\\end\{\1\}/;
      const roman = n => { const v = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']]; let o = ''; for (const [k, r] of v) while (n >= k) { o += r; n -= k; } return o; };
      let m;
      while ((m = body.match(re))) {
        const whole = m[0], env = m[1], opts = m[3] || '', inner = m[4];
        // split into items, reading an optional [label] right after \item (brackets may nest one level)
        const parts = inner.split(/\\item\b/).slice(1).map(it => {
          const lm = /^\s*\[((?:[^\[\]]|\[[^\]]*\])*)\]/.exec(it);
          return lm ? { label: lm[1].trim(), text: it.slice(lm[0].length).trim() } : { label: null, text: it.trim() };
        });
        if (env === 'description') {
          body = body.replace(whole, '\n\n<dl class="desc">\n' + parts.map(p => '<dt>' + (p.label || '') + '</dt><dd>' + p.text + '</dd>').join('\n') + '\n</dl>\n\n');
          continue;
        }
        // enumitem: label=(\alph*), label=\roman*., label={(\arabic*)} …
        const lt = /label\s*=\s*\{?((?:[^{},]|\{[^}]*\})*?)\}?\s*(?:,|$)/.exec(opts);
        let n = 0;
        const auto = lt ? i => lt[1].replace(/\\alph\*/g, String.fromCharCode(97 + i)).replace(/\\Alph\*/g, String.fromCharCode(65 + i))
                                   .replace(/\\roman\*/g, roman(i + 1)).replace(/\\Roman\*/g, roman(i + 1).toUpperCase()).replace(/\\arabic\*/g, String(i + 1)) : null;
        const custom = parts.some(p => p.label !== null) || !!auto;
        let cls = '';
        if (!custom && /roman/.test(opts)) cls = 'lroman';
        else if (!custom && /[Aa]lph/.test(opts)) cls = 'lalpha';
        if (custom) cls = (cls + ' lcustom').trim();
        const items = parts.map(p => {
          const lab = p.label !== null ? p.label : auto ? auto(n) : null;
          if (p.label === null) n++;
          return lab !== null ? '<li class="lbl"><span class="ilbl">' + lab + '</span>' + p.text + '</li>' : '<li>' + p.text + '</li>';
        }).join('\n');
        const tag = env === 'itemize' ? 'ul' : 'ol';
        body = body.replace(whole, '\n\n<' + tag + (cls ? ' class="' + cls + '"' : '') + '>\n' + items + '\n</' + tag + '>\n\n');
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
      if (/^<\/?(h2|h3|h4|div|ol|ul|dl|img|p\b|section|details|summary)/.test(c) || tokBlock.test(c)) return c;
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
    if (SITE) {   /* the document's own box colours, from \definecolor{pthm…}{HTML}{…} */
      const pre1 = src.split('\\begin{document}')[0], css = [];
      for (const m of pre1.matchAll(/\\definecolor\{pthm(result|definition|example|remark|box)\}\{HTML\}\{([0-9A-Fa-f]{6})\}/g)) css.push('--k-' + m[1] + ':#' + m[2]);
      if (css.length) body = '<style>#body{' + css.join(';') + '}</style>\n' + body;
    }
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

  /* ---------------------------------------------------------------- *
   * reading aids, shared by Panopticon's viewer and the website:
   *   refs(root)     fill every \ref with the number of what it points at
   *   enhance(root)  hover a reference to see its target; click "Proof." to fold a proof;
   *                  hover a displayed equation for a button that copies its LaTeX
   * ---------------------------------------------------------------- */
  function findTarget(id) {
    if (!id) return null;
    return document.getElementById(id) || document.getElementById('mjx-eqn:' + id) || document.getElementById('mjx-eqn-' + id);
  }
  function numberOf(t) {
    if (!t) return null;
    if (t.closest('mjx-container')) { const n = (t.textContent || '').trim().replace(/^\(|\)$/g, ''); return { n, kind: 'Equation' }; }
    const th = t.closest('.thm');
    if (th) { const n = th.querySelector('.th-n'), k = th.querySelector('.th-t'); return { n: n ? n.textContent.trim() : '', kind: k ? k.textContent.trim() : '' }; }
    if (/^H[2-4]$/.test(t.tagName)) { const n = t.querySelector('.secnum'); return { n: n ? n.textContent.trim() : '', kind: 'Section' }; }
    return null;
  }
  function refs(root) {
    root.querySelectorAll('a.xref').forEach(a => {
      const id = a.dataset.ref, t = findTarget(id);
      if (t && t.id !== id) a.setAttribute('href', '#' + t.id);
      const r = numberOf(t);
      const txt = r && r.n ? (a.dataset.auto ? r.kind + ' ' + r.n : r.n) : '??';
      if (a.textContent !== txt) a.textContent = txt;
      a.classList.toggle('xbad', !r || !r.n);
    });
  }
  function injectCSS() {
    if (document.getElementById('lx-css')) return;
    const st = document.createElement('style'); st.id = 'lx-css';
    st.textContent =
      '.lxpop{position:fixed;z-index:9999;max-width:min(38em,calc(100vw - 24px));max-height:46vh;overflow:auto;padding:.7em 1em;border-radius:10px;' +
      'background:var(--lxbg,#fffdf8);color:var(--lxink,#1c1b19);border:1px solid color-mix(in srgb,var(--lxink,#000) 16%,transparent);' +
      'box-shadow:0 14px 40px -12px rgba(0,0,0,.35);font-size:.92em;line-height:1.5;pointer-events:none;opacity:0;transform:translateY(3px);transition:opacity .12s,transform .12s}' +
      '.lxpop.on{opacity:1;transform:none}.lxpop>*{margin-top:0!important;margin-bottom:0!important}.lxpop .thm{box-shadow:none}' +
      '.lxpop h2,.lxpop h3,.lxpop h4{font-size:1em;margin:0 0 .3em!important}' +
      'a.xbad{color:#b23b3b}' +
      '.proof .pfhead{cursor:pointer;user-select:none}.proof .pfhead::after{content:" ▾";font-size:.7em;opacity:.45;font-style:normal}' +
      '.proof.lxfold{max-height:1.62em;overflow:hidden;cursor:pointer;-webkit-mask-image:linear-gradient(90deg,#000 55%,transparent);mask-image:linear-gradient(90deg,#000 55%,transparent)}' +
      '.proof.lxfold .pfhead::after{content:" ▸  show"}' +
      '.lxeq{position:relative}.lxcopy{position:absolute;top:50%;right:-2.1em;transform:translateY(-50%);width:2.2em;height:1.7em;border-radius:6px;border:1px solid color-mix(in srgb,var(--lxink,#000) 18%,transparent);' +
      'background:var(--lxbg,#fff);color:inherit;opacity:0;cursor:pointer;font:600 10px/1 system-ui,sans-serif;padding:0;transition:opacity .12s}' +
      '.lxeq:hover .lxcopy{opacity:.55}.lxcopy:hover{opacity:1!important}.lxcopy.ok{opacity:1!important;color:#3f8a55}' +
      '@media (max-width:700px){.lxcopy{right:0;top:0;transform:none}}';
    document.head.appendChild(st);
  }
  function texOf(block) {
    try {
      const items = window.MathJax && MathJax.startup && MathJax.startup.document.getMathItemsWithin(block);
      if (items && items.length) {
        const t = items.map(i => (i.display && !/^\s*\\begin/.test(i.math) ? '\\[' + i.math + '\\]' : i.math)).join('\n');
        return t.replace(/\\label\{[^}]*\}\s*/g, '').trim();
      }
    } catch (e) {}
    return '';
  }
  function copyText(t) {
    const fall = () => { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); };
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(fall); else fall(); } catch (e) { fall(); }
  }
  function enhance(root) {
    if (!root || root.__lx) return; root.__lx = true; injectCSS();
    let pop = null, timer = 0;
    const hide = () => { clearTimeout(timer); if (pop) { pop.classList.remove('on'); const p = pop; setTimeout(() => p.remove(), 150); pop = null; } };
    const show = a => {
      const href = decodeURIComponent((a.getAttribute('href') || '').slice(1));
      const t = findTarget(href); if (!t || !root.contains(t) || t.contains(a)) return;
      const parts = [];
      if (/^H[2-4]$/.test(t.tagName)) { parts.push(t); let n = t.nextElementSibling, k = 0;   // the heading, then its first paragraph (past any subheading)
        while (n && k < 3) { parts.push(n); if (!/^H[2-4]$/.test(n.tagName)) break; n = n.nextElementSibling; k++; } }
      else { const block = t.closest('.disp,.mathbox') || t.closest('mjx-container') || t.closest('.thm,.proof,li,p'); if (block) parts.push(block); }
      if (!parts.length) return;
      const r0 = a.getBoundingClientRect(), rt = parts[0].getBoundingClientRect();
      if (rt.top >= 0 && rt.bottom <= innerHeight) return;   // the target is already on screen
      hide(); pop = document.createElement('div'); pop.className = 'lxpop';
      for (const x of parts) {
        const c = x.cloneNode(true); c.removeAttribute('id'); c.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
        c.querySelectorAll('.lxcopy').forEach(e => e.remove()); c.classList.remove('lxfold', 'lvhere'); pop.appendChild(c);
      }
      root.appendChild(pop);
      const w = pop.offsetWidth, h = pop.offsetHeight;
      const x = Math.min(Math.max(12, r0.left - 20), innerWidth - w - 12);
      let y = r0.bottom + 8; if (y + h > innerHeight - 8) y = Math.max(8, r0.top - h - 8);
      pop.style.left = x + 'px'; pop.style.top = y + 'px';
      const p = pop; requestAnimationFrame(() => p.classList.add('on'));
    };
    root.addEventListener('mouseover', e => {
      const el = e.target; if (!el.closest) return;
      const a = el.closest('a[href^="#"]');
      if (a && root.contains(a) && !a.closest('.lxpop')) { clearTimeout(timer); timer = setTimeout(() => show(a), 160); }
      const eq = el.closest('.disp,.mathbox');
      if (eq && root.contains(eq) && !eq.closest('.lxpop') && !eq.querySelector(':scope > .lxcopy') && eq.querySelector('mjx-container')) {
        eq.classList.add('lxeq'); const b = document.createElement('button'); b.className = 'lxcopy'; b.type = 'button'; b.title = 'Copy the LaTeX'; b.textContent = 'TeX'; eq.appendChild(b);
      }
    });
    root.addEventListener('mouseout', e => { const a = e.target.closest && e.target.closest('a[href^="#"]'); if (a && !a.contains(e.relatedTarget)) hide(); });
    addEventListener('scroll', hide, true);
    root.addEventListener('click', e => {
      const el = e.target; if (!el.closest) return;
      const c = el.closest('.lxcopy');
      if (c) { e.preventDefault(); e.stopPropagation(); const t = texOf(c.parentNode);
        if (t) { copyText(t); c.textContent = '✓'; c.classList.add('ok'); setTimeout(() => { c.textContent = 'TeX'; c.classList.remove('ok'); }, 1300); } return; }
      const ph = el.closest('.proof .pfhead, .proof.lxfold');
      if (ph && root.contains(ph)) {
        const pr = ph.closest('.proof'), fold = !pr.classList.contains('lxfold');
        if (e.altKey) root.querySelectorAll('.proof').forEach(p => p.classList.toggle('lxfold', fold)); else pr.classList.toggle('lxfold', fold);
        hide();
      }
    });
  }

  return { toHTML, inlineSVGs, parseThms, preambleDefs, stripComments, Counters, refs, enhance, tikzKey };
})();
