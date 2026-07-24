'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const matter = require('gray-matter');

/** @type {any} Native CommonJS boundary until this test is migrated. */
const identityModule = require('../scripts/article-identity.ts');
const {
    IdentityValidationError,
    compareBindingHistory,
} = identityModule;
/** @type {any} Native CommonJS boundary until this test is migrated. */
const parserModule = require('../scripts/parse-articles.ts');
const { buildArticles } = parserModule;

const ID_A = '08828ec8b0719d4ae2ae640a6dd4867d';
const ID_B = '339243802597e8c42bcddfb10b5e94e3';
const ID_NEW = '018f0f9567d37b908b255f9f9e913901';
const HYPHENATED_UUID = '018f0f95-67d3-7b90-8b25-5f9f9e913901';

function sourceMarkdown(
    title,
    body = '本文\n',
    extra = {},
    articleId = ID_A,
) {
    return matter.stringify(body, {
        article_id: articleId,
        title,
        emoji: '🌃',
        type: 'tech',
        tags: ['test'],
        ...extra,
    });
}

function targetMarkdown(title, body = '本文\n') {
    return matter.stringify(body, {
        title,
        emoji: '🌃',
        type: 'tech',
        topics: ['test'],
        published: true,
    });
}

function zennManifestEntry(
    articleId,
    file,
    overrides = {},
) {
    return {
        article_id: articleId,
        source: `articles/share/${file}`,
        article_state: 'active',
        targets: {
            qiita: { desired: 'published' },
            zenn: { desired: 'published' },
        },
        ...overrides,
    };
}

function createFixture(t, options = {}) {
    const repoRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zenn-identity-test-'),
    );
    const sourceDir = path.join(repoRoot, 'pre-publish');
    const targetDir = path.join(repoRoot, 'articles');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const bindings =
        options.bindings === undefined
            ? {
                  [ID_A]: {
                      slug: ID_A,
                      lifecycle: 'active',
                  },
              }
            : options.bindings;
    fs.writeFileSync(
        path.join(repoRoot, 'article-map.json'),
        `${JSON.stringify(
            {
                schema_version: 1,
                platform: 'zenn',
                bindings,
            },
            null,
            2,
        )}\n`,
    );

    const manifestArticles =
        options.manifestArticles === undefined
            ? [zennManifestEntry(ID_A, 'article-a.md')]
            : options.manifestArticles;
    fs.writeFileSync(
        path.join(sourceDir, 'manifest.json'),
        `${JSON.stringify(
            {
                schema_version: 1,
                articles: manifestArticles,
            },
            null,
            2,
        )}\n`,
    );

    const sources =
        options.sources === undefined
            ? {
                  'article-a.md': sourceMarkdown('Article A'),
              }
            : options.sources;
    for (const [file, content] of Object.entries(sources)) {
        fs.writeFileSync(path.join(sourceDir, file), content);
    }

    const targets =
        options.targets === undefined
            ? {
                  [`${ID_A}.md`]: targetMarkdown('Article A'),
              }
            : options.targets;
    for (const [file, content] of Object.entries(targets)) {
        fs.writeFileSync(path.join(targetDir, file), content);
    }

    return { repoRoot, sourceDir, targetDir };
}

function captureIdentityError(callback) {
    try {
        callback();
    } catch (error) {
        assert.ok(error instanceof IdentityValidationError);
        return error;
    }
    assert.fail('Expected IdentityValidationError');
}

function diagnosticCodes(error) {
    return new Set(error.diagnostics.map((item) => item.code));
}

function sha256(filePath) {
    return crypto
        .createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');
}

function runGitQuiet(repoRoot, args) {
    execFileSync('git', args, {
        cwd: repoRoot,
        stdio: 'ignore',
    });
}

function initializeGitRepo(repoRoot) {
    runGitQuiet(repoRoot, ['init']);
    runGitQuiet(repoRoot, [
        'config',
        'user.email',
        'identity-test@example.invalid',
    ]);
    runGitQuiet(repoRoot, [
        'config',
        'user.name',
        'Identity Test',
    ]);
}

function buildFixtureArticles(fixture, options = {}) {
    return buildArticles({
        repoRoot: fixture.repoRoot,
        skipHistory: true,
        ...options,
    });
}

test('publish workflow has no commit-message validation bypass', () => {
    const workflow = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            '.github',
            'workflows',
            'publish_articles.yml',
        ),
        'utf8',
    );

    assert.doesNotMatch(workflow, /^ {4}if\s*:/m);
    assert.match(workflow, /^permissions:\r?\n\s+contents: write$/m);
    assert.match(
        workflow,
        /^\s+ARTICLE_MAP_BASE_REF: \$\{\{ github\.event\.before \}\}$/m,
    );
});

