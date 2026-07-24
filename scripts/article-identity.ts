'use strict';

type UnknownRecord = Record<string, unknown>;
type ArticleId = string;

interface Diagnostic {
    code: string;
    file: string;
    message: string;
}

interface GitExecutionResult {
    error?: Error;
    signal?: NodeJS.Signals | null;
    status: number | null;
    stdout: string;
    stderr: string;
}

type GitRunner = (
    repoRoot: string,
    args: readonly string[],
) => GitExecutionResult;

interface ArticleMapEntry {
    articleId: ArticleId;
    slug: string;
    lifecycle: string;
}

interface ManifestEntry {
    articleId: ArticleId;
    source: string;
    file: string;
    articleState: string;
    desired: string;
}

interface ArticleReference {
    articleId: ArticleId;
    start: number;
    end: number;
}

interface ParsedMarkdown {
    raw: string;
    data: UnknownRecord;
    content: string;
}

interface SourceArticle {
    articleId: ArticleId;
    file: string;
    filePath: string;
    data: UnknownRecord;
    content: string;
    references: ArticleReference[];
}

interface TargetArticle {
    articleId: ArticleId;
    slug: string;
    file: string;
    filePath: string;
    data: UnknownRecord;
    content: string;
    raw: string;
}

interface IdentityOptions {
    repoRoot?: string;
    sourceDir?: string;
    targetDir?: string;
    manifestPath?: string;
    mapPath?: string;
    baseRef?: string;
    gitRunner?: GitRunner;
    previousMapData?: unknown;
    skipHistory?: boolean;
}

interface HistoricalValidationOptions {
    repoRoot: string;
    mapPath: string;
    baseRef?: string;
    gitRunner?: GitRunner;
    previousMapData?: unknown;
    skipHistory?: boolean;
}

interface IdentityContext {
    repoRoot: string;
    sourceDir: string;
    targetDir: string;
    manifestPath: string;
    mapPath: string;
    mapData: unknown | null;
    mapEntries: Map<ArticleId, ArticleMapEntry>;
    manifestData: unknown | null;
    manifestEntries: Map<ArticleId, ManifestEntry>;
    sourceArticles: Map<ArticleId, SourceArticle>;
    targetArticles: Map<ArticleId, TargetArticle>;
}

interface ArticleMapReadResult {
    data: unknown | null;
    entries: Map<ArticleId, ArticleMapEntry>;
}

interface ManifestReadResult {
    data: unknown | null;
    entries: Map<ArticleId, ManifestEntry>;
    files?: Map<string, ArticleId>;
}

interface SerializedBinding {
    slug: string;
    lifecycle: string;
}

const fs: typeof import('fs-extra') = require('fs-extra');
const matter: typeof import('gray-matter') = require('gray-matter');
const { spawnSync }: typeof import('node:child_process') =
    require('node:child_process');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');

const ARTICLE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SLUG_PATTERN = /^[a-z0-9_-]{12,50}$/;
const ARTICLE_REFERENCE_PATTERN = /^article:([a-z0-9_-]+)$/;

class IdentityValidationError extends Error {
    diagnostics: Diagnostic[];

    constructor(diagnostics: Diagnostic[]) {
        super(
            `Article identity validation failed with ${diagnostics.length} error(s).`,
        );
        this.name = 'IdentityValidationError';
        this.diagnostics = diagnostics;
    }
}

function diagnostic(code: string, file: string, message: string): Diagnostic {
    return { code, file: file.replaceAll('\\', '/'), message };
}

function isPlainObject(value: unknown): value is UnknownRecord {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function isValidArticleId(value: unknown): value is ArticleId {
    return typeof value === 'string' && ARTICLE_ID_PATTERN.test(value);
}

function defaultGitRunner(
    repoRoot: string,
    args: readonly string[],
): GitExecutionResult {
    // Codex's Windows sandbox cannot pipe child-process output directly.
    // Capture it through private temporary files so local validation and CI
    // use the same fail-closed Git protocol.
    const captureDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zenn-map-history-'),
    );
    const stdoutPath = path.join(captureDir, 'stdout');
    const stderrPath = path.join(captureDir, 'stderr');
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;

    try {
        stdoutFd = fs.openSync(stdoutPath, 'wx');
        stderrFd = fs.openSync(stderrPath, 'wx');
        const result = spawnSync('git', args, {
            cwd: repoRoot,
            shell: false,
            stdio: ['ignore', stdoutFd, stderrFd],
        });
        fs.closeSync(stdoutFd);
        stdoutFd = undefined;
        fs.closeSync(stderrFd);
        stderrFd = undefined;

        return {
            error: result.error,
            signal: result.signal,
            status: result.status,
            stdout: fs.readFileSync(stdoutPath, 'utf8'),
            stderr: fs.readFileSync(stderrPath, 'utf8'),
        };
    } finally {
        if (stdoutFd !== undefined) {
            fs.closeSync(stdoutFd);
        }
        if (stderrFd !== undefined) {
            fs.closeSync(stderrFd);
        }
        fs.removeSync(captureDir);
    }
}

