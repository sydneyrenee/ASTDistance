import * as fs from "fs";
import * as path from "path";
import { Language } from "./types.js";
import type { ParseResult } from "./types.js";
import { combinedSimilarityWithContent, docCosineSimilarity } from "./similarity.js";
import { buildDepGraph, parseDirectory } from "./codebase.js";
import type { FileEntry, DepGraph } from "./codebase.js";

export interface Match {
  sourcePath: string;
  targetPath: string;
  sourceQualified: string;
  targetQualified: string;
  similarity: number;
  sourceDependents: number;
  targetDependents: number;
  sourceLines: number;
  targetLines: number;
  todoCount: number;
  lintCount: number;
  isStub: boolean;
  matchedByHeader: boolean;

  // Function parity (by canonicalized name)
  sourceFunctionCount: number;
  targetFunctionCount: number;
  matchedFunctionCount: number;
  functionCoverage: number; // matched / source

  // Documentation stats
  sourceDocLines: number;
  targetDocLines: number;
  sourceDocComments: number;
  targetDocComments: number;
  docSimilarity: number;
}

const HEADER_EXTENSIONS = new Set([".hpp", ".h", ".hxx", ".hh"]);

function canonicalizeName(name: string): string {
  return name.replace(/[_-]/g, "").toLowerCase();
}

function isHeaderFile(entry: FileEntry): boolean {
  for (const p of entry.paths) {
    if (HEADER_EXTENSIONS.has(path.extname(p))) return true;
  }
  return false;
}

function countTodosInPaths(paths: string[]): number {
  let count = 0;
  for (const p of paths) {
    try {
      const text = fs.readFileSync(p, "utf8");
      const matches = text.match(/TODO/gi);
      if (matches) count += matches.length;
    } catch {
      // ignore
    }
  }
  return count;
}

function functionNameCoverage(src: ParseResult, tgt: ParseResult): {
  sourceTotal: number;
  targetTotal: number;
  matched: number;
  ratio: number;
} {
  const srcNames = (src.functionNames || [])
    .filter((n) => n && n !== "<anonymous>")
    .map(canonicalizeName);
  const tgtNames = (tgt.functionNames || [])
    .filter((n) => n && n !== "<anonymous>")
    .map(canonicalizeName);

  const sourceTotal = srcNames.length;
  const targetTotal = tgtNames.length;

  if (sourceTotal === 0) {
    return { sourceTotal, targetTotal, matched: 0, ratio: 1.0 };
  }

  const tgtCounts = new Map<string, number>();
  for (const n of tgtNames) {
    tgtCounts.set(n, (tgtCounts.get(n) || 0) + 1);
  }

  let matched = 0;
  for (const n of srcNames) {
    const v = tgtCounts.get(n) || 0;
    if (v > 0) {
      matched++;
      tgtCounts.set(n, v - 1);
    }
  }

  return { sourceTotal, targetTotal, matched, ratio: matched / sourceTotal };
}

export class CodebaseComparator {
  sourceRoot: string;
  targetRoot: string;
  sourceLang: Language;
  targetLang: Language;
  sourceFiles: Map<string, FileEntry>;
  targetFiles: Map<string, FileEntry>;
  sourceDeps: DepGraph;
  targetDeps: DepGraph;

  matches: Match[] = [];
  unmatchedSource: string[] = [];
  unmatchedTarget: string[] = [];

  constructor(
    sourceRoot: string,
    sourceLang: Language,
    targetRoot: string,
    targetLang: Language,
  ) {
    this.sourceRoot = sourceRoot;
    this.targetRoot = targetRoot;
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;

    this.sourceFiles = parseDirectory(sourceRoot, sourceLang);
    this.targetFiles = parseDirectory(targetRoot, targetLang);

    this.sourceDeps = buildDepGraph(this.sourceFiles);
    this.targetDeps = buildDepGraph(this.targetFiles);
  }

  private dependentsCount(graph: DepGraph, key: string): number {
    return graph.nodes.get(key)?.dependents.length || 0;
  }

