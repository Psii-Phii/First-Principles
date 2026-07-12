#!/usr/bin/env node
/* Regenerates feed.xml from content/articles.json. Run manually after
 * publishing an article: `node scripts/build_feed.js`. No dependencies. */

const fs = require('fs');
const path = require('path');

// No CNAME/custom domain in this repo — this is the default GitHub Pages
// URL for the Psii-Phii/First-Principles remote. Update if that changes.
const BASE_URL = 'https://psii-phii.github.io/First-Principles';

const root = path.join(__dirname, '..');
const articles = JSON.parse(fs.readFileSync(path.join(root, 'content/articles.json'), 'utf8'));

function escapeXML(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function slugOf(a) {
  return a.slug || (a.file || '').replace(/\.(md|tex)$/, '');
}

function rfc822(date) {
  return new Date(date + 'T00:00:00Z').toUTCString();
}

const items = articles
  .filter(a => a.published !== false)
  .slice()
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  .map(a => {
    const link = BASE_URL + '/article.html?p=' + encodeURIComponent(slugOf(a));
    return '    <item>\n' +
      '      <title>' + escapeXML(a.title || slugOf(a)) + '</title>\n' +
      '      <link>' + link + '</link>\n' +
      '      <guid>' + link + '</guid>\n' +
      '      <pubDate>' + rfc822(a.date) + '</pubDate>\n' +
      '      <description>' + escapeXML(a.excerpt) + '</description>\n' +
      '    </item>';
  });

const feed =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<rss version="2.0">\n' +
  '  <channel>\n' +
  '    <title>First Principles</title>\n' +
  '    <link>' + BASE_URL + '/articles.html</link>\n' +
  '    <description>Essays and lecture notes on physics and mathematics.</description>\n' +
  items.join('\n') + '\n' +
  '  </channel>\n' +
  '</rss>\n';

fs.writeFileSync(path.join(root, 'feed.xml'), feed);
console.log('Wrote feed.xml with ' + items.length + ' item(s).');
