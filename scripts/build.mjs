import { readFile, writeFile, mkdir, rm, cp, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs');
const source = path.join(root, 'src');
const dataFile = 'site.json';
const input = path.join(root, 'content', dataFile);
const buildStartedAt = new Date();

const pages = [
  { id: 'about', file: 'index.html', label: 'About me', title: 'About me' },
  { id: 'publications', file: 'publications.html', label: 'Publications', title: 'Publications' },
  { id: 'honors', file: 'honors.html', label: 'Honors & Awards', title: 'Honors & Awards' },
  { id: 'services', file: 'services.html', label: 'Services', title: 'Services' },
  { id: 'contact', file: 'contact.html', label: 'Contact', title: 'Contact' },
  { id: '404', file: '404.html', label: 'Page not found', title: 'Page not found' }
];

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function text(value, fallback = '') {
  return typeof value === 'string' ? (value.trim() || fallback) : fallback;
}

function lines(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function safeURL(value, { absolute = false } = {}) {
  const clean = text(value);
  if (!clean) return '';
  if (/[\u0000-\u0020\\]/u.test(clean)) {
    throw new Error('A URL contains spaces, control characters, or backslashes.');
  }
  const parsed = new URL(clean, 'https://local.invalid/');
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  }
  if (absolute && !/^https?:\/\//i.test(clean)) {
    throw new Error('Expected an absolute HTTP(S) URL.');
  }
  return clean;
}

// Paragraphs can contain plain text and explicit, safely escaped inline links.
// Spaces in text fragments are preserved so links flow naturally within prose.
function biographyParagraphs(value) {
  const paragraphs = typeof value === 'string' ? [value] : (value || []);
  if (!Array.isArray(paragraphs)) throw new Error('profile.biography must be an array.');
  return paragraphs.map((paragraph) => {
    const parts = Array.isArray(paragraph) ? paragraph : [paragraph];
    return parts.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object' || !text(part.text) || !text(part.url)) {
        throw new Error('A biography link needs text and an HTTP(S) URL.');
      }
      return { text: text(part.text), url: safeURL(part.url, { absolute: true }) };
    });
  }).filter((parts) => parts.some((part) => typeof part !== 'string' || part.trim()));
}

function publicationAuthors(value) {
  const authors = typeof value === 'string' ? [value] : (value || []);
  if (!Array.isArray(authors)) throw new Error('Publication authors must be an array.');
  return authors.map((author) => {
    if (typeof author === 'string') return { name: text(author), url: '' };
    if (!author || typeof author !== 'object' || !text(author.name)) {
      throw new Error('A publication author needs a name.');
    }
    return { name: text(author.name), url: safeURL(author.url || '', { absolute: true }) };
  }).filter((author) => author.name);
}

function personLink(label, url) {
  return url
    ? '<a class="person-link" href="' + escapeHTML(url) + '">' + escapeHTML(label) + '</a>'
    : escapeHTML(label);
}

function renderParagraph(parts) {
  return parts.map((part) => typeof part === 'string' ? escapeHTML(part) : personLink(part.text, part.url)).join('');
}

function siteURL(value) {
  const clean = safeURL(value, { absolute: true });
  if (!clean) return '';
  const parsed = new URL(clean);
  if (parsed.search || parsed.hash) throw new Error('site.url must not contain a query string or fragment.');
  return parsed.href.endsWith('/') ? parsed.href : parsed.href + '/';
}

function emailValue(value) {
  const clean = text(value);
  if (!clean) return '';
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/u.test(clean)) {
    throw new Error('contact.email must be a valid email address, or an empty string.');
  }
  return clean;
}

function automaticBuildDate() {
  let instant = buildStartedAt;
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined) {
    const seconds = Number(epoch);
    if (!/^\d+$/u.test(epoch) || !Number.isSafeInteger(seconds)) {
      throw new Error('SOURCE_DATE_EPOCH must be a nonnegative integer number of seconds.');
    }
    instant = new Date(seconds * 1000);
    if (!Number.isFinite(instant.getTime())) throw new Error('SOURCE_DATE_EPOCH is outside the supported date range.');
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tehran'
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function calendarDate(value) {
  let clean = value === undefined ? 'auto' : text(value);
  if (clean === 'auto') clean = automaticBuildDate();
  if (!clean) return null;
  const date = new Date(clean + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(clean) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== clean) {
    throw new Error('site.lastUpdated must be auto, a valid date in YYYY-MM-DD format, or empty.');
  }
  return {
    iso: clean,
    label: new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)
  };
}