function runGitChecked(
    gitRunner: GitRunner,
    repoRoot: string,
    args: readonly string[],
    operation: string,
): string {
    let result: GitExecutionResult;
    try {
        result = gitRunner(repoRoot, args);
    } catch (error) {
        throw new Error(
            `${operation}を実行できません: ${(error as Error).message}`,
        );
    }

    if (!isPlainObject(result)) {
        throw new Error(`${operation}のGit実行結果が不正です。`);
    }
    if (result.error) {
        throw new Error(
            `${operation}を実行できません: ${result.error.message}`,
        );
    }
    if (result.status !== 0) {
        const detail =
            typeof result.stderr === 'string' && result.stderr.trim()
                ? result.stderr.trim()
                : typeof result.stdout === 'string'
                  ? result.stdout.trim()
                  : '';
        throw new Error(
            `${operation}に失敗しました${detail ? `: ${detail}` : ''}`,
        );
    }
    if (typeof result.stdout !== 'string') {
        throw new Error(`${operation}の標準出力が不正です。`);
    }

    return result.stdout;
}

function readJson(
    filePath: string,
    label: string,
    diagnostics: Diagnostic[],
): unknown | null {
    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'JSON_NOT_FOUND',
                filePath,
                `${label}を読み取れません: ${(error as Error).message}`,
            ),
        );
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'INVALID_JSON',
                filePath,
                `${label}をJSONとして解析できません: ${(error as Error).message}`,
            ),
        );
        return null;
    }
}

function readArticleMap(
    mapPath: string,
    diagnostics: Diagnostic[],
): ArticleMapReadResult {
    const data = readJson(mapPath, 'article map', diagnostics);
    const entries = new Map<ArticleId, ArticleMapEntry>();
    const slugs = new Map<string, ArticleId>();

    if (!data) {
        return { data: null, entries };
    }

    if (
        !isPlainObject(data) ||
        data.schema_version !== 1 ||
        data.platform !== 'zenn' ||
        !isPlainObject(data.bindings)
    ) {
        diagnostics.push(
            diagnostic(
                'INVALID_ARTICLE_MAP_SCHEMA',
                mapPath,
                'schema_version: 1、platform: "zenn"、bindingsオブジェクトが必要です。',
            ),
        );
        return { data, entries };
    }

    for (const [articleId, entry] of Object.entries(data.bindings).sort(
        ([left], [right]) => left.localeCompare(right),
    )) {
        if (!isValidArticleId(articleId)) {
            diagnostics.push(
                diagnostic(
                    'INVALID_ARTICLE_ID',
                    mapPath,
                    `map内のarticle_idが不正です: ${articleId}`,
                ),
            );
            continue;
        }

        if (
            !isPlainObject(entry) ||
            entry.lifecycle !== 'active' ||
            typeof entry.slug !== 'string'
        ) {
            diagnostics.push(
                diagnostic(
                    'INVALID_ARTICLE_MAP_ENTRY',
                    mapPath,
                    `${articleId}にはslugとlifecycle: "active"が必要です。`,
                ),
            );
            continue;
        }

        if (!SLUG_PATTERN.test(entry.slug)) {
            diagnostics.push(
                diagnostic(
                    'INVALID_ZENN_SLUG',
                    mapPath,
                    `${articleId}のslugがZennの制約を満たしません: ${entry.slug}`,
                ),
            );
            continue;
        }

        const otherId = slugs.get(entry.slug);
        if (otherId) {
            diagnostics.push(
                diagnostic(
                    'DUPLICATE_ZENN_SLUG',
                    mapPath,
                    `${entry.slug}が${otherId}と${articleId}に重複して割り当てられています。`,
                ),
            );
            continue;
        }

        slugs.set(entry.slug, articleId);
        entries.set(articleId, {
            articleId,
            slug: entry.slug,
            lifecycle: entry.lifecycle,
        });
    }

    return { data, entries };
}