  private nameMatchScore(src: FileEntry, tgt: FileEntry): number {
    const srcNorm = canonicalizeName(src.stem);
    const tgtNorm = canonicalizeName(tgt.stem);
    const srcQualNorm = canonicalizeName(src.qualifiedName);
    const tgtQualNorm = canonicalizeName(tgt.qualifiedName);

    const headerBoost = isHeaderFile(tgt) ? 0.02 : 0.0;

    if (srcQualNorm === tgtQualNorm) return 1.0 + headerBoost;

    function parentQualified(q: string): string {
      const i = q.lastIndexOf(".");
      return i >= 0 ? q.slice(0, i) : "";
    }
    const srcParent = parentQualified(src.qualifiedName);
    const tgtParent = parentQualified(tgt.qualifiedName);

    if (srcNorm === tgtNorm && srcParent && tgtParent) {
      if (canonicalizeName(srcParent) === canonicalizeName(tgtParent)) {
        return 0.95 + headerBoost;
      }
    }

    if (srcNorm === tgtNorm) return 0.7 + headerBoost;

    if (tgtNorm.includes(srcNorm)) {
      const ratio = srcNorm.length / Math.max(tgtNorm.length, 1);
      return 0.5 + 0.2 * ratio + headerBoost;
    }
    if (srcNorm.includes(tgtNorm)) {
      const ratio = tgtNorm.length / Math.max(srcNorm.length, 1);
      return 0.5 + 0.2 * ratio + headerBoost;
    }

    if (srcParent && tgtParent) {
      if (canonicalizeName(srcParent) === canonicalizeName(tgtParent)) {
        return 0.4 + headerBoost;
      }
    }

    return 0.0;
  }

  findMatches(): void {
    const matchedSources = new Set<string>();
    const matchedTargets = new Set<string>();

    // Build source relative path -> key index for port-lint header matching.
    const srcRelToKey = new Map<string, string>();
    for (const [key, sf] of this.sourceFiles.entries()) {
      srcRelToKey.set(sf.relativePath, key);
    }

    // Pass 1: port-lint header matching (explicit source tracking).
    const headerCandidates: Array<{ score: number; srcKey: string; tgtKey: string }> = [];
    for (const [tgtKey, tf] of this.targetFiles.entries()) {
      const srcPath = tf.parseResult?.portLintHeader?.sourcePath;
      if (!srcPath) continue;
      const srcKey = srcRelToKey.get(srcPath);
      if (!srcKey) continue;
      headerCandidates.push({ score: 1.0, srcKey, tgtKey });
    }
    headerCandidates.sort((a, b) => b.score - a.score);

    for (const c of headerCandidates) {
      if (matchedSources.has(c.srcKey) || matchedTargets.has(c.tgtKey)) continue;
      const sf = this.sourceFiles.get(c.srcKey)!;
      const tf = this.targetFiles.get(c.tgtKey)!;
      this.matches.push({
        sourcePath: c.srcKey,
        targetPath: c.tgtKey,
        sourceQualified: sf.qualifiedName,
        targetQualified: tf.qualifiedName,
        similarity: 0.0,
        sourceDependents: this.dependentsCount(this.sourceDeps, c.srcKey),
        targetDependents: this.dependentsCount(this.targetDeps, c.tgtKey),
        sourceLines: sf.lineCount,
        targetLines: tf.lineCount,
        todoCount: countTodosInPaths(tf.paths),
        lintCount: 0,
        isStub: tf.isStub,
        matchedByHeader: true,
        sourceFunctionCount: 0,
        targetFunctionCount: 0,
        matchedFunctionCount: 0,
        functionCoverage: 1.0,
        sourceDocLines: 0,
        targetDocLines: 0,
        sourceDocComments: 0,
        targetDocComments: 0,
        docSimilarity: 0.0,
      });
      matchedSources.add(c.srcKey);
      matchedTargets.add(c.tgtKey);
    }

    // Pass 2: name-based matching.
    const nameCandidates: Array<{ score: number; srcKey: string; tgtKey: string }> = [];
    for (const [srcKey, sf] of this.sourceFiles.entries()) {
      if (matchedSources.has(srcKey)) continue;
      for (const [tgtKey, tf] of this.targetFiles.entries()) {
        if (matchedTargets.has(tgtKey)) continue;
        const score = this.nameMatchScore(sf, tf);
        if (score > 0.4) {
          nameCandidates.push({ score, srcKey, tgtKey });
        }
      }
    }
    nameCandidates.sort((a, b) => b.score - a.score);

    for (const c of nameCandidates) {
      if (matchedSources.has(c.srcKey) || matchedTargets.has(c.tgtKey)) continue;
      const sf = this.sourceFiles.get(c.srcKey)!;
      const tf = this.targetFiles.get(c.tgtKey)!;
      this.matches.push({
        sourcePath: c.srcKey,
        targetPath: c.tgtKey,
        sourceQualified: sf.qualifiedName,
        targetQualified: tf.qualifiedName,
        similarity: 0.0,
        sourceDependents: this.dependentsCount(this.sourceDeps, c.srcKey),
        targetDependents: this.dependentsCount(this.targetDeps, c.tgtKey),
        sourceLines: sf.lineCount,
        targetLines: tf.lineCount,
        todoCount: countTodosInPaths(tf.paths),
        lintCount: 0,
        isStub: tf.isStub,
        matchedByHeader: false,
        sourceFunctionCount: 0,
        targetFunctionCount: 0,
        matchedFunctionCount: 0,
        functionCoverage: 1.0,
        sourceDocLines: 0,
        targetDocLines: 0,
        sourceDocComments: 0,
        targetDocComments: 0,
        docSimilarity: 0.0,
      });
      matchedSources.add(c.srcKey);
      matchedTargets.add(c.tgtKey);
    }

    this.unmatchedSource = [];
    this.unmatchedTarget = [];
    for (const k of this.sourceFiles.keys()) {
      if (!matchedSources.has(k)) this.unmatchedSource.push(k);
    }
    for (const k of this.targetFiles.keys()) {
      if (!matchedTargets.has(k)) this.unmatchedTarget.push(k);
    }
  }