test('CRLF article-map does not create line-ending churn', (t) => {
    const fixture = createFixture(t);
    const mapPath = path.join(fixture.repoRoot, 'article-map.json');
    const crlfMap = fs
        .readFileSync(mapPath, 'utf8')
        .replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(mapPath, crlfMap);

    const dryRun = buildFixtureArticles(fixture, { write: false });
    const writeRun = buildFixtureArticles(fixture);

    assert.equal(dryRun.changes.includes('article-map.json'), false);
    assert.equal(writeRun.changes.includes('article-map.json'), false);
    assert.equal(fs.readFileSync(mapPath, 'utf8'), crlfMap);
});

test('title and source path rename update the original slug only', (t) => {
    const fixture = createFixture(t, {
        manifestArticles: [zennManifestEntry(ID_A, 'renamed-source.md')],
        sources: {
            'renamed-source.md': sourceMarkdown('Renamed title'),
        },
        targets: {
            [`${ID_A}.md`]: targetMarkdown('Original title'),
        },
    });

    buildFixtureArticles(fixture);

    const targetFiles = fs
        .readdirSync(fixture.targetDir)
        .filter((file) => file.endsWith('.md'));
    assert.deepEqual(targetFiles, [`${ID_A}.md`]);
    const parsed = matter(
        fs.readFileSync(path.join(fixture.targetDir, `${ID_A}.md`), 'utf8'),
    );
    assert.equal(parsed.data.title, 'Renamed title');
});

test('legacy title reference fails before writing a target', (t) => {
    const fixture = createFixture(t, {
        sources: {
            'article-a.md': sourceMarkdown(
                'Article A',
                'See <<<Article B>>>.\n',
            ),
        },
    });
    const targetPath = path.join(fixture.targetDir, `${ID_A}.md`);
    const before = sha256(targetPath);

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture),
    );

    assert.ok(
        diagnosticCodes(error).has('LEGACY_OR_INVALID_ARTICLE_REFERENCE'),
    );
    assert.equal(sha256(targetPath), before);
});

test('ID reference resolves through map and uses the current title', (t) => {
    const fixture = createFixture(t, {
        bindings: {
            [ID_A]: { slug: ID_A, lifecycle: 'active' },
            [ID_B]: { slug: ID_B, lifecycle: 'active' },
        },
        manifestArticles: [
            zennManifestEntry(ID_A, 'article-a.md'),
            zennManifestEntry(ID_B, 'article-b.md'),
        ],
        sources: {
            'article-a.md': sourceMarkdown(
                'Article A',
                `See <<<article:${ID_B}>>>.\n`,
            ),
            'article-b.md': sourceMarkdown(
                'Current B title',
                '本文\n',
                {},
                ID_B,
            ),
        },
        targets: {
            [`${ID_A}.md`]: targetMarkdown('Article A'),
            [`${ID_B}.md`]: targetMarkdown('Old B title'),
        },
    });

    buildFixtureArticles(fixture);

    const output = fs.readFileSync(
        path.join(fixture.targetDir, `${ID_A}.md`),
        'utf8',
    );
    assert.match(
        output,
        new RegExp(
            `\\[Current B title\\]\\(https://zenn\\.dev/solitudera/articles/${ID_B}\\)`,
        ),
    );
    assert.doesNotMatch(output, /<<<article:/);
});

test('missing active source fails closed and keeps target bytes', (t) => {
    const fixture = createFixture(t, {
        manifestArticles: [],
        sources: {},
    });
    const targetPath = path.join(fixture.targetDir, `${ID_A}.md`);
    const before = sha256(targetPath);

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture),
    );

    assert.ok(diagnosticCodes(error).has('ACTIVE_SOURCE_MISSING'));
    assert.equal(sha256(targetPath), before);
});

test('duplicate article_id in manifest is rejected', (t) => {
    const fixture = createFixture(t, {
        manifestArticles: [
            zennManifestEntry(ID_A, 'article-a.md'),
            zennManifestEntry(ID_A, 'article-b.md'),
        ],
        sources: {
            'article-a.md': sourceMarkdown('Article A'),
            'article-b.md': sourceMarkdown('Article B'),
        },
    });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('DUPLICATE_ARTICLE_ID'));
});

test('invalid article_id is rejected', (t) => {
    const fixture = createFixture(t, {
        bindings: {},
        manifestArticles: [
            zennManifestEntry('not-an-id', 'article-a.md'),
        ],
        targets: {},
    });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('INVALID_MANIFEST_ENTRY'));
});