function readManifest(
    manifestPath: string,
    diagnostics: Diagnostic[],
): ManifestReadResult {
    const data = readJson(manifestPath, 'distribution manifest', diagnostics);
    const entries = new Map<ArticleId, ManifestEntry>();
    const files = new Map<string, ArticleId>();
    const allArticleIds = new Set<ArticleId>();

    if (!data) {
        return { data: null, entries };
    }

    if (
        !isPlainObject(data) ||
        data.schema_version !== 1 ||
        !Array.isArray(data.articles)
    ) {
        diagnostics.push(
            diagnostic(
                'INVALID_MANIFEST_SCHEMA',
                manifestPath,
                'schema_version: 1とarticles配列が必要です。',
            ),
        );
        return { data, entries };
    }

    for (const [index, entry] of data.articles.entries()) {
        const entryLabel = `articles[${index}]`;
        if (!isPlainObject(entry) || !isValidArticleId(entry.article_id)) {
            diagnostics.push(
                diagnostic(
                    'INVALID_MANIFEST_ENTRY',
                    manifestPath,
                    `${entryLabel}には有効なarticle_idが必要です。`,
                ),
            );
            continue;
        }

        if (allArticleIds.has(entry.article_id)) {
            diagnostics.push(
                diagnostic(
                    'DUPLICATE_ARTICLE_ID',
                    manifestPath,
                    `article_idが重複しています: ${entry.article_id}`,
                ),
            );
            continue;
        }
        allArticleIds.add(entry.article_id);

        const targets = isPlainObject(entry.targets)
            ? entry.targets
            : undefined;
        const zennTarget = targets?.zenn;
        if (zennTarget === undefined) {
            continue;
        }

        if (!isPlainObject(zennTarget)) {
            diagnostics.push(
                diagnostic(
                    'INVALID_ZENN_TARGET',
                    manifestPath,
                    `${entryLabel}.targets.zennはオブジェクトでなければなりません。`,
                ),
            );
            continue;
        }

        if (
            typeof entry.article_state !== 'string' ||
            !['active', 'retiring', 'retired'].includes(entry.article_state)
        ) {
            diagnostics.push(
                diagnostic(
                    'INVALID_ARTICLE_STATE',
                    manifestPath,
                    `${entryLabel}.article_stateが不正です: ${entry.article_state}`,
                ),
            );
            continue;
        }

        if (
            typeof zennTarget.desired !== 'string' ||
            !['published', 'withdrawn'].includes(zennTarget.desired)
        ) {
            diagnostics.push(
                diagnostic(
                    'INVALID_ZENN_DESIRED_STATE',
                    manifestPath,
                    `${entryLabel}.targets.zenn.desiredが不正です: ${zennTarget.desired}`,
                ),
            );
            continue;
        }

        if (
            entry.article_state !== 'active' ||
            zennTarget.desired !== 'published'
        ) {
            diagnostics.push(
                diagnostic(
                    'UNSUPPORTED_ZENN_LIFECYCLE',
                    manifestPath,
                    `${entry.article_id}は${entry.article_state}/${zennTarget.desired}ですが、この安全切片は公開停止・退役をまだ自動処理しません。`,
                ),
            );
            continue;
        }

        if (typeof entry.source !== 'string') {
            diagnostics.push(
                diagnostic(
                    'INVALID_SOURCE_PATH',
                    manifestPath,
                    `${entryLabel}.sourceには文字列が必要です。`,
                ),
            );
            continue;
        }

        const sourceMatch = entry.source.match(
            /^articles\/(?:share|zenn)\/([^/\\]+\.md)$/u,
        );
        if (
            !sourceMatch ||
            entry.source !== entry.source.normalize('NFC') ||
            sourceMatch[1] !== sourceMatch[1].normalize('NFC')
        ) {
            diagnostics.push(
                diagnostic(
                    'INVALID_SOURCE_PATH',
                    manifestPath,
                    `${entryLabel}.sourceはarticles/share/<basename>.mdまたはarticles/zenn/<basename>.mdにしてください: ${entry.source}`,
                ),
            );
            continue;
        }

        const sourceFile = sourceMatch[1];
        if (
            path.basename(sourceFile) !== sourceFile ||
            !sourceFile.endsWith('.md')
        ) {
            diagnostics.push(
                diagnostic(
                    'INVALID_SOURCE_FILE',
                    manifestPath,
                    `${entryLabel}.sourceから安全なpre-publishファイル名を取得できません: ${entry.source}`,
                ),
            );
            continue;
        }

        if (files.has(sourceFile)) {
            diagnostics.push(
                diagnostic(
                    'DUPLICATE_SOURCE_FILE',
                    manifestPath,
                    `${sourceFile}が複数のZenn article_idに割り当てられています（source basenameの衝突）。`,
                ),
            );
            continue;
        }

        const normalizedEntry: ManifestEntry = {
            articleId: entry.article_id,
            source: entry.source,
            file: sourceFile,
            articleState: entry.article_state,
            desired: zennTarget.desired,
        };
        entries.set(entry.article_id, normalizedEntry);
        files.set(sourceFile, entry.article_id);
    }

    return { data, entries, files };
}

