/* site.js — shared site-wide helpers.
 *
 * Conventions for future changes:
 *  - Anything used by more than one page lives here, on window.FP.
 *  - Static assets are referenced with a ?v=N query; bump FP.VERSION and the
 *    ?v= in the <link>/<script> tags whenever site.css / site.js / latex.js
 *    change, so browsers never serve a stale copy.
 */
window.FP = (function () {
  'use strict';

  const VERSION = 3;

  /* ---- admin mode ----------------------------------------------------
     Never linked from the site. Enable with ?admin=on on any page,
     disable with ?admin=off. State lives in this browser's localStorage,
     so visitors can't see or reach it. */
  function handleAdminParam() {
    const v = new URLSearchParams(location.search).get('admin');
    if (v !== 'on' && v !== 'off') return false;
    if (v === 'on') localStorage.setItem('fp-admin', '1');
    else localStorage.removeItem('fp-admin');
    return true; /* caller should strip the param and reload */
  }
  const isAdmin = () => localStorage.getItem('fp-admin') === '1';

  /* ---- article publish state ---------------------------------------- */
  const slugOf = a => a.slug || (a.file || '').replace(/\.(md|tex)$/, '');

  /* published unless the manifest says "published": false; an admin's
     toggle stores a this-browser-only preview override */
  function isPublished(a) {
    const o = localStorage.getItem('fp-pub-' + slugOf(a));
    if (o !== null) return o === '1';
    return a.published !== false;
  }
  const setPublished = (slug, v) =>
    localStorage.setItem('fp-pub-' + slug, v ? '1' : '0');

  /* ---- side art ------------------------------------------------------
     The ink drawings that rest, pinned, in wide right margins. */
  const SIDE_ART = ['art/spiral.png', 'art/waves.png'];
  const randomArt = () => SIDE_ART[Math.floor(Math.random() * SIDE_ART.length)];

  return { VERSION, handleAdminParam, isAdmin, slugOf, isPublished, setPublished, randomArt };
})();
