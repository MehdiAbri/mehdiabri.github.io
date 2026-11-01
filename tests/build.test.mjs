import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalContent = JSON.parse(await readFile(path.join(projectRoot, 'content/site.json'), 'utf8'));
const temporaryProjects = [];

// Every build runs against its own complete, disposable source tree. These tests
// never replace the working checkout's content or generated docs directory.
async function fixture(change = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'minakari-build-test-'));
  temporaryProjects.push(directory);
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await mkdir(path.join(directory, 'content'), { recursive: true });
  await copyFile(path.join(projectRoot, 'scripts/build.mjs'), path.join(directory, 'scripts/build.mjs'));
  await cp(path.join(projectRoot, 'src'), path.join(directory, 'src'), { recursive: true });
  const content = structuredClone(originalContent);
  await change(content);
  await writeFile(path.join(directory, 'content/site.json'), JSON.stringify(content), 'utf8');
  return directory;
}

function build(directory, { env = {}, args = [] } = {}) {
  return spawnSync(process.execPath, ['scripts/build.mjs', ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, SITE_URL: '', ...env }
  });
}

function requireSuccess(result) {
  assert.equal(result.status, 0, `Build failed:\n${result.stdout}\n${result.stderr}`);
}

function page(directory, filename) {
  return readFile(path.join(directory, 'docs', filename), 'utf8');
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  await Promise.all(temporaryProjects.map((directory) => rm(directory, { recursive: true, force: true })));
});

test('user-supplied markup is rendered as text in content and metadata', async () => {
  const maliciousText = '<script>alert("x")</script> & \'quote\'';
  const directory = await fixture((content) => {
    content.profile.name = maliciousText;
    content.profile.role = maliciousText;
    content.profile.institution = maliciousText;
    content.profile.biography = [maliciousText];
    content.site.title = maliciousText;
    content.site.description = maliciousText;
    content.publications = [{
      year: 2026,
      title: maliciousText,
      authors: [maliciousText],
      venue: maliciousText,
      status: maliciousText,
      url: 'https://example.org/paper?a=1&b=2'
    }];
    content.honors = [{ year: 2026, title: maliciousText, institution: maliciousText, description: [maliciousText] }];
    content.services = [{ title: maliciousText, description: [maliciousText] }];
    content.contact.profiles = [{ label: maliciousText, url: 'https://example.org/profile?a=1&b=2' }];
  });
  requireSuccess(build(directory));

  const expectedText = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;';
  for (const filename of ['index.html', 'publications.html', 'honors.html', 'services.html', 'contact.html']) {
    const html = await page(directory, filename);
    assert.ok(html.includes(expectedText), `${filename} should contain escaped user text`);
    assert.ok(!html.includes(maliciousText), `${filename} must not contain raw supplied markup`);
    assert.ok(!html.includes('<script>alert'), `${filename} must not execute supplied script markup`);
    assert.match(html, /<meta name="description" content="[^"<>]+">/u);
  }
  assert.ok((await page(directory, 'publications.html')).includes('href="https://example.org/paper?a=1&amp;b=2"'));
  assert.ok((await page(directory, 'contact.html')).includes('href="https://example.org/profile?a=1&amp;b=2"'));
});

test('unsafe URL schemes, control characters, credentials and invalid site bases fail the build', async (t) => {
  const cases = [
    ['institution javascript URL', (content) => { content.profile.institutionUrl = 'javascript:alert(1)'; }],
    ['publication data URL', (content) => { content.publications[0].url = 'data:text/html,<script>alert(1)</script>'; }],
    ['publication embedded credentials', (content) => { content.publications[0].url = 'https://user:password@example.org/paper'; }],
    ['profile URL with a control character', (content) => { content.contact.profiles = [{ label: 'Profile', url: 'java\nscript:alert(1)' }]; }],
    ['relative canonical base', (content) => { content.site.url = '/repository/'; }],
    ['canonical base containing query parameters', (content) => { content.site.url = 'https://example.org/repository/?tracking=1'; }],
    ['canonical base containing a fragment', (content) => { content.site.url = 'https://example.org/repository/#section'; }]
  ];

  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const directory = await fixture(change);
      const result = build(directory);
      assert.notEqual(result.status, 0, 'The invalid content should be rejected');
      assert.match(result.stderr, /URL|site\.url/u);
      assert.equal(await exists(path.join(directory, 'docs/index.html')), false, 'No deployable page should be emitted');
    });
  }
});