function compareBindingHistory(
    previousData: unknown,
    currentData: unknown,
    mapPath: string,
    diagnostics: Diagnostic[],
): void {
    if (
        !isPlainObject(previousData) ||
        previousData.schema_version !== 1 ||
        previousData.platform !== 'zenn' ||
        !isPlainObject(previousData.bindings)
    ) {
        diagnostics.push(
            diagnostic(
                'INVALID_HISTORICAL_ARTICLE_MAP',
                mapPath,
                '比較元のarticle-map.jsonがschema v1のZenn mapではありません。',
            ),
        );
        return;
    }

    if (
        !isPlainObject(currentData) ||
        !isPlainObject(currentData.bindings)
    ) {
        return;
    }

    for (const [articleId, previous] of Object.entries(
        previousData.bindings,
    )) {
        const current = currentData.bindings[articleId];
        if (!current) {
            diagnostics.push(
                diagnostic(
                    'ARTICLE_BINDING_REMOVED',
                    mapPath,
                    `既存bindingを削除できません: ${articleId}`,
                ),
            );
            continue;
        }

        const previousBinding = previous as UnknownRecord;
        const currentBinding = current as UnknownRecord;
        if (
            previousBinding.slug !== currentBinding.slug ||
            previousBinding.lifecycle !== currentBinding.lifecycle
        ) {
            diagnostics.push(
                diagnostic(
                    'ARTICLE_BINDING_MUTATED',
                    mapPath,
                    `${articleId}の既存bindingは変更できません（${previousBinding.slug}/${previousBinding.lifecycle} -> ${currentBinding.slug}/${currentBinding.lifecycle}）。`,
                ),
            );
        }
    }
}