function assertRecordList(value, name) {
  if (!Array.isArray(value)) throw new Error(name + ' must be an array.');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(name + ' must contain objects.');
    if (!text(item.title)) throw new Error('Every ' + name + ' entry needs a title.');
  }
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Site content must be a JSON object.');
  const profile = raw.profile || {};
  if (!text(profile.name)) throw new Error('profile.name is required.');
  const result = {
    site: {
      title: text(raw.site?.title, text(profile.name) + ' — Cryptography'),
      description: text(raw.site?.description, 'Academic website of ' + text(profile.name) + '.'),
      url: siteURL(process.env.SITE_URL || raw.site?.url || ''),
      language: text(raw.site?.language, 'en'),
      copyrightYear: Number(raw.site?.copyrightYear) || new Date().getUTCFullYear(),
      lastUpdated: calendarDate(raw.site?.lastUpdated)
    },
    profile: {
      name: text(profile.name),
      role: text(profile.role),
      institution: text(profile.institution),
      institutionUrl: safeURL(profile.institutionUrl || ''),
      biography: biographyParagraphs(profile.biography)
    },
    publications: raw.publications || [],
    honors: raw.honors || [],
    services: raw.services || [],
    contact: {
      email: emailValue(raw.contact?.email || ''),
      emailPlaceholder: text(raw.contact?.emailPlaceholder, 'Email address coming soon.'),
      office: {
        institution: text(raw.contact?.office?.institution),
        group: text(raw.contact?.office?.group),
        address: lines(raw.contact?.office?.address)
      },
      profiles: raw.contact?.profiles || []
    }
  };
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(result.site.language)) {
    throw new Error('site.language must be a language tag such as en or en-GB.');
  }
  assertRecordList(result.publications, 'publications');
  assertRecordList(result.honors, 'honors');
  assertRecordList(result.services, 'services');
  result.publications = result.publications.map((item) => {
    safeURL(item.url || '');
    return { ...item, authors: publicationAuthors(item.authors) };
  });
  if (!Array.isArray(result.contact.profiles)) throw new Error('contact.profiles must be an array.');
  for (const profileLink of result.contact.profiles) {
    if (!text(profileLink.label) || !safeURL(profileLink.url || '')) {
      throw new Error('Each contact.profiles entry needs a label and HTTP(S) URL.');
    }
  }
  return result;
}