test('inline biography and author links preserve prose, escape labels, and support plain text', async () => {
  const label = '<img src=x onerror="alert(1)"> & Name';
  const url = 'https://example.org/person?a=1&b=2';
  const directory = await fixture((content) => {
    content.profile.biography = [['Before ', { text: label, url }, ' after.'], 'A plain second paragraph.'];
    content.publications = [{ title: 'A paper', authors: ['Plain Author', { name: label, url }] }];
  });
  requireSuccess(build(directory));
  const escapedLink = '<a class="person-link" href="https://example.org/person?a=1&amp;b=2">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Name</a>';
  const about = await page(directory, 'index.html');
  const publications = await page(directory, 'publications.html');
  assert.ok(about.includes('<p>Before ' + escapedLink + ' after.</p>'));
  assert.ok(about.includes('<p>A plain second paragraph.</p>'));
  assert.ok(publications.includes('<p class="entry-authors">Plain Author, ' + escapedLink + '</p>'));
  assert.ok(!about.includes('<img src=x'));
  assert.ok(!publications.includes('[object Object]'));
});

test('biography and author homepages reject unsafe or relative URLs before emitting pages', async (t) => {
  for (const url of ['javascript:alert(1)', 'https://user:password@example.org/', '/relative-person']) {
    for (const field of ['biography', 'authors']) {
      await t.test(field + ': ' + url, async () => {
        const directory = await fixture((content) => {
          if (field === 'biography') content.profile.biography = [[{ text: 'Person', url }]];
          else content.publications[0].authors = [{ name: 'Person', url }];
        });
        const result = build(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /URL/u);
        assert.equal(await exists(path.join(directory, 'docs/index.html')), false);
      });
    }
  }
});

test('missing email renders honest noninteractive placeholder text', async () => {
  const directory = await fixture((content) => {
    content.contact.email = '';
    content.contact.emailPlaceholder = '[Email address]';
  });
  requireSuccess(build(directory));
  const html = await page(directory, 'contact.html');
  assert.match(html, /<span class="placeholder contact-placeholder">\[Email address\]<\/span>/u);
  assert.ok(!html.includes('href="mailto:'));
  assert.ok(!html.includes('data-copy-email='));
  assert.ok(!html.includes('Copy email</button>'));
});

test('configured email is the copy target, retains a mailto fallback, and has live feedback', async () => {
  const directory = await fixture((content) => {
    content.contact.email = 'ada+crypto@example.org';
    content.contact.office.address = ['First address line', 'Second address line'];
  });
  requireSuccess(build(directory));
  const html = await page(directory, 'contact.html');
  assert.ok(html.includes('href="mailto:ada%2Bcrypto%40example.org"'));
  assert.ok(html.includes('data-copy-email="ada+crypto@example.org"'));
  assert.match(html, /<a class="email-link"[^>]+data-copy-email="ada\+crypto@example\.org"[^>]*>ada\+crypto@example\.org<\/a>/u);
  assert.ok(!html.includes('<button class="copy-email'));
  assert.ok(!html.includes('Copy email</button>'));
  assert.equal((html.match(/data-copy-email=/gu) || []).length, 1);
  assert.match(html, /id="copy-email-status" role="status" aria-live="polite"/u);
  assert.ok(html.includes('<p>First address line</p>\n<p>Second address line</p>'));
});