function validateHistoricalBindings(
    options: HistoricalValidationOptions,
    currentData: unknown,
    diagnostics: Diagnostic[],
): void {
    const {
        repoRoot,
        mapPath,
        previousMapData,
        skipHistory = false,
    } = options;

    if (skipHistory) {
        return;
    }

    if (previousMapData !== undefined) {
        compareBindingHistory(
            previousMapData,
            currentData,
            mapPath,
            diagnostics,
        );
        return;
    }

    const relativeMapPath = path
        .relative(repoRoot, mapPath)
        .replaceAll('\\', '/');
    if (relativeMapPath !== 'article-map.json') {
        diagnostics.push(
            diagnostic(
                'ARTICLE_MAP_OUTSIDE_REPOSITORY',
                mapPath,
                'article-map.jsonはリポジトリ直下に配置してください。',
            ),
        );
        return;
    }

    const baseRef =
        options.baseRef !== undefined
            ? options.baseRef
            : process.env.ARTICLE_MAP_BASE_REF !== undefined
              ? process.env.ARTICLE_MAP_BASE_REF
              : 'HEAD';
    if (
        typeof baseRef !== 'string' ||
        baseRef.length === 0 ||
        baseRef.startsWith('-')
    ) {
        diagnostics.push(
            diagnostic(
                'INVALID_ARTICLE_MAP_BASE_REF',
                mapPath,
                `比較元Git revisionが不正です: ${baseRef}`,
            ),
        );
        return;
    }

    const gitRunner = options.gitRunner || defaultGitRunner;
    try {
        runGitChecked(
            gitRunner,
            repoRoot,
            ['rev-parse', '--verify', `${baseRef}^{commit}`],
            `比較元revision ${baseRef} の確認`,
        );
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'ARTICLE_MAP_BASE_REF_UNREADABLE',
                mapPath,
                `比較元revision ${baseRef} を検証できません: ${(error as Error).message}`,
            ),
        );
        return;
    }

    let treeText;
    try {
        treeText = runGitChecked(
            gitRunner,
            repoRoot,
            [
                'ls-tree',
                '-z',
                '--name-only',
                '--full-tree',
                baseRef,
                '--',
                relativeMapPath,
            ],
            `比較元tree ${baseRef} の確認`,
        );
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'HISTORICAL_ARTICLE_MAP_TREE_UNREADABLE',
                mapPath,
                `${baseRef}のtreeを検証できません: ${(error as Error).message}`,
            ),
        );
        return;
    }

    const treeEntries = treeText.split('\0').filter(Boolean);
    let historicalRef: string | null = baseRef;
    if (treeEntries.length === 0) {
        let historyText;
        try {
            historyText = runGitChecked(
                gitRunner,
                repoRoot,
                [
                    'rev-list',
                    '--full-history',
                    baseRef,
                    '--',
                    relativeMapPath,
                ],
                `比較元 ${baseRef} のarticle-map.json履歴の確認`,
            );
        } catch (error) {
            diagnostics.push(
                diagnostic(
                    'HISTORICAL_ARTICLE_MAP_HISTORY_UNREADABLE',
                    mapPath,
                    `${baseRef}からmap履歴を検索できません: ${(error as Error).message}`,
                ),
            );
            return;
        }

        const historicalRevisions = historyText
            .split(/\r?\n/)
            .filter(Boolean);
        if (
            historicalRevisions.some(
                (revision) =>
                    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision),
            )
        ) {
            diagnostics.push(
                diagnostic(
                    'INVALID_HISTORICAL_ARTICLE_MAP_HISTORY',
                    mapPath,
                    `${baseRef}のmap履歴に不正なcommit IDがあります。`,
                ),
            );
            return;
        }

        if (historicalRevisions.length === 0) {
            // Git proved that the map never appeared anywhere in the history
            // reachable from the base commit: this is the sole bootstrap case.
            return;
        }

        historicalRef = null;
        for (const revision of historicalRevisions) {
            let candidateTreeText;
            try {
                candidateTreeText = runGitChecked(
                    gitRunner,
                    repoRoot,
                    [
                        'ls-tree',
                        '-z',
                        '--name-only',
                        '--full-tree',
                        revision,
                        '--',
                        relativeMapPath,
                    ],
                    `履歴tree ${revision} の確認`,
                );
            } catch (error) {
                diagnostics.push(
                    diagnostic(
                        'HISTORICAL_ARTICLE_MAP_TREE_UNREADABLE',
                        mapPath,
                        `${revision}のtreeを検証できません: ${(error as Error).message}`,
                    ),
                );
                return;
            }

            const candidateEntries = candidateTreeText
                .split('\0')
                .filter(Boolean);
            if (candidateEntries.length === 0) {
                continue;
            }
            if (
                candidateEntries.length !== 1 ||
                candidateEntries[0] !== relativeMapPath
            ) {
                diagnostics.push(
                    diagnostic(
                        'UNEXPECTED_HISTORICAL_ARTICLE_MAP_TREE',
                        mapPath,
                        `${revision}のtreeが予期しない結果を返しました: ${candidateEntries.join(', ')}`,
                    ),
                );
                return;
            }

            historicalRef = revision;
            break;
        }

        if (historicalRef === null) {
            diagnostics.push(
                diagnostic(
                    'HISTORICAL_ARTICLE_MAP_RECOVERY_FAILED',
                    mapPath,
                    `${baseRef}の可達履歴にmap操作がありますが、既存mapを復元できません。`,
                ),
            );
            return;
        }
    } else if (
        treeEntries.length !== 1 ||
        treeEntries[0] !== relativeMapPath
    ) {
        diagnostics.push(
            diagnostic(
                'UNEXPECTED_HISTORICAL_ARTICLE_MAP_TREE',
                mapPath,
                `${baseRef}のtreeが予期しない結果を返しました: ${treeEntries.join(', ')}`,
            ),
        );
        return;
    }

    let historicalText;
    try {
        historicalText = runGitChecked(
            gitRunner,
            repoRoot,
            [
                'show',
                `${historicalRef}:${relativeMapPath}`,
            ],
            `${historicalRef}のarticle-map.jsonの読み込み`,
        );
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'HISTORICAL_ARTICLE_MAP_UNREADABLE',
                mapPath,
                `${historicalRef}のarticle-map.jsonを読み取れません: ${(error as Error).message}`,
            ),
        );
        return;
    }

    let historicalData;
    try {
        historicalData = JSON.parse(historicalText);
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'INVALID_HISTORICAL_ARTICLE_MAP',
                mapPath,
                `比較元のarticle-map.jsonを解析できません: ${(error as Error).message}`,
            ),
        );
        return;
    }

    compareBindingHistory(
        historicalData,
        currentData,
        mapPath,
        diagnostics,
    );
}

