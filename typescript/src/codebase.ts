import { ParseResult, Language } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import { parseFile } from "./ast-parser.js";

/**
 * File entry in a codebase
 */
export interface FileEntry {
  filename: string;
  filepath: string;
  relativePath: string;
  language: Language;
  parseResult: ParseResult | null;
  imports: string[];
  exports: string[];
  lineCount: number;
  isStub: boolean;
}

/**
 * Dependency graph node
 */
export interface DepNode {
  relativePath: string;
  dependents: string[];
  dependencies: string[];
}

/**
 * Dependency graph for a codebase
 */
export interface DepGraph {
  nodes: Map<string, DepNode>;
}

/**
 * Parse all files in a directory or a single file with given language
 */
export function parseDirectory(
  dirPath: string,
  language: Language,
  extensions: string[] = [".ts", ".tsx", ".rs", ".kt", ".cpp"],
): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();

  // Handle single file input
  if (fs.statSync(dirPath).isFile()) {
    const ext = path.extname(dirPath);
    if (extensions.includes(ext)) {
      const filename = path.basename(dirPath);
      const parseResult = parseFile(dirPath, language);
      const fileContent = fs.readFileSync(dirPath, "utf-8");
      const lineCount = fileContent.split("\n").length;

      files.set(filename, {
        filename,
        filepath: dirPath,
        relativePath: filename,
        language,
        parseResult,
        imports: parseResult?.importPaths || [],
        exports: parseResult?.exportPaths || [],
        lineCount,
        isStub: lineCount < 10,
      });
    }
    return files;
  }

  function walk(currentPath: string, relativePath: string) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const entryRelPath = path.join(relativePath, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, .git, etc.
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name === "build" ||
          entry.name === "target"
        ) {
          continue;
        }

        walk(fullPath, entryRelPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);

        // Check if file extension matches language
        let shouldParse = false;
        switch (language) {
          case Language.TYPESCRIPT:
            shouldParse = [".ts", ".tsx"].includes(ext);
            break;
          case Language.RUST:
            shouldParse = ext === ".rs";
            break;
          case Language.KOTLIN:
            shouldParse = ext === ".kt";
            break;
          case Language.CPP:
            shouldParse = [".cpp", ".cc", ".cxx", ".hpp", ".h"].includes(ext);
            break;
        }

        if (!shouldParse) continue;

        const parseResult = parseFile(fullPath, language);

        // Count lines
        const content = fs.readFileSync(fullPath, "utf-8");
        const lineCount = content.split("\n").length;

        // Check for stub file markers
        const isStub =
          content.includes("TODO:") ||
          content.includes("FIXME:") ||
          content.includes("// ..") ||
          content.includes("// placeholder");

        files.set(entryRelPath, {
          filename: entry.name,
          filepath: fullPath,
          relativePath: entryRelPath,
          language,
          parseResult,
          imports: parseResult?.importPaths || [],
          exports: parseResult?.exportPaths || [],
          lineCount,
          isStub,
        });
      }
    }
  }

  walk(dirPath, "");
  return files;
}

/**
 * Build dependency graph from file entries
 */
export function buildDepGraph(files: Map<string, FileEntry>): DepGraph {
  const nodes = new Map<string, DepNode>();

  // Initialize nodes
  for (const [relPath, file] of files.entries()) {
    nodes.set(relPath, {
      relativePath: relPath,
      dependents: [],
      dependencies: [],
    });
  }

  // Build edges
  for (const [relPath, file] of files.entries()) {
    const imports = file.imports;

    for (const imp of imports) {
      // Try to find matching file
      for (const [otherPath, otherFile] of files.entries()) {
        if (
          imp.includes(otherFile.filename) ||
          imp.includes(otherPath.replace(/\.(ts|tsx|rs|kt|cpp)$/, ""))
        ) {
          const node = nodes.get(relPath);
          const otherNode = nodes.get(otherPath);

          if (node && otherNode && relPath !== otherPath) {
            node.dependencies.push(otherPath);
            otherNode.dependents.push(relPath);
          }
        }
      }
    }
  }

  return { nodes };
}

/**
 * Rank files by porting priority based on dependents and similarity
 */
export function rankPortingPriority(
  srcFiles: Map<string, FileEntry>,
  tgtFiles: Map<string, FileEntry>,
  depGraph: DepGraph,
): Array<{ path: string; priority: number; dependents: number }> {
  const rankings: Array<{
    path: string;
    priority: number;
    dependents: number;
  }> = [];

  // Find files in source not in target
  for (const [srcPath, srcFile] of srcFiles.entries()) {
    // Check if already ported (by exact match or port-lint header)
    let isPorted = false;
    if (tgtFiles.has(srcPath)) {
      isPorted = true;
    } else {
      // Check port-lint headers in target
      for (const tgtFile of tgtFiles.values()) {
        if (tgtFile.parseResult?.portLintHeader?.sourcePath === srcPath) {
          isPorted = true;
          break;
        }
      }
    }

    if (isPorted) continue;

    // Calculate priority based on dependents
    const node = depGraph.nodes.get(srcPath);
    const dependents = node?.dependents.length || 0;

    // Normalize priority (simple heuristic: more dependents = higher priority)
    rankings.push({
      path: srcPath,
      priority: dependents,
      dependents,
    });
  }

  // Sort by priority (highest first)
  rankings.sort((a, b) => b.priority - a.priority);

  return rankings;
}

/**
 * Find missing files in target directory
 */
export function findMissingFiles(
  srcFiles: Map<string, FileEntry>,
  tgtFiles: Map<string, FileEntry>,
): Array<{
  path: string;
  matchedBy: "header" | "name" | "none";
  priority: number;
}> {
  const missing: Array<{
    path: string;
    matchedBy: "header" | "name" | "none";
    priority: number;
  }> = [];

  // Create lookup for ported files by header
  const portedByHeader = new Map<string, FileEntry>();
  for (const tgtFile of tgtFiles.values()) {
    if (tgtFile.parseResult?.portLintHeader) {
      portedByHeader.set(
        tgtFile.parseResult.portLintHeader.sourcePath,
        tgtFile,
      );
    }
  }

  for (const [srcPath, srcFile] of srcFiles.entries()) {
    // Check if ported by exact path
    if (tgtFiles.has(srcPath)) {
      continue;
    }

    // Check if ported by header
    if (portedByHeader.has(srcPath)) {
      continue;
    }

    missing.push({
      path: srcPath,
      matchedBy: "none",
      priority: 0, // Will be calculated from dependency graph
    });
  }

  return missing;
}

/**
 * Print codebase statistics
 */
export function printCodebaseStats(files: Map<string, FileEntry>): void {
  console.log("=== Codebase Statistics ===\n");

  let totalFiles = 0;
  let totalLines = 0;
  let stubFiles = 0;
  let todoCount = 0;

  for (const file of files.values()) {
    totalFiles++;
    totalLines += file.lineCount;
    if (file.isStub) stubFiles++;

    // Count TODOs in parse results
    if (file.parseResult?.tree) {
      const content = fs.readFileSync(file.filepath, "utf-8");
      const todoMatches = content.match(/TODO/gi);
      if (todoMatches) {
        todoCount += todoMatches.length;
      }
    }
  }

  console.log(`Total files:       ${totalFiles}`);
  console.log(`Total lines:       ${totalLines}`);
  console.log(`Stub files:        ${stubFiles}`);
  console.log(`TODO comments:     ${todoCount}`);
  console.log(`Avg lines/file:    ${(totalLines / totalFiles).toFixed(1)}\n`);
}