async function imageDimensions(filename) {
  const buffer = await readFile(path.join(source, 'assets', 'art', filename));
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('Expected a PNG art asset: ' + filename);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const content = normalize(JSON.parse(await readFile(input, 'utf8')));
const artSizes = {};
const webpArt = new Set();
for (const filename of ['hero.png', 'branch.png', 'publications-pattern.png', 'honors-pattern.png', 'services-pattern.png', 'contact-pattern.png']) {
  try {
    artSizes[filename] = await imageDimensions(filename);
  } catch (error) {
    throw new Error('Missing or invalid artwork src/assets/art/' + filename + '. ' + error.message);
  }
  try {
    await access(path.join(source, 'assets', 'art', filename.replace(/\.png$/u, '.webp')));
    webpArt.add(filename);
  } catch {
    // PNG-only custom artwork remains fully supported.
  }
}

function assetPath(relative, page) {
  if (page.id === '404' && content.site.url) return new URL(relative, content.site.url).href;
  return relative;
}

function image(filename, className, page, loading = 'lazy') {
  const size = artSizes[filename];
  const priority = loading === 'eager' ? ' fetchpriority="high"' : '';
  const fallback = '<img class="' + escapeHTML(className) + '" src="' + escapeHTML(assetPath('assets/art/' + filename, page)) +
    '" width="' + size.width + '" height="' + size.height +
    '" alt="" aria-hidden="true" decoding="async" loading="' + loading + '"' + priority + '>';
  if (!webpArt.has(filename)) return fallback;
  return '<picture aria-hidden="true"><source type="image/webp" srcset="' +
    escapeHTML(assetPath('assets/art/' + filename.replace(/\.png$/u, '.webp'), page)) + '">' + fallback + '</picture>';
}

function navigation(page) {
  const items = pages.filter((item) => item.id !== '404').map((item) => {
    const active = item.id === page.id ? ' aria-current="page"' : '';
    const href = page.id === '404' && content.site.url ? new URL(item.file, content.site.url).href : item.file;
    return '<li><a class="nav-link" href="' + escapeHTML(href) + '"' + active + '>' + escapeHTML(item.label) + '</a></li>';
  }).join('\n');
  return [
    '<header class="site-header">',
    '  <div class="header-inner">',
    '    <button class="menu-toggle" id="menu-toggle" type="button" aria-controls="primary-navigation" aria-expanded="true">',
    '      <span class="menu-label">Menu</span>',
    '      <svg class="menu-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    '    </button>',
    '    <nav class="primary-navigation" id="primary-navigation" aria-label="Primary">',
    '      <ul class="nav-list">' + items + '</ul>',
    '    </nav>',
    '  </div>',
    '</header>'
  ].join('\n');
}

function pageHeader(title) {
  return '<header class="page-header"><h1>' + escapeHTML(title) + '</h1></header>';
}

function renderAbout(page) {
  const institution = content.profile.institutionUrl
    ? '<a href="' + escapeHTML(content.profile.institutionUrl) + '">' + escapeHTML(content.profile.institution) + '</a>'
    : escapeHTML(content.profile.institution);
  return [
    '<div class="content-wrap">',
    '  <section class="about-intro" aria-labelledby="about-name">',
    '    <h1 class="display-name" id="about-name">' + escapeHTML(content.profile.name) + '</h1>',
    content.profile.role ? '    <p class="role">' + escapeHTML(content.profile.role) + '</p>' : '',
    content.profile.institution ? '    <p class="institution">' + institution + '</p>' : '',
    '    <div class="biography">' + content.profile.biography.map((paragraph) => '<p>' + renderParagraph(paragraph) + '</p>').join('\n') + '</div>',
    '  </section>',
    '</div>',
    image('hero.png', 'art art-hero', page, 'eager')
  ].join('\n');
}

function groupByYear(records) {
  const groups = new Map();
  for (const record of records) {
    const year = String(record.year ?? '').trim() || 'Undated';
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(record);
  }
  return [...groups.entries()].sort(([first], [second]) => {
    if (first === 'Undated') return 1;
    if (second === 'Undated') return -1;
    return second.localeCompare(first, 'en', { numeric: true });
  });
}

function renderGroups(records, kind) {
  if (!records.length) {
    const message = kind === 'publications' ? 'Publications will be added here.' : 'Honors and awards will be added here.';
    return '<p class="empty-state">' + message + '</p>';
  }
  return '<div class="year-list">' + groupByYear(records).map(([year, items], groupIndex) => {
    const id = kind + '-year-' + groupIndex;
    return [
      '<section class="year-group" aria-labelledby="' + id + '">',
      '<h2 class="year-label" id="' + id + '">' + escapeHTML(year) + '</h2>',
      '<div class="year-entries">',
      items.map((item) => {
        let title = escapeHTML(item.title);
        if (kind === 'publications' && text(item.url)) title = '<a href="' + escapeHTML(safeURL(item.url)) + '">' + title + '</a>';
        const metadata = kind === 'publications'
          ? [
              item.authors.length ? '<p class="entry-authors">' + item.authors.map((author) => personLink(author.name, author.url)).join(', ') + '</p>' : '',
              [text(item.venue), text(item.status)].filter(Boolean).length
                ? '<p class="entry-meta">' + [text(item.venue), text(item.status)].filter(Boolean).map(escapeHTML).join(' · ') + '</p>' : ''
            ]
          : [
              text(item.institution) ? '<p class="entry-meta">' + escapeHTML(item.institution) + '</p>' : '',
              ...lines(item.description).map((paragraph) => '<p class="entry-description">' + escapeHTML(paragraph) + '</p>')
            ];
        return '<article class="entry"><h3 class="entry-title">' + title + '</h3>' + metadata.join('\n') + '</article>';
      }).join('\n'),
      '</div></section>'
    ].join('\n');
  }).join('\n') + '</div>';
}

function renderPublications(page) {
  return [
    '<div class="content-wrap">',
    pageHeader('Publications'),
    renderGroups(content.publications, 'publications'),
    '</div>',
    image('publications-pattern.png', 'art art-publications', page)
  ].join('\n');
}

function renderHonors(page) {
  return [
    '<div class="content-wrap">',
    pageHeader('Honors & Awards'),
    renderGroups(content.honors, 'honors'),
    '</div>',
    image('honors-pattern.png', 'art art-honors', page)
  ].join('\n');
}

function renderServices(page) {
  const rows = content.services.map((service) => {
    return '<article class="service-row"><h2 class="service-title">' + escapeHTML(service.title) +
      '</h2><div class="service-description">' + lines(service.description).map((paragraph) => '<p>' + escapeHTML(paragraph) + '</p>').join('\n') +
      '</div></article>';
  }).join('\n');
  return [
    '<div class="content-wrap">',
    pageHeader('Services'),
    content.services.length ? '<div class="service-list">' + rows + '</div>' : '<p class="empty-state">Details of services and academic activities will be added here.</p>',
    '</div>',
    image('services-pattern.png', 'art art-services', page)
  ].join('\n');
}

function renderContact(page) {
  const email = content.contact.email;
  const emailDetails = email
    ? '<div class="email-actions"><a class="email-link" href="mailto:' + escapeHTML(encodeURIComponent(email)) +
      '" data-copy-email="' + escapeHTML(email) + '" data-copy-status="copy-email-status">' + escapeHTML(email) + '</a>' +
      '<span class="copy-status" id="copy-email-status" role="status" aria-live="polite"></span></div>'
    : '<span class="placeholder contact-placeholder">' + escapeHTML(content.contact.emailPlaceholder) + '</span>';
  const officeLines = [
    content.contact.office.institution,
    content.contact.office.group,
    ...content.contact.office.address
  ].filter(Boolean);
  const office = officeLines.length ? '<div class="contact-row"><dt>Office</dt><dd>' + officeLines.map((line) => '<p>' + escapeHTML(line) + '</p>').join('\n') + '</dd></div>' : '';
  const profiles = content.contact.profiles.length
    ? '<div class="contact-row"><dt>Elsewhere</dt><dd><ul class="profile-links">' + content.contact.profiles.map((profile) => '<li><a href="' +
      escapeHTML(safeURL(profile.url)) + '">' + escapeHTML(profile.label) + '</a></li>').join('\n') + '</ul></dd></div>'
    : '';
  return [
    '<div class="content-wrap">',
    pageHeader('Contact'),
    '<dl class="contact-list">',
    '<div class="contact-row"><dt>Email</dt><dd>' + emailDetails + '</dd></div>',
    office,
    profiles,
    '</dl>',
    '</div>',
    image('contact-pattern.png', 'art art-contact', page)
  ].join('\n');
}

function renderNotFound(page) {
  const home = content.site.url ? new URL('index.html', content.site.url).href : 'index.html';
  return [
    '<div class="content-wrap">',
    '<div class="not-found">',
    '<p class="eyebrow">404</p>',
    '<h1>Page not found</h1>',
    '<p>The page may have moved, or the address may be incorrect.</p>',
    '<a class="text-link" href="' + escapeHTML(home) + '">Return to About me <span aria-hidden="true">↗</span></a>',
    '</div>',
    '</div>',
    image('branch.png', 'art art-not-found', page)
  ].join('\n');
}

const renderers = {
  about: renderAbout,
  publications: renderPublications,
  honors: renderHonors,
  services: renderServices,
  contact: renderContact,
  '404': renderNotFound
};

const descriptions = {
  about: content.site.description,
  publications: 'Publications and preprints by ' + content.profile.name + '.',
  honors: 'Honors and awards of ' + content.profile.name + '.',
  services: 'Services and academic activities of ' + content.profile.name + '.',
  contact: 'Contact information for ' + content.profile.name + '.',
  '404': 'The requested page could not be found.'
};

function renderDocument(page) {
  const title = page.title + ' — ' + content.profile.name;
  const canonical = content.site.url ? new URL(page.file, content.site.url).href : '';
  const imageURL = content.site.url ? new URL('assets/art/hero.png', content.site.url).href : 'assets/art/hero.png';
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";
  return [
    '<!doctype html>',
    '<html lang="' + escapeHTML(content.site.language) + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="' + escapeHTML(csp) + '">',
    '<meta name="color-scheme" content="light">',
    '<meta name="theme-color" content="#ffffff">',
    '<title>' + escapeHTML(title) + '</title>',
    '<meta name="description" content="' + escapeHTML(descriptions[page.id]) + '">',
    page.id === '404' ? '<meta name="robots" content="noindex">' : '',
    canonical ? '<link rel="canonical" href="' + escapeHTML(canonical) + '">' : '',
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="' + escapeHTML(title) + '">',
    '<meta property="og:description" content="' + escapeHTML(descriptions[page.id]) + '">',
    '<meta property="og:site_name" content="' + escapeHTML(content.site.title) + '">',
    canonical ? '<meta property="og:url" content="' + escapeHTML(canonical) + '">' : '',
    '<meta property="og:image" content="' + escapeHTML(imageURL) + '">',
    '<meta property="og:image:alt" content="Blue, turquoise, and red Persian-inspired floral ornament on white.">',
    '<meta name="twitter:card" content="summary">',
    '<link rel="icon" href="' + escapeHTML(assetPath('favicon.svg', page)) + '" type="image/svg+xml">',
    '<link rel="manifest" href="' + escapeHTML(assetPath('site.webmanifest', page)) + '">',
    '<link rel="preload" href="' + escapeHTML(assetPath('assets/fonts/academic-sans.ttf', page)) + '" as="font" type="font/ttf" crossorigin>',
    '<link rel="stylesheet" href="' + escapeHTML(assetPath('assets/styles.css', page)) + '">',
    '<script src="' + escapeHTML(assetPath('assets/site.js', page)) + '" defer></script>',
    '</head>',
    '<body data-page="' + page.id + '">',
    '<a class="skip-link" href="#main">Skip to content</a>',
    navigation(page),
    '<main id="main" class="site-main page-' + page.id + '" tabindex="-1">',
    renderers[page.id](page),
    '</main>',
    '<footer class="site-footer"><div class="footer-inner"><p>© ' + content.site.copyrightYear + ' ' + escapeHTML(content.profile.name) + '</p>',
    content.site.lastUpdated ? '<p class="footer-updated">Last updated <time datetime="' + escapeHTML(content.site.lastUpdated.iso) + '">' + escapeHTML(content.site.lastUpdated.label) + '</time></p>' : '',
    '<button class="back-to-top" type="button" data-back-to-top hidden>Back to top <span aria-hidden="true">↑</span></button></div></footer>',
    '</body>',
    '</html>',
    ''
  ].filter((line) => line !== '').join('\n');
}

for (const required of ['styles.css', 'site.js']) {
  try {
    await access(path.join(source, required));
  } catch {
    throw new Error('Missing src/' + required + '. Add the site source files before building.');
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'assets'), { recursive: true });
await cp(path.join(source, 'assets'), path.join(output, 'assets'), { recursive: true });
await cp(path.join(source, 'styles.css'), path.join(output, 'assets', 'styles.css'));
await cp(path.join(source, 'site.js'), path.join(output, 'assets', 'site.js'));

for (const page of pages) await writeFile(path.join(output, page.file), renderDocument(page), 'utf8');

const favicon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#fff"/><g fill="#164a8a"><ellipse cx="32" cy="19" rx="8" ry="14"/><ellipse cx="32" cy="45" rx="8" ry="14"/><ellipse cx="19" cy="32" rx="14" ry="8"/><ellipse cx="45" cy="32" rx="14" ry="8"/></g><g fill="#22a6a3"><ellipse cx="23" cy="23" rx="6" ry="10" transform="rotate(-45 23 23)"/><ellipse cx="41" cy="41" rx="6" ry="10" transform="rotate(-45 41 41)"/><ellipse cx="41" cy="23" rx="6" ry="10" transform="rotate(45 41 23)"/><ellipse cx="23" cy="41" rx="6" ry="10" transform="rotate(45 23 41)"/></g><circle cx="32" cy="32" r="9" fill="#fff"/><circle cx="32" cy="32" r="4" fill="#ba2e42"/></svg>';
await writeFile(path.join(output, 'favicon.svg'), favicon + '\n', 'utf8');
await writeFile(path.join(output, '.nojekyll'), '', 'utf8');
await writeFile(path.join(output, 'site.webmanifest'), JSON.stringify({
  name: content.site.title,
  short_name: content.profile.name,
  description: content.site.description,
  lang: content.site.language,
  start_url: './index.html',
  scope: './',
  display: 'browser',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
}, null, 2) + '\n', 'utf8');

if (content.site.url) {
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.filter((page) => page.id !== '404').map((page) => '  <url><loc>' + escapeHTML(new URL(page.file, content.site.url).href) + '</loc></url>').join('\n') +
    '\n</urlset>\n';
  await writeFile(path.join(output, 'sitemap.xml'), sitemap, 'utf8');
  await writeFile(path.join(output, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: ' + new URL('sitemap.xml', content.site.url).href + '\n', 'utf8');
}

console.log('Built ' + pages.length + ' accessible static pages in docs/ from content/' + dataFile + '.');
if (!content.site.url) console.log('Optional: set site.url for canonical URLs, sitemap.xml, and absolute 404-page asset links.');
