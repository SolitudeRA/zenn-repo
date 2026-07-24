'use strict';

type ArticleId = string;

interface GitResult {
    status: number;
    stdout: string;
    stderr: string;
}

type GitRunner = (
    repoRoot: string,
    args: readonly string[],
) => GitResult;

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

interface BuildArticleOptions extends IdentityOptions {
    write?: boolean;
}

interface SourceFrontMatter {
    title: string;
    emoji?: unknown;
    type?: unknown;
    tags?: unknown;
    published?: unknown;
    [key: string]: unknown;
}

interface TargetFrontMatter {
    emoji?: unknown;
    type?: unknown;
    topics?: unknown;
    published?: unknown;
    published_at?: unknown;
    [key: string]: unknown;
}

interface SourceArticle {
    articleId: ArticleId;
    file: string;
    filePath: string;
    data: SourceFrontMatter;
    content: string;
    references: readonly unknown[];
}

interface TargetArticle {
    articleId: ArticleId;
    slug: string;
    file: string;
    filePath: string;
    data: TargetFrontMatter;
    content: string;
    raw: string;
}

interface ArticleMapEntry {
    articleId: ArticleId;
    slug: string;
    lifecycle: string;
}

interface IdentityContext {
    repoRoot: string;
    targetDir: string;
    mapPath: string;
    mapEntries: Map<ArticleId, ArticleMapEntry>;
    sourceArticles: Map<ArticleId, SourceArticle>;
    targetArticles: Map<ArticleId, TargetArticle>;
}

interface IdentityModule {
    formatIdentityError(error: unknown): string;
    loadIdentityContext(options: IdentityOptions): IdentityContext;
    serializeArticleMap(
        entries: ReadonlyMap<ArticleId, ArticleMapEntry>,
    ): string;
}

interface ArticleMetadata {
    title: unknown;
    emoji: unknown;
    type: unknown;
    topics: unknown[];
    published: unknown;
    published_at?: unknown;
}

interface ArticleDocument {
    articleId: ArticleId;
    slug: string;
    file: string;
    filePath: string;
    data: Record<string, unknown>;
    content: string;
    raw: string;
    lineEndingSource: string;
}

interface GenerateArticleOptions {
    documents: ReadonlyMap<ArticleId, ArticleDocument>;
    sourceArticles: ReadonlyMap<ArticleId, SourceArticle>;
    mapEntries: ReadonlyMap<ArticleId, ArticleMapEntry>;
}

interface SeriesLinkModule {
    generateArticleOutputs(
        options: GenerateArticleOptions,
    ): Map<ArticleId, string>;
    matchDocumentLineEndings(
        content: string,
        referenceContent: string,
    ): string;
}

interface BuildArticlesResult {
    changes: string[];
    outputs: Map<ArticleId, string>;
    mapOutput: string;
    context: IdentityContext;
}

const fs: typeof import('fs-extra') = require('fs-extra');
const matter: typeof import('gray-matter') = require('gray-matter');
const path: typeof import('node:path') = require('node:path');
const {
    formatIdentityError,
    loadIdentityContext,
    serializeArticleMap,
}: IdentityModule = require('./article-identity');
const {
    generateArticleOutputs,
    matchDocumentLineEndings,
}: SeriesLinkModule = require('./generate-series-links.ts');

function quoted(value: unknown): string {
    return JSON.stringify(String(value));
}

function buildMetadata(
    source: SourceArticle,
    target: TargetArticle | null,
): ArticleMetadata {
    const sourceData = source.data;
    if (!target) {
        return {
            title: sourceData.title,
            emoji: sourceData.emoji || '🌃',
            type: sourceData.type || 'tech',
            topics: Array.isArray(sourceData.tags)
                ? sourceData.tags
                : ['default'],
            // Preserve the legacy publication default for this compatibility
            // slice. Lifecycle withdrawal is intentionally unsupported here.
            published:
                sourceData.published !== undefined
                    ? sourceData.published
                    : true,
        };
    }

    const metadata: ArticleMetadata = {
        // Identity comes from the manifest/map, so a title rename updates the
        // same slug instead of creating another Zenn article.
        title: sourceData.title,
        emoji: target.data.emoji,
        type: target.data.type,
        topics: Array.isArray(sourceData.tags)
            ? sourceData.tags
            : Array.isArray(target.data.topics)
              ? target.data.topics
              : ['default'],
        // Existing publication status remains target-owned in this minimal
        // slice. retiring/retired/withdrawn are rejected by the validator.
        published: target.data.published,
    };

    if (target.data.published_at) {
        metadata.published_at = target.data.published_at;
    }

    return metadata;
}

