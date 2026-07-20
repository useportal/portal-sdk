#!/usr/bin/env node
// Extracts every ```ts / ```tsx fenced code block from docs-site/docs/**/*.md and
// typechecks them against the real, published @portalsdk packages installed in this
// directory's node_modules (see package.json — pinned to the exact npm versions the
// docs claim to document).
//
// Convention: a block whose first line is `// file: <name>` is written to <name>
// inside that markdown file's own generated directory, so sibling blocks in the same
// doc can import each other (e.g. a component + the app that mounts it). Blocks
// without that marker must be fully standalone and are written to an auto-named file.
// This mirrors how the docs actually show multi-file examples.

import { readdirSync, statSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, relative, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "..", "docs");
const GENERATED_ROOT = join(HERE, ".generated");

const PACKAGE_JSON = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const PINNED_PACKAGES = ["@portalsdk/core", "@portalsdk/react", "@portalsdk/config"];

const FENCE_RE = /```(ts|tsx)\r?\n([\s\S]*?)```/g;
const FILE_MARKER_RE = /^\/\/\s*file:\s*(\S+)\s*\r?\n/;

function findMarkdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...findMarkdownFiles(full));
    } else if (extname(entry) === ".md") {
      out.push(full);
    }
  }
  return out;
}

function slugFor(mdPath) {
  return relative(DOCS_ROOT, mdPath).replace(/[\\/]/g, "__").replace(/\.md$/, "");
}

function extractBlocks(source) {
  const blocks = [];
  let match;
  while ((match = FENCE_RE.exec(source)) !== null) {
    const [, lang, body] = match;
    blocks.push({ lang, body });
  }
  return blocks;
}

function main() {
  rmSync(GENERATED_ROOT, { recursive: true, force: true });
  mkdirSync(GENERATED_ROOT, { recursive: true });

  const mdFiles = findMarkdownFiles(DOCS_ROOT);
  const manifest = []; // { generatedPath, mdPath, blockIndex }
  let total = 0;

  for (const mdPath of mdFiles) {
    const source = readFileSync(mdPath, "utf8");
    const blocks = extractBlocks(source);
    if (blocks.length === 0) continue;

    const slug = slugFor(mdPath);
    const outDir = join(GENERATED_ROOT, slug);
    mkdirSync(outDir, { recursive: true });

    let autoIndex = 0;
    for (const block of blocks) {
      total++;
      const markerMatch = block.body.match(FILE_MARKER_RE);
      let filename;
      let content;
      if (markerMatch) {
        filename = markerMatch[1];
        content = block.body.slice(markerMatch[0].length);
      } else {
        autoIndex++;
        filename = `block-${autoIndex}.${block.lang}`;
        content = block.body;
      }
      const outPath = join(outDir, filename);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, content, "utf8");
      manifest.push({ generatedPath: relative(HERE, outPath), mdPath: relative(join(HERE, ".."), mdPath) });
    }
  }

  if (total === 0) {
    console.error("No ts/tsx code samples found under docs-site/docs — nothing to check.");
    process.exit(1);
  }

  console.log(`Extracted ${total} ts/tsx sample(s) from ${mdFiles.length} markdown file(s).`);

  const tsc = join(HERE, "node_modules", ".bin", "tsc");
  const result = spawnSync(tsc, ["-p", "tsconfig.json", "--noEmit"], {
    cwd: HERE,
    encoding: "utf8",
  });

  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);

  if (result.status !== 0) {
    console.error("\nSample typecheck FAILED. Generated files are under docs-site/samples-check/.generated/");
    console.error("Each generated file maps 1:1 to a fenced code block in the docs listed below:\n");
    for (const entry of manifest) {
      console.error(`  ${entry.generatedPath}  <-  ${entry.mdPath}`);
    }
    process.exit(result.status ?? 1);
  }

  const pins = PINNED_PACKAGES.map(
    (name) => `${name}@${PACKAGE_JSON.devDependencies?.[name] ?? "?"}`,
  ).join(", ");
  console.log(`\nAll ${total} sample(s) typecheck cleanly against:`);
  console.log(`  ${pins}`);
}

main();
