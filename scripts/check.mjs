import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs');
const pages = ['index.html', 'publications.html', 'honors.html', 'services.html', 'contact.html', '404.html'];
const requiredNavigation = ['About me', 'Publications', 'Honors & Awards', 'Services', 'Contact'];
const titles = new Set();
const descriptions = new Set();
let localReferenceCount = 0;
let imageCount = 0;

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeEntities(match[2]) : undefined;
}

async function assertFile(filename, context) {
  const resolved = path.resolve(output, filename);
  assert(resolved.startsWith(`${output}${path.sep}`), `${context}: path escapes docs/: ${filename}`);
  const details = await stat(resolved).catch(() => null);
  assert(details?.isFile(), `${context}: missing local file ${filename}`);
  return resolved;
}

async function checkReference(value, fromFile, context) {
  assert(value.trim(), `${context}: empty URL`);
  const cleaned = decodeEntities(value.trim());
  assert(!/[\u0000-\u001f\u007f]/.test(cleaned), `${context}: control characters in URL`);
  assert(!/^javascript:/i.test(cleaned), `${context}: unsafe JavaScript URL`);
  if (/^(?:https?:|mailto:|tel:|data:)/i.test(cleaned)) return;
  assert(!/^[a-z][a-z\d+.-]*:/i.test(cleaned), `${context}: unsupported URL scheme`);
  assert(!cleaned.startsWith('//'), `${context}: use an explicit https: URL`);

  if (cleaned.startsWith('#')) {
    const id = decodeURIComponent(cleaned.slice(1));
    if (id) {
      const html = await readFile(path.join(output, fromFile), 'utf8');
      assert(html.includes(`id="${id}"`) || html.includes(`id='${id}'`), `${context}: missing fragment #${id}`);
    }
    return;
  }

  // A relative reference must stay inside both a root site and a project site.
  // A leading /assets/... or /index.html would fail the project-site test.
  for (const prefix of ['', 'project-site/']) {
    const base = new URL(`${prefix}${fromFile}`, 'https://example.test/');
    const resolved = new URL(cleaned, base);
    assert.equal(resolved.origin, base.origin, `${context}: unexpected external relative URL`);
    assert(resolved.pathname.startsWith(`/${prefix}`), `${context}: URL breaks a GitHub project path: ${cleaned}`);
    const relative = decodeURIComponent(resolved.pathname.slice(prefix.length + 1));
    await assertFile(relative || 'index.html', context);
  }
  localReferenceCount += 1;
}

const config = JSON.parse(await readFile(path.join(root, 'content/site.json'), 'utf8'));
assert(config && typeof config === 'object' && !Array.isArray(config), 'site.json must be an object');
assert(config.profile && typeof config.profile.name === 'string' && config.profile.name.trim(), 'profile.name must be populated');
assert(config.site && typeof config.site.title === 'string' && config.site.title.trim(), 'site.title must be populated');
for (const name of ['publications', 'honors', 'services']) {
  assert(Array.isArray(config[name]), `${name} must be an array`);
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(Object.keys(packageJson.dependencies ?? {}).length, 0, 'This project must remain dependency-free');

for (const filename of pages) {
  const html = await readFile(await assertFile(filename, filename), 'utf8');
  assert(/<!doctype html>/i.test(html), `${filename}: missing HTML doctype`);
  assert(/<html\b[^>]*\blang=["'][^"']+["']/i.test(html), `${filename}: missing document language`);
  assert(/<meta\b[^>]*name=["']viewport["']/i.test(html), `${filename}: missing responsive viewport`);

  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  assert(title && !titles.has(title), `${filename}: title must be nonempty and unique`);
  titles.add(title);
  const descriptionTag = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]).find(tag => attribute(tag, 'name') === 'description');
  const description = descriptionTag && attribute(descriptionTag, 'content')?.trim();
  assert(description && !descriptions.has(description), `${filename}: description must be nonempty and unique`);
  descriptions.add(description);

  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1, `${filename}: expected one primary heading`);
  assert(/<main\b[^>]*\bid=["']main["']/i.test(html), `${filename}: missing main landmark target`);
  assert(/<a\b[^>]*class=["'][^"']*skip-link[^"']*["'][^>]*href=["']#main["']|<a\b[^>]*href=["']#main["'][^>]*class=["'][^"']*skip-link/i.test(html), `${filename}: missing skip link`);

  const toggle = [...html.matchAll(/<button\b[^>]*>/gi)].map(match => match[0]).find(tag => attribute(tag, 'id') === 'menu-toggle');
  assert(toggle, `${filename}: missing menu toggle`);
  assert.equal(attribute(toggle, 'aria-controls'), 'primary-navigation', `${filename}: menu controls missing`);
  assert(['true', 'false'].includes(attribute(toggle, 'aria-expanded')), `${filename}: menu expanded state missing`);
  const nav = html.match(/<nav\b[^>]*\bid=["']primary-navigation["'][\s\S]*?<\/nav>/i)?.[0];
  assert(nav, `${filename}: missing primary navigation`);
  for (const label of requiredNavigation) assert(decodeEntities(nav).includes(label), `${filename}: navigation label missing: ${label}`);
  if (filename !== '404.html') assert.equal((nav.match(/aria-current=["']page["']/gi) ?? []).length, 1, `${filename}: expected one active navigation link`);

  for (const match of html.matchAll(/<(?:a|link|script|img|source)\b[^>]*>/gi)) {
    const tag = match[0];
    const value = attribute(tag, /^<script|^<img|^<source/i.test(tag) ? 'src' : 'href');
    if (value !== undefined) await checkReference(value, filename, `${filename}: ${tag.slice(0, 90)}`);
    const srcset = attribute(tag, 'srcset');
    if (srcset) {
      for (const candidate of srcset.split(',')) {
        await checkReference(candidate.trim().split(/\s+/)[0], filename, `${filename}: responsive image source`);
      }
    }
    if (/^<a\b/i.test(tag) && attribute(tag, 'target') === '_blank') {
      assert((attribute(tag, 'rel') ?? '').split(/\s+/).includes('noopener'), `${filename}: external new-tab link needs rel=noopener`);
    }
    if (/^<img\b/i.test(tag)) {
      assert(attribute(tag, 'alt') !== undefined, `${filename}: image alt attribute missing`);
      if (attribute(tag, 'alt') === '') assert.equal(attribute(tag, 'aria-hidden'), 'true', `${filename}: decorative image must be hidden from screen readers`);
      imageCount += 1;
    }
  }

  if (filename === 'publications.html') {
    assert(!/>\s*(?:PDF|ePrint|BibTeX)(?:\s|↗|<)/i.test(html), 'Publications must not reintroduce resource-link rows');
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}

for (const filename of await walk(output)) {
  if (filename.endsWith('.css')) {
    const css = await readFile(filename, 'utf8');
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      await checkReference(match[1], path.relative(output, filename).split(path.sep).join('/'), 'CSS asset');
    }
  }
}

execFileSync(process.execPath, ['--check', path.join(output, 'assets/site.js')], { stdio: 'pipe' });
console.log(`Static checks passed: ${pages.length} pages, ${localReferenceCount} local references, ${imageCount} decorative images.`);
console.log('Verified relative navigation and assets for both root and project GitHub Pages URLs.');