function serializeIntermediateArticle(
    metadata: ArticleMetadata,
    sourceBody: string,
): string {
    const frontMatter =
        '---\n' +
        `title: ${quoted(metadata.title)}\n` +
        `emoji: ${quoted(metadata.emoji)}\n` +
        `type: ${quoted(metadata.type)}\n` +
        `topics:\n${metadata.topics
            .map((topic) => `  - ${quoted(topic)}`)
            .join('\n')}\n` +
        `published: ${metadata.published}\n` +
        (metadata.published_at
            ? `published_at: ${quoted(metadata.published_at)}\n`
            : '') +
        '---';

    return `${frontMatter}\n\n${sourceBody}`;
}

function buildArticles(
    options: BuildArticleOptions = {},
): BuildArticlesResult {
    const write = options.write !== false;
    const context = loadIdentityContext(options);
    const nextMapEntries = new Map<ArticleId, ArticleMapEntry>(
        context.mapEntries,
    );
    const documents = new Map<ArticleId, ArticleDocument>();

    for (const [articleId, source] of context.sourceArticles) {
        let binding = nextMapEntries.get(articleId);
        if (!binding) {
            binding = {
                articleId,
                slug: articleId,
                lifecycle: 'active',
            };
            nextMapEntries.set(articleId, binding);
        }

        const target = context.targetArticles.get(articleId) || null;
        const metadata = buildMetadata(source, target);
        const raw = serializeIntermediateArticle(metadata, source.content);
        const parsed = matter(raw);

        documents.set(articleId, {
            articleId,
            slug: binding.slug,
            file: `${binding.slug}.md`,
            filePath: path.join(
                context.targetDir,
                `${binding.slug}.md`,
            ),
            data: parsed.data,
            content: parsed.content,
            raw,
            lineEndingSource: target?.raw || raw,
        });
    }

    const outputs = generateArticleOutputs({
        documents,
        sourceArticles: context.sourceArticles,
        mapEntries: nextMapEntries,
    });
    const canonicalMapOutput = serializeArticleMap(nextMapEntries);
    const changes: string[] = [];

    for (const [articleId, output] of outputs) {
        const document = documents.get(articleId)!;
        const oldOutput = context.targetArticles.get(articleId)?.raw;
        if (output !== oldOutput) {
            changes.push(
                path.relative(context.repoRoot, document.filePath),
            );
        }
    }

    let oldMapOutput: string | null = null;
    try {
        oldMapOutput = fs.readFileSync(context.mapPath, 'utf8');
    } catch {
        // loadIdentityContext already reports a missing/invalid map. This is
        // only defensive for callers replacing the file between phases.
    }
    const mapOutput =
        oldMapOutput === null
            ? canonicalMapOutput
            : matchDocumentLineEndings(
                  canonicalMapOutput,
                  oldMapOutput,
              );
    if (mapOutput !== oldMapOutput) {
        changes.push(path.relative(context.repoRoot, context.mapPath));
    }

    // Every identity, source, target and reference invariant has been checked
    // before this point. No validation path below performs a partial write.
    if (write) {
        for (const [articleId, output] of outputs) {
            const document = documents.get(articleId)!;
            const oldOutput =
                context.targetArticles.get(articleId)?.raw;
            if (output !== oldOutput) {
                fs.writeFileSync(document.filePath, output, 'utf8');
            }
        }
        if (mapOutput !== oldMapOutput) {
            fs.writeFileSync(context.mapPath, mapOutput, 'utf8');
        }
    }

    return {
        changes: changes.sort(),
        outputs,
        mapOutput,
        context,
    };
}

function runCli(
    argv: readonly string[] = process.argv.slice(2),
): BuildArticlesResult {
    const checkOnly = argv.includes('--check');
    const baseRefArguments = argv.filter((argument) =>
        argument.startsWith('--base-ref='),
    );
    const unknown = argv.filter(
        (argument) =>
            argument !== '--check' &&
            !argument.startsWith('--base-ref='),
    );
    if (unknown.length > 0) {
        throw new TypeError(
            `Unknown argument(s): ${unknown.join(', ')}`,
        );
    }
    if (baseRefArguments.length > 1) {
        throw new TypeError('--base-ref may be specified only once.');
    }
    const baseRef = baseRefArguments[0]?.slice('--base-ref='.length);
    const result = buildArticles({ write: !checkOnly, baseRef });
    console.log(
        `${checkOnly ? 'Article build check' : 'Article build'} completed: ${result.changes.length} change(s).`,
    );
    for (const file of result.changes) {
        console.log(`- ${file.replaceAll('\\', '/')}`);
    }
    return result;
}

module.exports = {
    buildArticles,
    buildMetadata,
    runCli,
    serializeIntermediateArticle,
};

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        console.error(formatIdentityError(error));
        process.exitCode = 1;
    }
}