test('hyphenated UUID is rejected as a global article_id', (t) => {
    const fixture = createFixture(t, {
        bindings: {},
        manifestArticles: [
            zennManifestEntry(HYPHENATED_UUID, 'article-a.md'),
        ],
        sources: {
            'article-a.md': sourceMarkdown(
                'Article A',
                '本文\n',
                {},
                HYPHENATED_UUID,
            ),
        },
        targets: {},
    });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('INVALID_MANIFEST_ENTRY'));
});

test('source front matter article_id is required', (t) => {
    const fixture = createFixture(t, {
        sources: {
            'article-a.md': matter.stringify('本文\n', {
                title: 'Article A',
                emoji: '🌃',
                type: 'tech',
                tags: ['test'],
            }),
        },
    });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('MISSING_SOURCE_ARTICLE_ID'));
});

test('source front matter article_id must match manifest', (t) => {
    const fixture = createFixture(t, {
        sources: {
            'article-a.md': sourceMarkdown(
                'Article A',
                '本文\n',
                {},
                ID_B,
            ),
        },
    });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('SOURCE_ARTICLE_ID_MISMATCH'));
});

test('duplicate source basename across share and zenn is rejected', (t) => {
    const second = {
        ...zennManifestEntry(ID_B, 'article-a.md'),
        source: 'articles/zenn/article-a.md',
    };
    const fixture = createFixture(t, {
        bindings: {
            [ID_A]: { slug: ID_A, lifecycle: 'active' },
            [ID_B]: { slug: ID_B, lifecycle: 'active' },
        },
        manifestArticles: [
            zennManifestEntry(ID_A, 'article-a.md'),
            second,
        ],
        targets: {
            [`${ID_A}.md`]: targetMarkdown('Article A'),
            [`${ID_B}.md`]: targetMarkdown('Article B'),
        },
    });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('DUPLICATE_SOURCE_FILE'));
});

test('source traversal path is rejected', (t) => {
    const entry = zennManifestEntry(ID_A, 'article-a.md');
    entry.source = 'articles/share/../article-a.md';
    const fixture = createFixture(t, { manifestArticles: [entry] });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('INVALID_SOURCE_PATH'));
});

test('mapped target missing is not silently recreated', (t) => {
    const fixture = createFixture(t, { targets: {} });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture),
    );
    assert.ok(diagnosticCodes(error).has('MAPPED_TARGET_MISSING'));
    assert.equal(
        fs.existsSync(path.join(fixture.targetDir, `${ID_A}.md`)),
        false,
    );
});

test('unmapped target is rejected', (t) => {
    const fixture = createFixture(t, {
        targets: {
            [`${ID_A}.md`]: targetMarkdown('Article A'),
            [`${ID_B}.md`]: targetMarkdown('Unmanaged B'),
        },
    });

    const error = captureIdentityError(() =>
        buildFixtureArticles(fixture, { write: false }),
    );
    assert.ok(diagnosticCodes(error).has('UNMAPPED_TARGET'));
});

test('new article creates an append-only binding and identity slug', (t) => {
    const fixture = createFixture(t, {
        bindings: {},
        manifestArticles: [
            zennManifestEntry(ID_NEW, 'new-article.md'),
        ],
        sources: {
            'new-article.md': sourceMarkdown(
                'New article',
                '本文\n',
                {},
                ID_NEW,
            ),
        },
        targets: {},
    });

    buildFixtureArticles(fixture);

    const map = JSON.parse(
        fs.readFileSync(
            path.join(fixture.repoRoot, 'article-map.json'),
            'utf8',
        ),
    );
    assert.deepEqual(map.bindings[ID_NEW], {
        slug: ID_NEW,
        lifecycle: 'active',
    });
    assert.equal(
        fs.existsSync(path.join(fixture.targetDir, `${ID_NEW}.md`)),
        true,
    );
});

test('retiring and withdrawn lifecycle requests fail closed', async (t) => {
    await t.test('retiring', () => {
        const entry = zennManifestEntry(ID_A, 'article-a.md', {
            article_state: 'retiring',
        });
        const fixture = createFixture(t, { manifestArticles: [entry] });
        const error = captureIdentityError(() =>
            buildFixtureArticles(fixture, { write: false }),
        );
        assert.ok(
            diagnosticCodes(error).has('UNSUPPORTED_ZENN_LIFECYCLE'),
        );
    });

    await t.test('withdrawn', () => {
        const entry = zennManifestEntry(ID_A, 'article-a.md');
        entry.targets.zenn.desired = 'withdrawn';
        const fixture = createFixture(t, { manifestArticles: [entry] });
        const error = captureIdentityError(() =>
            buildFixtureArticles(fixture, { write: false }),
        );
        assert.ok(
            diagnosticCodes(error).has('UNSUPPORTED_ZENN_LIFECYCLE'),
        );
    });
});