  computeSimilarities(): void {
    for (const m of this.matches) {
      const sf = this.sourceFiles.get(m.sourcePath);
      const tf = this.targetFiles.get(m.targetPath);
      if (!sf || !tf) {
        m.similarity = -1.0;
        continue;
      }
      const sp = sf.parseResult;
      const tp = tf.parseResult;
      if (!sp || !tp) {
        m.similarity = -1.0;
        continue;
      }

      const { sourceTotal, targetTotal, matched, ratio } = functionNameCoverage(sp, tp);
      m.sourceFunctionCount = sourceTotal;
      m.targetFunctionCount = targetTotal;
      m.matchedFunctionCount = matched;
      m.functionCoverage = ratio;

      m.sourceDocLines = sp.commentStats.totalDocLines;
      m.targetDocLines = tp.commentStats.totalDocLines;
      m.sourceDocComments = sp.commentStats.docCommentCount;
      m.targetDocComments = tp.commentStats.docCommentCount;
      m.docSimilarity = docCosineSimilarity(sp.commentStats.wordFreq, tp.commentStats.wordFreq);

      // Guardrail: stubs in the target are a failure mode.
      const hasStubs = tf.isStub || tp.hasStubBodies;
      if (hasStubs) {
        m.similarity = 0.0;
        m.isStub = true;
        continue;
      }

      const fileSim = combinedSimilarityWithContent(sp, tp);
      m.similarity = fileSim * ratio;
    }
  }

  rankedForPorting(): Match[] {
    const result = [...this.matches];
    result.sort((a, b) => {
      const pa = a.sourceDependents * (1.0 - a.similarity);
      const pb = b.sourceDependents * (1.0 - b.similarity);
      return pb - pa;
    });
    return result;
  }

  formatReport(): string {
    const lines: string[] = [];
    lines.push("\n=== Codebase Comparison Report ===\n");
    lines.push(`Source: ${this.sourceRoot} (${this.sourceFiles.size} files)`);
    lines.push(`Target: ${this.targetRoot} (${this.targetFiles.size} files)`);
    lines.push("");
    lines.push(`Matched:   ${this.matches.length} files`);
    lines.push(
      `Unmatched: ${this.unmatchedSource.length} source, ${this.unmatchedTarget.length} target`,
    );
    lines.push("");

    if (this.matches.length > 0) {
      lines.push("=== Matched Files (by porting priority) ===\n");
      lines.push(
        `${"Source".padEnd(30)} ${"Target".padEnd(30)} ${"Similarity".padStart(10)} ${"Dependents".padStart(11)} ${"FunctionParity".padStart(14)} ${"Priority".padStart(9)}`,
      );
      lines.push("-".repeat(110));
      for (const m of this.rankedForPorting()) {
        const priority = m.sourceDependents * (1.0 - m.similarity);
        const funcs =
          m.sourceFunctionCount > 0
            ? `${m.matchedFunctionCount}/${m.sourceFunctionCount}`
            : "-";
        lines.push(
          `${m.sourceQualified.slice(0, 28).padEnd(30)} ${m.targetQualified
            .slice(0, 28)
            .padEnd(30)} ${m.similarity.toFixed(2).padStart(10)} ${String(m.sourceDependents).padStart(11)} ${funcs.padStart(14)} ${priority.toFixed(1).padStart(9)}`,
        );
      }
    }

    if (this.unmatchedSource.length > 0) {
      lines.push("\n=== Missing from Target (need to port) ===\n");
      const missing = [...this.unmatchedSource]
        .map((key) => ({ key, file: this.sourceFiles.get(key) }))
        .filter((x): x is { key: string; file: FileEntry } => Boolean(x.file))
        .sort((a, b) => this.dependentsCount(this.sourceDeps, b.key) - this.dependentsCount(this.sourceDeps, a.key));

      let shown = 0;
      for (const it of missing) {
        if (shown++ >= 20) {
          lines.push(`... and ${missing.length - 20} more missing files`);
          break;
        }
        const deps = this.dependentsCount(this.sourceDeps, it.key);
        lines.push(`  ${it.file.qualifiedName} (${deps} dependents)`);
      }
    }

    return lines.join("\n") + "\n";
  }
}
