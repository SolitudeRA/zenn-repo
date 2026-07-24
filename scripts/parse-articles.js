'use strict';

const fs = require('fs-extra');
const matter = require('gray-matter');
const path = require('node:path');
const {
    formatIdentityError,
    loadIdentityContext,
    serializeArticleMap,
} = require('./article-identity');
const {
    generateArticleOutputs,
    matchDocumentLineEndings,
} = require('./generate-series-links');

function quoted(value) {
    return JSON.stringify(String(value));
}

function buildMetadata(source, target) {
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

    const metadata = {
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

function serializeIntermediateArticle(metadata, sourceBody) {
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

function buildArticles(options = {}) {
    const write = options.write !== false;
    const context = loadIdentityContext(options);
    const nextMapEntries = new Map(context.mapEntries);
    const documents = new Map();

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
            filePath: path.join(context.targetDir, `${binding.slug}.md`),
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
    const changes = [];

    for (const [articleId, output] of outputs) {
        const document = documents.get(articleId);
        const oldOutput = context.targetArticles.get(articleId)?.raw;
        if (output !== oldOutput) {
            changes.push(path.relative(context.repoRoot, document.filePath));
        }
    }

    let oldMapOutput = null;
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
            const document = documents.get(articleId);
            const oldOutput = context.targetArticles.get(articleId)?.raw;
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

function runCli(argv = process.argv.slice(2)) {
    const checkOnly = argv.includes('--check');
    const baseRefArguments = argv.filter((argument) =>
        argument.startsWith('--base-ref='),
    );
    const unknown = argv.filter(
        (argument) =>
            argument !== '--check' && !argument.startsWith('--base-ref='),
    );
    if (unknown.length > 0) {
        throw new TypeError(`Unknown argument(s): ${unknown.join(', ')}`);
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