test('malformed or newline-containing email cannot create an interactive contact link', async (t) => {
  for (const email of ['not-an-email', 'name@example.org\nBcc:other@example.org', 'name@<example.org>']) {
    await t.test(JSON.stringify(email), async () => {
      const directory = await fixture((content) => { content.contact.email = email; });
      const result = build(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /contact\.email/u);
    });
  }
});

test('empty record arrays and absent office data produce usable empty states', async () => {
  const directory = await fixture((content) => {
    content.publications = [];
    content.honors = [];
    content.services = [];
    content.profile.biography = [];
    content.contact.profiles = [];
    content.contact.office = { institution: '', group: '', address: [] };
  });
  requireSuccess(build(directory));
  const publications = await page(directory, 'publications.html');
  const honors = await page(directory, 'honors.html');
  const services = await page(directory, 'services.html');
  const contact = await page(directory, 'contact.html');
  assert.ok(publications.includes('Publications will be added here.'));
  assert.ok(honors.includes('Honors and awards will be added here.'));
  assert.ok(services.includes('Details of services and academic activities will be added here.'));
  for (const html of [publications, honors]) {
    assert.ok(!html.includes('class="entry"'));
    assert.ok(!html.includes('class="year-label"'));
  }
  assert.ok(!services.includes('class="service-row"'));
  assert.ok(!contact.includes('<dt>Office</dt>'));
  assert.ok(!contact.includes('<dt>Elsewhere</dt>'));
});

test('year groups sort numerically newest first, retain record order, and put undated entries last', async () => {
  const directory = await fixture((content) => {
    content.publications = [
      { year: 2019, title: 'Old record' },
      { year: 2026, title: 'First record in 2026' },
      { year: 2024, title: 'Middle record' },
      { year: 2026, title: 'Second record in 2026' },
      { title: 'Undated record' },
      { year: '2030', title: 'Newest record' }
    ];
  });
  requireSuccess(build(directory));
  const html = await page(directory, 'publications.html');
  const years = [...html.matchAll(/<h2 class="year-label"[^>]*>([^<]+)<\/h2>/gu)].map((match) => match[1]);
  assert.deepEqual(years, ['2030', '2026', '2024', '2019', 'Undated']);
  assert.ok(html.indexOf('First record in 2026') < html.indexOf('Second record in 2026'));
  assert.ok(!html.includes('BibTeX'));
  assert.ok(!html.includes('ePrint'));
  assert.ok(!html.includes('PDF'));
});