function analyzeArticleReferences(
    content: string,
    file: string,
    diagnostics: Diagnostic[],
): ArticleReference[] {
    const references: ArticleReference[] = [];
    let cursor = 0;

    while (cursor < content.length) {
        const start = content.indexOf('<<<', cursor);
        if (start === -1) {
            break;
        }

        const end = content.indexOf('>>>', start + 3);
        if (end === -1) {
            diagnostics.push(
                diagnostic(
                    'MALFORMED_ARTICLE_REFERENCE',
                    file,
                    `offset ${start}の<<<に対応する>>>がありません。`,
                ),
            );
            break;
        }

        const token = content.slice(start + 3, end);
        const match = token.match(ARTICLE_REFERENCE_PATTERN);
        if (!match || !isValidArticleId(match[1])) {
            diagnostics.push(
                diagnostic(
                    'LEGACY_OR_INVALID_ARTICLE_REFERENCE',
                    file,
                    `<<<article:<article_id>>>>形式を使用してください: <<<${token}>>>`,
                ),
            );
        } else {
            references.push({
                articleId: match[1],
                start,
                end: end + 3,
            });
        }

        cursor = end + 3;
    }

    return references;
}

function parseMarkdown(
    filePath: string,
    relativePath: string,
    diagnostics: Diagnostic[],
): ParsedMarkdown | null {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'ARTICLE_NOT_FOUND',
                relativePath,
                `記事を読み取れません: ${(error as Error).message}`,
            ),
        );
        return null;
    }

    let parsed: import('gray-matter').GrayMatterFile<string>;
    try {
        parsed = matter(raw);
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'INVALID_FRONT_MATTER',
                relativePath,
                `front matterを解析できません: ${(error as Error).message}`,
            ),
        );
        return null;
    }

    if (
        typeof parsed.data.title !== 'string' ||
        parsed.data.title.trim().length === 0
    ) {
        diagnostics.push(
            diagnostic(
                'MISSING_TITLE',
                relativePath,
                '空でないtitleが必要です。',
            ),
        );
    }

    return { raw, data: parsed.data, content: parsed.content };
}

function listDirectFiles(
    directory: string,
    diagnostics: Diagnostic[],
    label: string,
): import('node:fs').Dirent[] {
    try {
        return fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        diagnostics.push(
            diagnostic(
                'DIRECTORY_NOT_FOUND',
                directory,
                `${label}を読み取れません: ${(error as Error).message}`,
            ),
        );
        return [];
    }
}