test('historical binding slug, lifecycle and removal are immutable', () => {
    const previous = {
        schema_version: 1,
        platform: 'zenn',
        bindings: {
            [ID_A]: { slug: ID_A, lifecycle: 'active' },
        },
    };

    for (const current of [
        {
            ...previous,
            bindings: {
                [ID_A]: { slug: ID_B, lifecycle: 'active' },
            },
        },
        {
            ...previous,
            bindings: {
                [ID_A]: { slug: ID_A, lifecycle: 'retired' },
            },
        },
        {
            ...previous,
            bindings: {},
        },
    ]) {
        const diagnostics = [];
        compareBindingHistory(
            previous,
            current,
            'article-map.json',
            diagnostics,
        );
        assert.equal(diagnostics.length, 1);
        assert.match(
            diagnostics[0].code,
            /^ARTICLE_BINDING_(?:MUTATED|REMOVED)$/,
        );
    }
});

test('historical binding comparison permits append-only additions', () => {
    const previous = {
        schema_version: 1,
        platform: 'zenn',
        bindings: {
            [ID_A]: { slug: ID_A, lifecycle: 'active' },
        },
    };
    const current = {
        ...previous,
        bindings: {
            ...previous.bindings,
            [ID_B]: { slug: ID_B, lifecycle: 'active' },
        },
    };
    const diagnostics = [];

    compareBindingHistory(
        previous,
        current,
        'article-map.json',
        diagnostics,
    );

    assert.deepEqual(diagnostics, []);
});

test('explicit base map rejects an otherwise self-consistent binding rewrite', (t) => {
    const fixture = createFixture(t);
    const mapPath = path.join(fixture.repoRoot, 'article-map.json');
    const previousMapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const map = structuredClone(previousMapData);
    map.bindings[ID_A].slug = ID_B;
    fs.writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
    fs.renameSync(
        path.join(fixture.targetDir, `${ID_A}.md`),
        path.join(fixture.targetDir, `${ID_B}.md`),
    );

    const error = captureIdentityError(() =>
        buildArticles({
            repoRoot: fixture.repoRoot,
            write: false,
            previousMapData,
        }),
    );
    assert.ok(diagnosticCodes(error).has('ARTICLE_BINDING_MUTATED'));
});

test('default Git reader compares the committed base map', (t) => {
    const fixture = createFixture(t);
    initializeGitRepo(fixture.repoRoot);
    runGitQuiet(fixture.repoRoot, ['add', '--', 'article-map.json']);
    runGitQuiet(fixture.repoRoot, [
        'commit',
        '-m',
        'baseline article map',
    ]);

    const mapPath = path.join(fixture.repoRoot, 'article-map.json');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    map.bindings[ID_A].slug = ID_B;
    fs.writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
    fs.renameSync(
        path.join(fixture.targetDir, `${ID_A}.md`),
        path.join(fixture.targetDir, `${ID_B}.md`),
    );

    const error = captureIdentityError(() =>
        buildArticles({
            repoRoot: fixture.repoRoot,
            write: false,
            baseRef: 'HEAD',
        }),
    );
    assert.ok(diagnosticCodes(error).has('ARTICLE_BINDING_MUTATED'));
});

test('deleted map history rejects reintroduction with a rebound slug', (t) => {
    const fixture = createFixture(t);
    const mapPath = path.join(fixture.repoRoot, 'article-map.json');
    initializeGitRepo(fixture.repoRoot);
    runGitQuiet(fixture.repoRoot, ['add', '--', 'article-map.json']);
    runGitQuiet(fixture.repoRoot, [
        'commit',
        '-m',
        'add article map',
    ]);

    fs.rmSync(mapPath);
    runGitQuiet(fixture.repoRoot, ['add', '--', 'article-map.json']);
    runGitQuiet(fixture.repoRoot, [
        'commit',
        '-m',
        'delete article map',
    ]);

    const reboundMap = {
        schema_version: 1,
        platform: 'zenn',
        bindings: {
            [ID_A]: { slug: ID_B, lifecycle: 'active' },
        },
    };
    fs.writeFileSync(
        mapPath,
        `${JSON.stringify(reboundMap, null, 2)}\n`,
    );
    fs.renameSync(
        path.join(fixture.targetDir, `${ID_A}.md`),
        path.join(fixture.targetDir, `${ID_B}.md`),
    );
    const reboundTargetPath = path.join(
        fixture.targetDir,
        `${ID_B}.md`,
    );
    const mapBefore = sha256(mapPath);
    const targetBefore = sha256(reboundTargetPath);
    runGitQuiet(fixture.repoRoot, ['add', '--', 'article-map.json']);
    runGitQuiet(fixture.repoRoot, [
        'commit',
        '-m',
        'reintroduce rebound article map',
    ]);

    const error = captureIdentityError(() =>
        buildArticles({
            repoRoot: fixture.repoRoot,
            baseRef: 'HEAD~1',
        }),
    );
    assert.ok(diagnosticCodes(error).has('ARTICLE_BINDING_MUTATED'));
    assert.equal(sha256(mapPath), mapBefore);
    assert.equal(sha256(reboundTargetPath), targetBefore);
});