test('unset public URL preserves portable relative links for root and repository Pages sites', async () => {
  const directory = await fixture((content) => { content.site.url = ''; });
  requireSuccess(build(directory));
  const html = await page(directory, 'index.html');
  assert.ok(html.includes('href="assets/styles.css"'));
  assert.ok(html.includes('src="assets/site.js"'));
  assert.ok(html.includes('href="publications.html"'));
  assert.ok(html.includes('src="assets/art/hero.png"'));
  assert.ok(!html.includes('https://local.invalid'));
  assert.ok(!html.includes('rel="canonical"'));
  assert.equal(await exists(path.join(directory, 'docs/sitemap.xml')), false);
  assert.equal(await exists(path.join(directory, 'docs/robots.txt')), false);
  const manifest = JSON.parse(await readFile(path.join(directory, 'docs/site.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './index.html');
  assert.equal(manifest.scope, './');
});

test('SITE_URL generates deep-404-safe absolute resources, navigation and sitemap URLs', async () => {
  const directory = await fixture((content) => { content.site.url = 'https://ignored.example/'; });
  requireSuccess(build(directory, { env: { SITE_URL: 'https://researcher.github.io/crypto' } }));
  const html = await page(directory, '404.html');
  const base = 'https://researcher.github.io/crypto/';
  for (const resource of ['assets/styles.css', 'assets/site.js', 'assets/art/branch.png', 'favicon.svg', 'site.webmanifest']) {
    assert.ok(html.includes(base + resource), `${resource} must resolve from a nested not-found URL`);
  }
  for (const filename of ['index.html', 'publications.html', 'honors.html', 'services.html', 'contact.html']) {
    assert.ok(html.includes(`href="${base}${filename}"`));
  }
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!html.includes('href="index.html"'));
  assert.ok(!html.includes('https://ignored.example/'));
  const index = await page(directory, 'index.html');
  assert.ok(index.includes(`<link rel="canonical" href="${base}index.html">`));
  assert.ok(index.includes('href="assets/styles.css"'), 'Normal pages should retain portable relative resources');
  const sitemap = await readFile(path.join(directory, 'docs/sitemap.xml'), 'utf8');
  assert.equal((sitemap.match(/<loc>/gu) || []).length, 5);
  assert.ok(!sitemap.includes('404.html'));
  assert.ok(sitemap.includes(`<loc>${base}contact.html</loc>`));
  assert.ok((await readFile(path.join(directory, 'docs/robots.txt'), 'utf8')).includes(`Sitemap: ${base}sitemap.xml`));
});

test('the generated pages retain progressive-enhancement and decorative-image accessibility', async () => {
  const directory = await fixture();
  requireSuccess(build(directory));
  for (const filename of ['index.html', 'publications.html', 'honors.html', 'services.html', 'contact.html', '404.html']) {
    const html = await page(directory, filename);
    assert.ok(html.includes('<a class="skip-link" href="#main">Skip to content</a>'));
    assert.match(html, /<main id="main"[^>]+tabindex="-1"/u);
    assert.ok(html.includes('aria-controls="primary-navigation" aria-expanded="true"'), 'No-JS navigation starts available');
    assert.ok(html.includes('<ul class="nav-list">'));
    assert.ok(!html.includes('role="menubar"'));
    const imageTags = html.match(/<img\b[^>]*>/gu) || [];
    assert.ok(imageTags.length > 0);
    imageTags.forEach((tag) => {
      assert.ok(tag.includes('alt=""'));
      assert.ok(tag.includes('aria-hidden="true"'));
      assert.match(tag, /width="\d+" height="\d+"/u);
    });
    assert.ok(html.includes('name="viewport" content="width=device-width, initial-scale=1"'));
    assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
  }
});

test('automatic footer dates change on a later build and use the Tehran calendar day', async () => {
  const directory = await fixture((content) => { content.site.lastUpdated = 'auto'; });
  const snapshots = [
    ['2026-10-31T19:59:00Z', '2026-10-31', 'October 31, 2026'],
    ['2026-10-31T21:00:00Z', '2026-11-01', 'November 1, 2026']
  ];
  for (const [instant, iso, label] of snapshots) {
    requireSuccess(build(directory, { env: { SOURCE_DATE_EPOCH: String(Date.parse(instant) / 1000) } }));
    for (const filename of ['index.html', 'publications.html', 'honors.html', 'services.html', 'contact.html', '404.html']) {
      assert.ok((await page(directory, filename)).includes('<time datetime="' + iso + '">' + label + '</time>'), filename);
    }
  }
});

test('fixed footer dates remain stable across build instants and an empty setting hides the date', async () => {
  const fixed = await fixture((content) => { content.site.lastUpdated = '2026-10-31'; });
  for (const instant of ['2026-10-31T21:00:00Z', '2030-01-02T00:00:00Z']) {
    requireSuccess(build(fixed, { env: { SOURCE_DATE_EPOCH: String(Date.parse(instant) / 1000) } }));
    assert.ok((await page(fixed, 'index.html')).includes('<time datetime="2026-10-31">October 31, 2026</time>'));
  }
  const hidden = await fixture((content) => { content.site.lastUpdated = ''; });
  requireSuccess(build(hidden));
  assert.ok(!(await page(hidden, 'index.html')).includes('Last updated'));
});
