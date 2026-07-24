'use strict';

const fs = require('fs-extra');
const matter = require('gray-matter');
const path = require('node:path');
const {
    formatIdentityError,
    loadIdentityContext,
} = require('./article-identity');

const SERIES_START = '<!-- START_SERIES -->';
const SERIES_END = '<!-- END_SERIES -->';
const ZENN_ARTICLE_BASE = 'https://zenn.dev/solitudera/articles';

function matchDocumentLineEndings(content, referenceContent) {
    const normalized = content.replace(/\r\n/g, '\n');
    return referenceContent.includes('\r\n')
        ? normalized.replace(/\n/g, '\r\n')
        : normalized;
}

function replaceInlineArticleLinks(content, sourceArticles, mapEntries) {
    return content.replace(
        /<<<article:([a-z0-9_-]+)>>>/g,
        (match, articleId) => {
            const source = sourceArticles.get(articleId);
            const binding = mapEntries.get(articleId);
            if (!source || !binding) {
                // The shared identity validator rejects this before rendering.
                // Keeping the token here avoids a misleading partial link if
                // this pure function is called incorrectly.
                return match;
            }
            return `[${source.data.title}](${ZENN_ARTICLE_BASE}/${binding.slug})`;
        },
    );
}

function buildSeriesGroups(sourceArticles) {
    const groups = new Map();
    const sortedSources = [...sourceArticles.values()].sort((left, right) =>
        left.file.localeCompare(right.file),
    );

    for (const source of sortedSources) {
        if (
            typeof source.data.series !== 'string' ||
            source.data.series.trim().length === 0
        ) {
            continue;
        }
        const series = source.data.series;
        const members = groups.get(series) || [];
        members.push(source);
        groups.set(series, members);
    }

    return groups;
}

function insertOrReplaceSeriesBlock(
    content,
    source,
    seriesMembers,
    mapEntries,
) {
    const links = seriesMembers
        .filter((member) => member.articleId !== source.articleId)
        .map((member) => {
            const binding = mapEntries.get(member.articleId);
            return `[${member.data.title}](${ZENN_ARTICLE_BASE}/${binding.slug})`;
        });

    const seriesLinks =
        `${SERIES_START}\n\n` +
        `${source.data.series} シリーズ記事：\n\n` +
        `${links.join('\n')}\n\n` +
        SERIES_END;

    const lines = content.split('\n');
    const startIndex = lines.indexOf(SERIES_START);
    const endIndex = lines.indexOf(SERIES_END);

    if (startIndex !== -1 && endIndex !== -1) {
        lines.splice(
            startIndex,
            endIndex - startIndex + 1,
            ...seriesLinks.split('\n'),
        );
    } else {
        lines.unshift(seriesLinks);
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Render final Zenn article bytes from ID-bound source and target documents.
 *
 * `documents` is a Map keyed by article_id. Each value contains the raw
 * parser output plus parsed `data` and `content`. No title lookup is used.
 */
function generateArticleOutputs({
    documents,
    sourceArticles,
    mapEntries,
}) {
    const outputs = new Map();
    const seriesGroups = buildSeriesGroups(sourceArticles);

    for (const [articleId, document] of documents) {
        const source = sourceArticles.get(articleId);
        if (!source) {
            throw new Error(`Missing source article for ${articleId}`);
        }

        // Generation is platform-independent. Normalize checkout line endings
        // before marker matching/blank-line compaction, then restore the
        // existing target's convention at the output boundary.
        let content = document.content.replace(/\r\n/g, '\n');
        let needsMatterSerialization = source.references.length > 0;
        const series =
            typeof source.data.series === 'string'
                ? source.data.series
                : null;

        if (series && seriesGroups.has(series)) {
            content = insertOrReplaceSeriesBlock(
                content,
                source,
                seriesGroups.get(series),
                mapEntries,
            );
            needsMatterSerialization = true;
        }

        content = replaceInlineArticleLinks(
            content,
            sourceArticles,
            mapEntries,
        );

        const output = needsMatterSerialization
                ? matter.stringify(content, document.data)
                : document.raw;
        outputs.set(
            articleId,
            matchDocumentLineEndings(
                output,
                document.lineEndingSource || document.raw,
            ),
        );
    }

    return outputs;
}

function runStandalone(argv = process.argv.slice(2)) {
    const positional = argv.filter((argument) => argument !== '--check');
    const checkOnly = argv.includes('--check');
    if (positional.length !== 2) {
        throw new TypeError(
            '使用方法: node scripts/generate-series-links.js <pre-publish-dir> <articles-dir> [--check]',
        );
    }

    const sourceDir = path.resolve(positional[0]);
    const targetDir = path.resolve(positional[1]);
    const repoRoot = path.dirname(sourceDir);
    const context = loadIdentityContext({
        repoRoot,
        sourceDir,
        targetDir,
    });
    const documents = new Map();

    for (const [articleId, target] of context.targetArticles) {
        documents.set(articleId, {
            articleId,
            slug: target.slug,
            data: target.data,
            content: target.content,
            raw: target.raw,
            lineEndingSource: target.raw,
        });
    }

    const outputs = generateArticleOutputs({
        documents,
        sourceArticles: context.sourceArticles,
        mapEntries: context.mapEntries,
    });
    const changes = [];

    for (const [articleId, output] of outputs) {
        const target = context.targetArticles.get(articleId);
        if (output !== target.raw) {
            changes.push(target.file);
            if (!checkOnly) {
                fs.writeFileSync(target.filePath, output, 'utf8');
            }
        }
    }

    console.log(
        `${checkOnly ? 'Series check' : 'Series generation'} completed: ${changes.length} change(s).`,
    );
    return { changes };
}

module.exports = {
    SERIES_END,
    SERIES_START,
    buildSeriesGroups,
    generateArticleOutputs,
    insertOrReplaceSeriesBlock,
    matchDocumentLineEndings,
    replaceInlineArticleLinks,
    runStandalone,
};

if (require.main === module) {
    try {
        runStandalone();
    } catch (error) {
        console.error(formatIdentityError(error));
        process.exitCode = 1;
    }
}