test('real Git history that never contained a map allows bootstrap', (t) => {
    const fixture = createFixture(t);
    initializeGitRepo(fixture.repoRoot);
    fs.writeFileSync(
        path.join(fixture.repoRoot, 'baseline.txt'),
        'baseline\n',
    );
    runGitQuiet(fixture.repoRoot, ['add', '--', 'baseline.txt']);
    runGitQuiet(fixture.repoRoot, [
        'commit',
        '-m',
        'baseline without article map',
    ]);

    const result = buildArticles({
        repoRoot: fixture.repoRoot,
        write: false,
        baseRef: 'HEAD',
    });

    assert.equal(result.changes.includes('article-map.json'), false);
});

test('unreadable explicit base revision fails closed', (t) => {
    const fixture = createFixture(t);
    const error = captureIdentityError(() =>
        buildArticles({
            repoRoot: fixture.repoRoot,
            write: false,
            baseRef: 'definitely-not-a-revision',
        }),
    );
    assert.ok(
        diagnosticCodes(error).has('ARTICLE_MAP_BASE_REF_UNREADABLE'),
    );
});

test('verified reachable history without article-map allows bootstrap', (t) => {
    const fixture = createFixture(t);
    const calls = [];
    const gitRunner = (_repoRoot, args) => {
        calls.push(args);
        if (args[0] === 'rev-parse') {
            return { status: 0, stdout: 'base-commit\n', stderr: '' };
        }
        if (args[0] === 'ls-tree') {
            return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'rev-list') {
            return { status: 0, stdout: '', stderr: '' };
        }
        assert.fail(`Unexpected Git command: ${args.join(' ')}`);
    };

    buildArticles({
        repoRoot: fixture.repoRoot,
        write: false,
        baseRef: 'base-commit',
        gitRunner,
    });

    assert.deepEqual(
        calls.map((args) => args[0]),
        ['rev-parse', 'ls-tree', 'rev-list'],
    );
});

test('map history read failure is not treated as bootstrap', (t) => {
    const fixture = createFixture(t);
    const gitRunner = (_repoRoot, args) => {
        if (args[0] === 'rev-parse') {
            return { status: 0, stdout: 'base-commit\n', stderr: '' };
        }
        if (args[0] === 'ls-tree') {
            return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'rev-list') {
            return {
                status: 128,
                stdout: '',
                stderr: 'simulated history read failure',
            };
        }
        assert.fail(`Unexpected Git command: ${args.join(' ')}`);
    };

    const error = captureIdentityError(() =>
        buildArticles({
            repoRoot: fixture.repoRoot,
            write: false,
            baseRef: 'base-commit',
            gitRunner,
        }),
    );
    assert.ok(
        diagnosticCodes(error).has(
            'HISTORICAL_ARTICLE_MAP_HISTORY_UNREADABLE',
        ),
    );
});

test('base tree read failure is not treated as bootstrap', (t) => {
    const fixture = createFixture(t);
    const gitRunner = (_repoRoot, args) => {
        if (args[0] === 'rev-parse') {
            return { status: 0, stdout: 'base-commit\n', stderr: '' };
        }
        if (args[0] === 'ls-tree') {
            return {
                status: 128,
                stdout: '',
                stderr: 'simulated tree read failure',
            };
        }
        assert.fail(`Unexpected Git command: ${args.join(' ')}`);
    };

    const error = captureIdentityError(() =>
        buildArticles({
            repoRoot: fixture.repoRoot,
            write: false,
            baseRef: 'base-commit',
            gitRunner,
        }),
    );
    assert.ok(
        diagnosticCodes(error).has(
            'HISTORICAL_ARTICLE_MAP_TREE_UNREADABLE',
        ),
    );
});