function loadIdentityContext(
    options: IdentityOptions = {},
): IdentityContext {
    const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
    const sourceDir = path.resolve(
        options.sourceDir || path.join(repoRoot, 'pre-publish'),
    );
    const targetDir = path.resolve(
        options.targetDir || path.join(repoRoot, 'articles'),
    );
    const manifestPath = path.resolve(
        options.manifestPath || path.join(sourceDir, 'manifest.json'),
    );
    const mapPath = path.resolve(
        options.mapPath || path.join(repoRoot, 'article-map.json'),
    );
    const diagnostics: Diagnostic[] = [];

    const articleMap = readArticleMap(mapPath, diagnostics);
    const manifest = readManifest(manifestPath, diagnostics);
    validateHistoricalBindings(
        {
            repoRoot,
            mapPath,
            baseRef: options.baseRef,
            gitRunner: options.gitRunner,
            previousMapData: options.previousMapData,
            skipHistory: options.skipHistory,
        },
        articleMap.data,
        diagnostics,
    );
    const sourceEntries = listDirectFiles(
        sourceDir,
        diagnostics,
        'pre-publishディレクトリ',
    );
    const targetEntries = listDirectFiles(
        targetDir,
        diagnostics,
        'articlesディレクトリ',
    );

    const actualSourceFiles = new Set<string>();
    for (const entry of sourceEntries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
            diagnostics.push(
                diagnostic(
                    'UNSUPPORTED_SOURCE_ENTRY',
                    path.join(sourceDir, entry.name),
                    'pre-publish直下には通常ファイルだけを配置してください。',
                ),
            );
        } else if (entry.name === path.basename(manifestPath)) {
            continue;
        } else if (!entry.isFile() || !entry.name.endsWith('.md')) {
            diagnostics.push(
                diagnostic(
                    'UNSUPPORTED_SOURCE_ENTRY',
                    path.join(sourceDir, entry.name),
                    'pre-publishにはmanifest.jsonと.md記事だけを配置してください。',
                ),
            );
        } else {
            actualSourceFiles.add(entry.name);
        }
    }

    for (const file of actualSourceFiles) {
        if (!manifest.files?.has(file)) {
            diagnostics.push(
                diagnostic(
                    'UNMANIFESTED_SOURCE',
                    path.join('pre-publish', file),
                    '完全スナップショットmanifestのZenn配信対象として記載されていない記事です。',
                ),
            );
        }
    }

    for (const manifestEntry of manifest.entries.values()) {
        if (!actualSourceFiles.has(manifestEntry.file)) {
            diagnostics.push(
                diagnostic(
                    'MANIFEST_SOURCE_MISSING',
                    path.join('pre-publish', manifestEntry.file),
                    `${manifestEntry.articleId}がactiveですがソースファイルがありません。`,
                ),
            );
        }
    }

    for (const mapEntry of articleMap.entries.values()) {
        if (!manifest.entries.has(mapEntry.articleId)) {
            diagnostics.push(
                diagnostic(
                    'ACTIVE_SOURCE_MISSING',
                    manifestPath,
                    `${mapEntry.articleId}はmapでactiveですが完全スナップショットmanifestにありません。自動削除・非公開化は行いません。`,
                ),
            );
        }
    }

    const actualTargetFiles = new Set<string>();
    for (const entry of targetEntries) {
        if (entry.name === '.keep') {
            continue;
        }
        if (
            entry.isDirectory() ||
            entry.isSymbolicLink() ||
            !entry.isFile() ||
            !entry.name.endsWith('.md')
        ) {
            diagnostics.push(
                diagnostic(
                    'UNSUPPORTED_TARGET_ENTRY',
                    path.join(targetDir, entry.name),
                    'articles直下には通常の.mdファイルだけを配置してください。',
                ),
            );
        } else {
            actualTargetFiles.add(entry.name);
        }
    }

    const mappedTargetFiles = new Set(
        [...articleMap.entries.values()].map((entry) => `${entry.slug}.md`),
    );
    for (const targetFile of actualTargetFiles) {
        if (!mappedTargetFiles.has(targetFile)) {
            diagnostics.push(
                diagnostic(
                    'UNMAPPED_TARGET',
                    path.join('articles', targetFile),
                    'article-map.jsonに所有者がない既存Zenn記事です。',
                ),
            );
        }
    }

    for (const mapEntry of articleMap.entries.values()) {
        const targetFile = `${mapEntry.slug}.md`;
        if (!actualTargetFiles.has(targetFile)) {
            diagnostics.push(
                diagnostic(
                    'MAPPED_TARGET_MISSING',
                    path.join('articles', targetFile),
                    `${mapEntry.articleId}の既存ターゲットがありません。自動再作成は行いません。`,
                ),
            );
        }
    }

    for (const manifestEntry of manifest.entries.values()) {
        if (
            !articleMap.entries.has(manifestEntry.articleId) &&
            actualTargetFiles.has(`${manifestEntry.articleId}.md`)
        ) {
            diagnostics.push(
                diagnostic(
                    'NEW_ID_TARGET_COLLISION',
                    path.join('articles', `${manifestEntry.articleId}.md`),
                    '新規article_idと未管理の既存ターゲットが衝突しています。',
                ),
            );
        }
    }

    const sourceArticles = new Map<ArticleId, SourceArticle>();
    for (const manifestEntry of manifest.entries.values()) {
        if (!actualSourceFiles.has(manifestEntry.file)) {
            continue;
        }
        const relativePath = path.join('pre-publish', manifestEntry.file);
        const parsed = parseMarkdown(
            path.join(sourceDir, manifestEntry.file),
            relativePath,
            diagnostics,
        );
        if (!parsed) {
            continue;
        }
        if (parsed.data.article_id === undefined) {
            diagnostics.push(
                diagnostic(
                    'MISSING_SOURCE_ARTICLE_ID',
                    relativePath,
                    `front matterにmanifestと同じarticle_idが必要です: ${manifestEntry.articleId}`,
                ),
            );
        } else if (!isValidArticleId(parsed.data.article_id)) {
            diagnostics.push(
                diagnostic(
                    'INVALID_SOURCE_ARTICLE_ID',
                    relativePath,
                    `front matterのarticle_idが不正です: ${parsed.data.article_id}`,
                ),
            );
        } else if (parsed.data.article_id !== manifestEntry.articleId) {
            diagnostics.push(
                diagnostic(
                    'SOURCE_ARTICLE_ID_MISMATCH',
                    relativePath,
                    `front matter (${parsed.data.article_id}) とmanifest (${manifestEntry.articleId}) のarticle_idが一致しません。`,
                ),
            );
        }
        const references = analyzeArticleReferences(
            parsed.content,
            relativePath,
            diagnostics,
        );
        sourceArticles.set(manifestEntry.articleId, {
            articleId: manifestEntry.articleId,
            file: manifestEntry.file,
            filePath: path.join(sourceDir, manifestEntry.file),
            data: parsed.data,
            content: parsed.content,
            references,
        });
    }

    for (const sourceArticle of sourceArticles.values()) {
        for (const reference of sourceArticle.references) {
            if (!manifest.entries.has(reference.articleId)) {
                diagnostics.push(
                    diagnostic(
                        'UNRESOLVED_ARTICLE_REFERENCE',
                        path.join('pre-publish', sourceArticle.file),
                        `参照先article_idが完全スナップショットmanifestにありません: ${reference.articleId}`,
                    ),
                );
            }
        }
    }

    const targetArticles = new Map<ArticleId, TargetArticle>();
    for (const mapEntry of articleMap.entries.values()) {
        const targetFile = `${mapEntry.slug}.md`;
        if (!actualTargetFiles.has(targetFile)) {
            continue;
        }
        const relativePath = path.join('articles', targetFile);
        const parsed = parseMarkdown(
            path.join(targetDir, targetFile),
            relativePath,
            diagnostics,
        );
        if (!parsed) {
            continue;
        }
        targetArticles.set(mapEntry.articleId, {
            articleId: mapEntry.articleId,
            slug: mapEntry.slug,
            file: targetFile,
            filePath: path.join(targetDir, targetFile),
            data: parsed.data,
            content: parsed.content,
            raw: parsed.raw,
        });
    }

    if (diagnostics.length > 0) {
        diagnostics.sort(
            (left, right) =>
                left.file.localeCompare(right.file) ||
                left.code.localeCompare(right.code) ||
                left.message.localeCompare(right.message),
        );
        throw new IdentityValidationError(diagnostics);
    }

    return {
        repoRoot,
        sourceDir,
        targetDir,
        manifestPath,
        mapPath,
        mapData: articleMap.data,
        mapEntries: articleMap.entries,
        manifestData: manifest.data,
        manifestEntries: manifest.entries,
        sourceArticles,
        targetArticles,
    };
}

function serializeArticleMap(
    entries: ReadonlyMap<ArticleId, ArticleMapEntry>,
): string {
    const bindings: Record<ArticleId, SerializedBinding> = {};
    for (const [articleId, entry] of [...entries.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
    )) {
        bindings[articleId] = {
            slug: entry.slug,
            lifecycle: entry.lifecycle,
        };
    }

    return `${JSON.stringify(
        {
            schema_version: 1,
            platform: 'zenn',
            bindings,
        },
        null,
        2,
    )}\n`;
}

function formatIdentityError(error: unknown): string {
    if (!(error instanceof IdentityValidationError)) {
        const generalError = error as Error;
        return generalError.stack || generalError.message;
    }
    return [
        error.message,
        ...error.diagnostics.map(
            (item) => `- [${item.code}] ${item.file}: ${item.message}`,
        ),
    ].join('\n');
}

module.exports = {
    ARTICLE_ID_PATTERN,
    IdentityValidationError,
    analyzeArticleReferences,
    compareBindingHistory,
    formatIdentityError,
    isValidArticleId,
    loadIdentityContext,
    serializeArticleMap,
};
