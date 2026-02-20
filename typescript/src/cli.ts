#!/usr/bin/env node

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import chalk from "chalk";
import { parseFile } from "./ast-parser.js";
import {
  computeSimilarity,
  printSimilarityReport,
  combinedSimilarityWithContent,
  identifierCosineSimilarity,
  canonicalIdentifierCosineSimilarity,
  canonicalIdentifierJaccardSimilarity,
} from "./similarity.js";
import {
  parseDirectory,
  buildDepGraph,
  rankPortingPriority,
  findMissingFiles,
  printCodebaseStats,
} from "./codebase.js";
import { CodebaseComparator } from "./codebase-comparator.js";
import { Language } from "./types.js";
import { TaskManager, TaskStatus } from "./task-manager.js";
import {
  AgentLock,
  printAndClearAgentNotice,
  printAgentActivitySection,
  touchAgentLastUsed,
  writeAgentNotice,
} from "./agent-guardrails.js";

const program = new Command();

type GuardrailsContext = {
  active: boolean;
  taskFile: string;
  agent: number;
  overrideMode: boolean;
};

const GUARD: GuardrailsContext = {
  active: false,
  taskFile: "",
  agent: 0,
  overrideMode: false,
};

let gAgentLock: AgentLock | null = null;

function refusePipedStdio(): void {
  // Refuse to run when stdout or stderr is piped via a shell pipeline.
  // This blocks `ast_distance ... | sed/grep/...` which has caused model-driven
  // wrappers to silently filter or truncate dashboards.
  //
  // We intentionally allow non-terminal stdout when the caller captures output
  // directly (e.g. a wrapper process reading from a pipe), because that is not
  // the same failure mode as shell filtering commands like `sed`/`grep`.
  function detectPipelinePeerProcess(): boolean {
    const selfPid = process.pid;
    const ps = spawnSync(
      "ps",
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
      { encoding: "utf8" },
    );
    if (ps.status !== 0 || typeof ps.stdout !== "string") {
      return true;
    }

    type Row = { pid: number; ppid: number; pgid: number };
    const rows: Row[] = [];
    const ppidByPid = new Map<number, number>();

    let pgid: number | null = null;
    for (const line of ps.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const pg = Number(parts[2]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(pg)) {
        continue;
      }
      rows.push({ pid, ppid, pgid: pg });
      ppidByPid.set(pid, ppid);
      if (pid === selfPid) {
        pgid = pg;
      }
    }
    if (pgid === null) {
      return true;
    }

    const ancestors = new Set<number>();
    let cur = selfPid;
    for (let i = 0; i < 64; i++) {
      const parent = ppidByPid.get(cur) ?? 0;
      if (parent <= 0) break;
      if (ancestors.has(parent)) break;
      ancestors.add(parent);
      cur = parent;
    }

    for (const r of rows) {
      if (r.pgid !== pgid) continue;
      if (r.pid === selfPid) continue;
      if (ancestors.has(r.pid)) continue;
      if (r.ppid === selfPid) continue; // our own child
      return true;
    }

    return false;
  }

  try {
    const out = fs.fstatSync(process.stdout.fd);
    if (out.isFIFO()) {
      if (!detectPipelinePeerProcess()) {
        return;
      }
      process.stderr.write(
        "Error: stdout is piped to another program.\n" +
          "ast_distance does not support piping (|).\n" +
          "Run it directly in a terminal.\n",
      );
      process.exit(2);
    }
  } catch {
    // ignore
  }
  try {
    const err = fs.fstatSync(process.stderr.fd);
    if (err.isFIFO()) {
      if (!detectPipelinePeerProcess()) {
        return;
      }
      process.stdout.write(
        "Error: stderr is piped to another program.\n" +
          "ast_distance does not support piping (|).\n" +
          "Run it directly in a terminal.\n",
      );
      process.exit(2);
    }
  } catch {
    // ignore
  }
}

refusePipedStdio();

function parseLanguage(lang: string): Language {
  const normalized = lang.toLowerCase();
  switch (normalized) {
    case "typescript":
    case "ts":
    case "tsx":
      return Language.TYPESCRIPT;
    case "rust":
    case "rs":
      return Language.RUST;
    case "kotlin":
    case "kt":
      return Language.KOTLIN;
    case "cpp":
    case "c++":
      return Language.CPP;
    case "c":
      return Language.C;
    default:
      throw new Error(
        `Unknown language: ${lang} (use typescript, rust, kotlin, cpp, or c)`,
      );
  }
}

function dumpTree(node: any, indent: number = 0): void {
  const pad = "  ".repeat(indent);
  console.log(`${pad}${node.nodeType} (${node.label})`);

  for (const child of node.children) {
    dumpTree(child, indent + 1);
  }
}

function containsMacroRules(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf-8").includes("macro_rules!");
  } catch {
    return false;
  }
}

program
  .name("ast-distance")
  .description("Cross-language AST comparison and porting analysis tool")
  .version("0.1.0");

// Compare two files
program
  .argument("<file1>")
  .argument("<lang1>")
  .argument("<file2>")
  .argument("<lang2>")
  .action(async (file1, lang1, file2, lang2) => {
    const l1 = parseLanguage(lang1);
    const l2 = parseLanguage(lang2);

    const result1 = parseFile(file1, l1);
    const result2 = parseFile(file2, l2);

    if (!result1 || !result2) {
      console.error(chalk.red("Failed to parse files"));
      process.exit(1);
    }

    const macroFriendly =
      (l1 === Language.RUST && containsMacroRules(file1)) ||
      (l2 === Language.RUST && containsMacroRules(file2));

    printSimilarityReport(result1, result2, {
      macroFriendly,
      includeContent: false,
    });

    const shape = computeSimilarity(result1, result2, { macroFriendly });
    const contentScore = combinedSimilarityWithContent(result1, result2, {
      macroFriendly,
    });

    console.log("=== Identifier Content Analysis ===");
    console.log(
      `Identifiers:          ${result1.identifierStats.totalIdentifiers} vs ${result2.identifierStats.totalIdentifiers}`,
    );
    console.log(
      `Unique (raw):         ${result1.identifierStats.identifierFreq.size} vs ${result2.identifierStats.identifierFreq.size}`,
    );
    console.log(
      `Unique (canonical):   ${result1.identifierStats.canonicalFreq.size} vs ${result2.identifierStats.canonicalFreq.size}`,
    );
    console.log(
      `Raw cosine:           ${identifierCosineSimilarity(result1.identifierStats, result2.identifierStats).toFixed(4)}`,
    );
    console.log(
      `Canonical cosine:     ${canonicalIdentifierCosineSimilarity(result1.identifierStats, result2.identifierStats).toFixed(4)}`,
    );
    console.log(
      `Canonical jaccard:    ${canonicalIdentifierJaccardSimilarity(result1.identifierStats, result2.identifierStats).toFixed(4)}`,
    );

    if (result1.hasStubBodies || result2.hasStubBodies) {
      console.log("\n*** STUB DETECTED ***");
      if (result1.hasStubBodies) {
        console.log(`  ${file1} has TODO/stub/placeholder in function bodies`);
      }
      if (result2.hasStubBodies) {
        console.log(`  ${file2} has TODO/stub/placeholder in function bodies`);
      }
      console.log("  Content-Aware Score forced to 0.0000");
    } else {
      console.log(`\nContent-Aware Score:  ${contentScore.toFixed(4)}`);
    }

    console.log(`Shape Combined Score: ${shape.combined.toFixed(4)}`);
    console.log(`Shape Histogram:      ${shape.cosineHistogram.toFixed(4)}`);
  });

// Dump AST
program
  .command("dump")
  .argument("<file>")
  .argument("<lang>")
  .action((file, lang) => {
    const result = parseFile(file, parseLanguage(lang));

    if (!result) {
      console.error(chalk.red("Failed to parse file"));
      process.exit(1);
    }

    console.log(`=== AST Dump: ${file} ===\n`);
    dumpTree(result.tree);
  });

// Scan directory
program
  .command("scan")
  .argument("<directory>")
  .argument("<lang>")
  .action((directory, lang) => {
    console.log(`Scanning ${directory} for ${lang} files...\n`);

    const files = parseDirectory(directory, parseLanguage(lang));
    printCodebaseStats(files);

    console.log("=== File List ===\n");

    for (const [relPath, file] of files.entries()) {
      const status = file.isStub ? chalk.yellow("[STUB]") : chalk.green("[OK]");
      const linesStr = file.lineCount.toString().padStart(5);
      console.log(`${status} ${linesStr} lines  ${relPath}`);
    }
  });

// Deep analysis
program
  .command("deep")
  .argument("<srcDir>")
  .argument("<srcLang>")
  .argument("<tgtDir>")
  .argument("<tgtLang>")
  .action(async (srcDir, srcLang, tgtDir, tgtLang) => {
    const sl = parseLanguage(srcLang);
    const tl = parseLanguage(tgtLang);

    console.log(chalk.bold("=== Deep Analysis ===\n"));
    console.log(`Source: ${srcDir} (${srcLang})`);
    console.log(`Target: ${tgtDir} (${tgtLang})\n`);

    const comp = new CodebaseComparator(srcDir, sl, tgtDir, tl);

    console.log(chalk.bold("Source Statistics:"));
    printCodebaseStats(comp.sourceFiles);

    console.log(chalk.bold("Target Statistics:"));
    printCodebaseStats(comp.targetFiles);

    console.log("Comparing codebases...");
    comp.findMatches();

    console.log("Computing AST similarities...");
    comp.computeSimilarities();

    // Agent-scoped dashboard (guardrails): when a task system is initialized, lock the
    // dashboard view to the assigned file and its direct imports.
    if (GUARD.active && GUARD.agent > 0 && !GUARD.overrideMode) {
      const tm = new TaskManager(GUARD.taskFile);
      if (tm.load()) {
        printAgentActivitySection(tm, GUARD.taskFile, GUARD.agent);

        const agentId = String(GUARD.agent);
        const focus = tm.tasks.find(
          (t) => t.status === TaskStatus.ASSIGNED && String(t.assigned_to) === agentId,
        );

        console.log(chalk.bold("\n=== Agent Scope Dashboard ===\n"));
        console.log(`Task file: ${GUARD.taskFile}`);
        console.log(`You are agent #${GUARD.agent}\n`);

        if (!focus) {
          console.log(`No task assigned to agent #${GUARD.agent}.`);
          console.log(`Run: ast_distance --assign ${GUARD.taskFile} ${GUARD.agent}\n`);
          console.log("Note: full project dashboard is locked in agent scope.");
          console.log("Use --override if you need full-project output.");
          return;
        }

        const srcRelToKey = new Map<string, string>();
        for (const [key, f] of comp.sourceFiles.entries()) {
          srcRelToKey.set(f.relativePath, key);
        }
        const tgtRelToKey = new Map<string, string>();
        for (const [key, f] of comp.targetFiles.entries()) {
          tgtRelToKey.set(f.relativePath, key);
        }

        const focusSrcKey = srcRelToKey.get(focus.source_path) || "";
        const focusTgtKey = tgtRelToKey.get(focus.target_path) || "";

        const focusSourcePath = path.join(tm.source_root, focus.source_path);
        const focusTargetPath = path.join(tm.target_root, focus.target_path);

        console.log(`Assigned task: ${focus.source_qualified}`);
        console.log(
          `Source: ${focusSourcePath}${fs.existsSync(focusSourcePath) ? "" : " (missing?)"}`,
        );
        console.log(
          `Target: ${focusTargetPath} (${fs.existsSync(focusTargetPath) ? "exists" : "missing"})\n`,
        );

        const scopeSourceKeys = new Set<string>();
        const scopeTargetKeys = new Set<string>();
        if (focusSrcKey) {
          scopeSourceKeys.add(focusSrcKey);
          const deps = comp.sourceDeps.nodes.get(focusSrcKey)?.dependencies || [];
          for (const k of deps) scopeSourceKeys.add(k);
        }
        if (focusTgtKey) {
          scopeTargetKeys.add(focusTgtKey);
          const deps = comp.targetDeps.nodes.get(focusTgtKey)?.dependencies || [];
          for (const k of deps) scopeTargetKeys.add(k);
        }

        console.log(
          `Scope: ${scopeSourceKeys.size} source files (focus + imports), ${scopeTargetKeys.size} target files (focus + imports)\n`,
        );

        const matchBySource = new Map<string, any>();
        for (const m of comp.matches) {
          matchBySource.set(m.sourcePath, m);
        }
        const unmatchedSource = new Set(comp.unmatchedSource);

        // Determine which scoped imports are already assigned to other agents.
        const assignedBySourcePath = new Map<string, string>();
        for (const t of tm.tasks) {
          if (t.status !== TaskStatus.ASSIGNED) continue;
          if (!t.source_path) continue;
          if (String(t.assigned_to) === agentId) continue;
          assignedBySourcePath.set(t.source_path, String(t.assigned_to || ""));
        }

        console.log(
          `${"Source".padEnd(30)} ${"Dependents".padStart(11)} ${"Similarity".padStart(11)} ${"TODOs".padStart(8)} ${"Stub".padStart(6)} Status`,
        );
        console.log("-".repeat(90));

        function printRow(key: string, isFocus: boolean): void {
          const sf = comp.sourceFiles.get(key);
          if (!sf) return;
          const deps = comp.sourceDeps.nodes.get(key)?.dependents.length || 0;
          const match = matchBySource.get(key);
          const sim = match ? match.similarity : 0.0;
          const todos = match ? match.todoCount : 0;
          const stub = match ? (match.isStub ? "STUB" : "") : "";

          let status = isFocus ? "FOCUS" : "";
          const otherAgent = assignedBySourcePath.get(sf.relativePath);
          if (otherAgent) {
            status = status ? `${status},ASSIGNED:${otherAgent}` : `ASSIGNED:${otherAgent}`;
          }
          if (unmatchedSource.has(key)) {
            status = status ? `${status},MISSING_TARGET` : "MISSING_TARGET";
          }

          console.log(
            `${sf.qualifiedName.slice(0, 28).padEnd(30)} ${String(deps).padStart(11)} ${sim.toFixed(2).padStart(11)} ${String(todos).padStart(8)} ${stub.padStart(6)} ${status}`,
          );
        }

        if (focusSrcKey) {
          printRow(focusSrcKey, true);
        } else {
          console.log(
            `${focus.source_qualified.slice(0, 28).padEnd(30)} ${String(focus.dependent_count || 0).padStart(11)} ${" -".padStart(11)} ${"0".padStart(8)} ${"".padStart(6)} FOCUS,UNKNOWN_SOURCE_PATH`,
          );
        }

        const others = [...scopeSourceKeys].filter((k) => k && k !== focusSrcKey);
        others.sort(
          (a, b) =>
            (comp.sourceDeps.nodes.get(b)?.dependents.length || 0) -
            (comp.sourceDeps.nodes.get(a)?.dependents.length || 0),
        );
        for (const k of others) {
          printRow(k, false);
        }

        console.log(chalk.bold("\n=== Next Action (Focus) ===\n"));
        const focusMatch = focusSrcKey ? matchBySource.get(focusSrcKey) : null;
        if (!focusMatch || (focusSrcKey && unmatchedSource.has(focusSrcKey))) {
          console.log("Target file is missing. Create it and port the full implementation.");
        } else if (focusMatch.isStub) {
          console.log("Replace the stub with a real implementation (stubs are a failure mode).");
        } else if (focusMatch.todoCount > 0) {
          console.log("Remove TODOs and finish the implementation (TODOs are a failure mode).");
        } else if (focusMatch.sourceFunctionCount > 0 && focusMatch.functionCoverage < 1.0) {
          console.log(
            `Add missing functions for parity (${focusMatch.matchedFunctionCount}/${focusMatch.sourceFunctionCount}).`,
          );
        } else if (focusMatch.similarity < 0.85) {
          console.log("Improve similarity to >= 0.85 (whole-file + identifier-content + parity).");
        } else {
          console.log("Looks complete. If you have validated behavior and tests, mark it complete.");
        }

        console.log("\nMark complete with:");
        console.log(
          `  ast_distance --agent ${GUARD.agent} --complete ${GUARD.taskFile} ${focus.source_qualified}`,
        );
        console.log("\nNote: full project dashboard is locked in agent scope.");
        console.log("Use --override to view the full project view.");
        return;
      }
    }

    console.log(comp.formatReport());

    // Porting quality summary
    console.log(chalk.bold("\n=== Porting Quality Summary ===\n"));
    const totalTodos = comp.matches.reduce((a, m) => a + m.todoCount, 0);
    const totalLint = comp.matches.reduce((a, m) => a + m.lintCount, 0);
    const stubCount = comp.matches.filter((m) => m.isStub).length;
    const headerMatched = comp.matches.filter((m) => m.matchedByHeader).length;
    const totalMatched = comp.matches.length;
    const ranked = comp.rankedForPorting();
    const incomplete = ranked.filter((m) => m.similarity < 0.6).length;
    const missingCount = comp.unmatchedSource.length;

    console.log(`Matched by header:     ${headerMatched} / ${totalMatched}`);
    console.log(`Matched by name:       ${totalMatched - headerMatched} / ${totalMatched}`);
    console.log(`Total TODOs in target: ${totalTodos}`);
    console.log(`Total lint errors:     ${totalLint}`);
    console.log(`Stub files:            ${stubCount}`);

    const issues = ranked.filter(
      (m) =>
        m.todoCount > 0 ||
        m.lintCount > 0 ||
        m.isStub ||
        m.similarity < 0.6 ||
        (m.sourceFunctionCount > 0 && m.functionCoverage < 1.0),
    );

    if (issues.length > 0) {
      console.log(chalk.bold("\n=== Files with Issues ===\n"));
      console.log(
        `${"File".padEnd(30)} ${"Similarity".padStart(10)} ${"LineRatio".padStart(9)} ${"FunctionParity".padStart(14)} ${"TODOs".padStart(5)} ${"Lint".padStart(5)} Status`,
      );
      console.log("-".repeat(90));
      for (const m of issues.slice(0, 20)) {
        let status = "";
        if (m.isStub) status = "STUB";
        else if (m.todoCount > 0) status = "TODO";
        else if (m.lintCount > 0) status = "LINT";
        else if (m.sourceFunctionCount > 0 && m.functionCoverage < 1.0) status = "MISSING_FUNCTIONS";
        else if (m.similarity < 0.4) status = "LOW_SIM";

        const ratio = m.sourceLines > 0 ? m.targetLines / m.sourceLines : 0.0;
        const funcs =
          m.sourceFunctionCount > 0
            ? `${m.matchedFunctionCount}/${m.sourceFunctionCount}`
            : "-";
        console.log(
          `${m.targetQualified.slice(0, 28).padEnd(30)} ${m.similarity.toFixed(2).padStart(10)} ${ratio.toFixed(2).padStart(9)} ${funcs.padStart(14)} ${String(m.todoCount).padStart(5)} ${String(m.lintCount).padStart(5)} ${status}`,
        );
      }
      if (issues.length > 20) {
        console.log(`... and ${issues.length - 20} more files`);
      }
    }

    console.log(chalk.bold("\n=== Porting Recommendations ===\n"));
    console.log(`Incomplete ports (similarity < 60%): ${incomplete}`);
    console.log(`Missing files: ${missingCount}`);

    if (incomplete > 0) {
      console.log("\nTop priority to complete:");
      for (const m of ranked.filter((m) => m.similarity < 0.6).slice(0, 10)) {
        const flags: string[] = [];
        if (m.isStub) flags.push("[STUB]");
        if (m.todoCount > 0) flags.push(`[${m.todoCount} TODOs]`);
        if (m.sourceFunctionCount > 0 && m.functionCoverage < 1.0) {
          flags.push(`[FunctionParity ${m.matchedFunctionCount}/${m.sourceFunctionCount}]`);
        }
        console.log(
          `  ${m.sourceQualified.padEnd(30)} sim=${m.similarity.toFixed(2)} deps=${m.sourceDependents} ${flags.join(" ")}`,
        );
      }
    }

    if (comp.unmatchedSource.length > 0) {
      console.log("\nTop priority to create:");
      const missing = [...comp.unmatchedSource]
        .map((k) => ({ key: k, file: comp.sourceFiles.get(k) }))
        .filter((x): x is { key: string; file: any } => Boolean(x.file))
        .sort((a, b) => (comp.sourceDeps.nodes.get(b.key)?.dependents.length || 0) - (comp.sourceDeps.nodes.get(a.key)?.dependents.length || 0));
      for (const it of missing.slice(0, 10)) {
        const deps = comp.sourceDeps.nodes.get(it.key)?.dependents.length || 0;
        console.log(`  ${it.file.qualifiedName.padEnd(30)} deps=${deps}`);
      }
    }

    // Documentation gaps
    function docGapRatio(m: any): number {
      if (m.sourceDocLines === 0) return 0.0;
      if (m.targetDocLines === 0) return 1.0;
      const r = 1.0 - m.targetDocLines / m.sourceDocLines;
      return Math.max(0.0, r);
    }

    const docGaps = comp.matches
      .map((m) => ({ gap: docGapRatio(m), m }))
      .filter((x) => x.gap > 0.2 && x.m.sourceDocLines > 5)
      .sort((a, b) => b.gap * b.m.sourceDocLines - a.gap * a.m.sourceDocLines);

    const totalSrcDoc = comp.matches.reduce((a, m) => a + m.sourceDocLines, 0);
    const totalTgtDoc = comp.matches.reduce((a, m) => a + m.targetDocLines, 0);
    console.log(chalk.bold("\n=== Documentation Gaps ===\n"));
    const pct = totalSrcDoc > 0 ? (100.0 * totalTgtDoc) / totalSrcDoc : null;
    const docsMissing = pct !== null && pct < 85.0;
    if (docsMissing) {
      console.log("There is missing documentation that is hurting overall scoring.");
    }
    if (pct !== null) {
      console.log(
        `Documentation coverage: ${totalTgtDoc} / ${totalSrcDoc} lines (${pct.toFixed(0)}%)`,
      );
    } else {
      console.log("Documentation coverage: N/A (source has no docs)");
    }
    console.log(`Files with >20% doc gap: ${docGaps.length}\n`);

    if (docGaps.length > 0) {
      console.log(
        `${"File".padEnd(30)} ${"Src Docs".padStart(10)} ${"Tgt Docs".padStart(10)} ${"Gap %".padStart(8)} ${"DocSim".padStart(8)}`,
      );
      console.log("-".repeat(74));
      for (const it of docGaps.slice(0, 25)) {
        console.log(
          `${it.m.sourceQualified.slice(0, 28).padEnd(30)} ${String(it.m.sourceDocLines).padStart(10)} ${String(it.m.targetDocLines).padStart(10)} ${String(Math.trunc(it.gap * 100)).padStart(7)}% ${it.m.docSimilarity.toFixed(2).padStart(8)}`,
        );
      }
      if (docGaps.length > 25) {
        console.log(`... and ${docGaps.length - 25} more files with doc gaps`);
      }
    } else {
      console.log("No significant documentation gaps found.");
    }
  });

// Missing files
program
  .command("missing")
  .argument("<srcDir>")
  .argument("<srcLang>")
  .argument("<tgtDir>")
  .argument("<tgtLang>")
  .action((srcDir, srcLang, tgtDir, tgtLang) => {
    const srcFiles = parseDirectory(srcDir, parseLanguage(srcLang));
    const tgtFiles = parseDirectory(tgtDir, parseLanguage(tgtLang));

    const missing = findMissingFiles(srcFiles, tgtFiles);

    console.log(chalk.bold(`Missing Files: ${missing.length}\n`));

    for (const item of missing) {
      console.log(`  ${item.path}`);
    }
  });

function targetPathFromSource(relPath: string, srcLang: string, tgtLang: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const p = path.parse(normalized);
  const key = `${srcLang}->${tgtLang}`;

  const extMap: Record<string, string> = {
    "rust->typescript": ".ts",
    "rust->ts": ".ts",
    "typescript->rust": ".rs",
    "ts->rust": ".rs",
    "cpp->typescript": ".ts",
    "c->typescript": ".ts",
    "typescript->cpp": ".cpp",
    "typescript->c": ".c",
  };

  const newExt = extMap[key] || p.ext;
  let base = p.name;
  if (tgtLang === "typescript" || tgtLang === "ts" || tgtLang === "tsx") {
    // TS codebases commonly use kebab-case filenames.
    base = base.replace(/_/g, "-");
  } else if (tgtLang === "rust" || tgtLang === "cpp" || tgtLang === "c" || tgtLang === "python") {
    // Rust/C/C++/Python ports typically prefer snake_case.
    base = base.replace(/-/g, "_");
  }

  let out = path.join(p.dir, `${base}${newExt}`).replace(/\\/g, "/");
  if (out.startsWith("src/")) out = out.slice(4);
  return out;
}

function guardrailsAgentsDir(taskFile: string): string {
  const base = path.dirname(taskFile) || process.cwd();
  return path.join(base, ".cache", "ast_distance", "agents");
}

function fileHasTodoMarkers(filePath: string): boolean {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return /\bTODO\b/i.test(text) || /\bFIXME\b/i.test(text);
  } catch {
    return false;
  }
}

function canonicalizeName(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

function functionNameCoverage(
  src: any,
  tgt: any,
): { sourceTotal: number; targetTotal: number; matched: number; ratio: number } {
  const srcNames = (src.functionNames || [])
    .filter((n: string) => n && n !== "<anonymous>")
    .map(canonicalizeName);
  const tgtNames = (tgt.functionNames || [])
    .filter((n: string) => n && n !== "<anonymous>")
    .map(canonicalizeName);

  const sourceTotal = srcNames.length;
  const targetTotal = tgtNames.length;
  if (sourceTotal === 0) return { sourceTotal, targetTotal, matched: 0, ratio: 1.0 };

  const tgtCounts = new Map<string, number>();
  for (const n of tgtNames) tgtCounts.set(n, (tgtCounts.get(n) || 0) + 1);

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

// Swarm task management (TypeScript port)
program
  .command("init-tasks")
  .argument("<srcDir>")
  .argument("<srcLang>")
  .argument("<tgtDir>")
  .argument("<tgtLang>")
  .argument("<taskFile>")
  .argument("[agentsMd]")
  .action((srcDir, srcLang, tgtDir, tgtLang, taskFile, agentsMd) => {
    console.log("=== Initializing Task File ===\n");

    const existing = new TaskManager(taskFile);
    const assignedMap = new Map<string, { assigned_to: string; assigned_at: string }>();
    const completedMap = new Map<string, string>();
    if (existing.load()) {
      for (const t of existing.tasks) {
        if (t.status === TaskStatus.ASSIGNED && t.assigned_to) {
          assignedMap.set(t.source_qualified, {
            assigned_to: String(t.assigned_to),
            assigned_at: String(t.assigned_at || ""),
          });
        } else if (t.status === TaskStatus.COMPLETED) {
          completedMap.set(t.source_qualified, String(t.completed_at || ""));
        }
      }
    }

    const sl = parseLanguage(srcLang);
    const tl = parseLanguage(tgtLang);

    const comp = new CodebaseComparator(srcDir, sl, tgtDir, tl);
    comp.findMatches();
    console.log("Computing AST similarities...");
    comp.computeSimilarities();

    const tm = new TaskManager(taskFile);
    tm.source_root = srcDir;
    tm.target_root = tgtDir;
    tm.source_lang = srcLang;
    tm.target_lang = tgtLang;
    tm.agents_md = agentsMd || "";

    const pendingKeys = new Set<string>(comp.unmatchedSource);
    for (const m of comp.matches) {
      if (m.similarity < 0.85 || m.todoCount > 0 || m.lintCount > 0 || m.isStub) {
        pendingKeys.add(m.sourcePath);
      }
    }

    const pending = [...pendingKeys]
      .map((k) => ({ key: k, file: comp.sourceFiles.get(k) }))
      .filter((x): x is { key: string; file: any } => Boolean(x.file))
      .sort(
        (a, b) =>
          (comp.sourceDeps.nodes.get(b.key)?.dependents.length || 0) -
          (comp.sourceDeps.nodes.get(a.key)?.dependents.length || 0),
      );

    tm.tasks = [];
    for (const it of pending) {
      const qualified = it.file.qualifiedName;
      if (completedMap.has(qualified)) continue;
      const deps = comp.sourceDeps.nodes.get(it.key)?.dependents.length || 0;
      const task: any = {
        source_path: it.file.relativePath,
        source_qualified: qualified,
        target_path: targetPathFromSource(it.file.relativePath, srcLang, tgtLang),
        dependent_count: deps,
        dependency_count: it.file.imports.length || 0,
        status: TaskStatus.PENDING,
        dependencies: it.file.imports,
      };
      const assigned = assignedMap.get(qualified);
      if (assigned) {
        task.status = TaskStatus.ASSIGNED;
        task.assigned_to = assigned.assigned_to;
        task.assigned_at = assigned.assigned_at;
      }
      tm.tasks.push(task);
    }

    for (const [qualified, completedAt] of completedMap.entries()) {
      const t: any = {
        source_path: qualified,
        source_qualified: qualified,
        target_path: "",
        dependent_count: 0,
        dependency_count: 0,
        status: TaskStatus.COMPLETED,
        completed_at: completedAt,
      };
      for (const [key, f] of comp.sourceFiles.entries()) {
        if (f.qualifiedName === qualified) {
          t.source_path = f.relativePath;
          t.dependent_count = comp.sourceDeps.nodes.get(key)?.dependents.length || 0;
          t.dependency_count = f.imports.length || 0;
          break;
        }
      }
      tm.tasks.push(t);
    }

    if (!tm.save()) {
      console.error(`Failed to write task file: ${taskFile}`);
      process.exit(1);
    }

    console.log(`Generated ${tm.tasks.length} tasks`);
    console.log(`Task file: ${taskFile}\n`);
    console.log("Top 10 priority tasks:");
    for (const t of tm.tasks.filter((t) => t.status === TaskStatus.PENDING).slice(0, 10)) {
      console.log(`  ${t.source_qualified.padEnd(30)} deps=${t.dependent_count}`);
    }
  });

program
  .command("tasks")
  .argument("<taskFile>")
  .action((taskFile) => {
    const tm = new TaskManager(taskFile);
    if (!tm.load()) {
      console.error(`Error: Could not load task file: ${taskFile}`);
      process.exit(1);
    }
    const stats = tm.get_stats();

    printAgentActivitySection(tm, taskFile, GUARD.agent);

    console.log("\n=== Task Status ===\n");
    console.log(`Task file: ${taskFile}`);
    console.log(`Source root: ${tm.source_root}`);
    console.log(`Target root: ${tm.target_root}\n`);

    console.log("Status Summary:");
    console.log(`  Pending:   ${stats.pending}`);
    console.log(`  Assigned:  ${stats.assigned}`);
    console.log(`  Completed: ${stats.completed}`);
    console.log(`  Blocked:   ${stats.blocked}`);
    console.log(`  Total:     ${tm.tasks.length}\n`);

    const assigned = tm.tasks.filter((t) => t.status === TaskStatus.ASSIGNED);
    if (assigned.length > 0) {
      console.log("Currently Assigned:");
      for (const t of assigned) {
        console.log(
          `  ${t.source_qualified.padEnd(30)} -> ${String(t.assigned_to || "")} (since ${String(t.assigned_at || "")})`,
        );
      }
      console.log("");
    }

    console.log("Pending Tasks (by priority):");
    console.log(`${"Source".padEnd(35)} ${"Deps".padEnd(10)} Target Path`);
    console.log("-".repeat(70));
    const pending = tm.tasks.filter((t) => t.status === TaskStatus.PENDING);
    for (const t of pending.slice(0, 20)) {
      console.log(
        `${t.source_qualified.slice(0, 33).padEnd(35)} ${String(t.dependent_count).padEnd(10)} ${t.target_path}`,
      );
    }
    if (pending.length > 20) {
      console.log(`... and ${pending.length - 20} more`);
    }
  });

program
  .command("assign")
  .argument("<taskFile>")
  .argument("[agentNumber]")
  .action((taskFile, agentNumber) => {
    const tm = new TaskManager(taskFile);
    if (!tm.load()) {
      console.error(`Error: Could not load task file: ${taskFile}`);
      process.exit(1);
    }

    let agent = Number(agentNumber || 0);
    if (!Number.isFinite(agent) || agent <= 0) {
      let maxAgent = 0;
      for (const t of tm.tasks) {
        if (t.status !== TaskStatus.ASSIGNED) continue;
        const v = Number(t.assigned_to || 0);
        if (Number.isFinite(v)) maxAgent = Math.max(maxAgent, v);
      }

      const dirp = guardrailsAgentsDir(taskFile);
      try {
        for (const name of fs.readdirSync(dirp)) {
          if (!name.startsWith("agent_")) continue;
          const numStr = name.slice("agent_".length).split(".", 1)[0] || "";
          const v = Number(numStr);
          if (Number.isFinite(v)) maxAgent = Math.max(maxAgent, v);
        }
      } catch {
        // ignore
      }
      agent = maxAgent + 1;
    }

    if (agent <= 0) {
      console.error("Error: Could not allocate agent number");
      process.exit(1);
    }

    const lock = new AgentLock(taskFile, agent, GUARD.overrideMode);
    if (!lock.locked()) {
      const holder = lock.holderPid();
      let msg = `Agent #${agent} appears to be in use`;
      if (holder > 0) msg += ` by pid ${holder}`;
      msg += ".\nRe-run with --override to wait, or pick a different agent number.\n";
      console.error(`Error: ${msg}`);
      writeAgentNotice(taskFile, agent, `Conflict: another PID attempted to use this agent number.\n${msg}`);
      process.exit(3);
    }

    printAndClearAgentNotice(taskFile, agent);
    touchAgentLastUsed(taskFile, agent);

    const agentId = String(agent);
    const existing = tm.tasks.find(
      (t) => t.status === TaskStatus.ASSIGNED && String(t.assigned_to || "") === agentId,
    );
    if (existing) {
      console.error(`Agent #${agent} already has an assigned task: ${existing.source_qualified}`);
      console.error(
        `Complete it with: ast_distance --agent ${agent} --complete ${taskFile} ${existing.source_qualified}`,
      );
      console.error(
        `Or release it with: ast_distance --agent ${agent} --release ${taskFile} ${existing.source_qualified}`,
      );
      lock.release();
      return;
    }

    const task = tm.assign_next(agentId);
    if (!task) {
      console.log("No pending tasks available.");
      lock.release();
      return;
    }

    console.log(tm.format_assignment(task, agent));
    lock.release();
  });

program
  .command("complete")
  .argument("<taskFile>")
  .argument("<sourceQualified>")
  .action((taskFile, sourceQualified) => {
    const tm = new TaskManager(taskFile);
    if (!tm.load()) {
      console.error(`Error: Could not load task file: ${taskFile}`);
      process.exit(1);
    }

    const task = tm.tasks.find((t) => t.source_qualified === sourceQualified);
    if (!task) {
      console.error(`Task not found: ${sourceQualified}`);
      process.exit(1);
    }

    if (
      GUARD.agent > 0 &&
      task.status === TaskStatus.ASSIGNED &&
      String(task.assigned_to || "") !== String(GUARD.agent) &&
      !GUARD.overrideMode
    ) {
      console.error(
        `Error: Agent #${GUARD.agent} cannot complete a task assigned to agent ${String(task.assigned_to || "")}\n` +
          "Use --override only if you are explicitly taking over the task.",
      );
      process.exit(2);
    }

    const sourcePath = path.join(tm.source_root, task.source_path);
    const targetPath = path.join(tm.target_root, task.target_path);

    if (!fs.existsSync(targetPath) && !GUARD.overrideMode) {
      console.error(
        `Error: Cannot complete task - target file does not exist: ${targetPath}\n` +
          "Create the file and add a port-lint header first.",
      );
      process.exit(2);
    }

    if (fs.existsSync(targetPath)) {
      if (fileHasTodoMarkers(targetPath) && !GUARD.overrideMode) {
        console.error(
          "Error: Cannot complete task - target file contains TODO/FIXME markers\n" +
            "TODOs are an automatic failure mode for porting completeness.",
        );
        process.exit(2);
      }

      const sl = parseLanguage(tm.source_lang);
      const tl = parseLanguage(tm.target_lang);
      const sp = parseFile(sourcePath, sl);
      const tp = parseFile(targetPath, tl);
      if (!sp || !tp) {
        console.error(
          "Error: Cannot parse files for comparison\n" +
            "This usually means the target file has syntax errors.",
        );
        process.exit(2);
      }

      if (tp.hasStubBodies && !GUARD.overrideMode) {
        console.error(
          "Error: Cannot complete task - target file contains stub/TODO markers in function bodies\n" +
            "The code is fake. Complete the real implementation first.",
        );
        process.exit(2);
      }

      const fileSim = combinedSimilarityWithContent(sp, tp);
      const cov = functionNameCoverage(sp, tp);
      const similarity = fileSim * cov.ratio;

      if (similarity < 0.85 && !GUARD.overrideMode) {
        console.error(
          `Error: Cannot complete task with low similarity: ${similarity.toFixed(4)}\n` +
            "Port is incomplete. Increase similarity and function parity first.",
        );
        process.exit(2);
      }
    }

    if (!tm.complete_task(sourceQualified)) {
      console.error(`Task not found: ${sourceQualified}`);
      process.exit(1);
    }

    console.log(`Marked as completed: ${sourceQualified}`);

    if (!tm.source_root || !tm.source_lang) {
      console.log("Warning: Task file missing source/target info, cannot rescan.");
      return;
    }

    console.log("Rescanning codebases to update priorities...");
    const sl = parseLanguage(tm.source_lang);
    const tl = parseLanguage(tm.target_lang);
    const comp = new CodebaseComparator(tm.source_root, sl, tm.target_root, tl);
    comp.findMatches();
    comp.computeSimilarities();

    const assignedMap = new Map<string, { assigned_to: string; assigned_at: string }>();
    const completedMap = new Map<string, string>();
    tm.load();
    for (const t of tm.tasks) {
      if (t.status === TaskStatus.ASSIGNED && t.assigned_to) {
        assignedMap.set(t.source_qualified, {
          assigned_to: String(t.assigned_to),
          assigned_at: String(t.assigned_at || ""),
        });
      } else if (t.status === TaskStatus.COMPLETED) {
        completedMap.set(t.source_qualified, String(t.completed_at || ""));
      }
    }

    const pendingKeys = new Set<string>(comp.unmatchedSource);
    for (const m of comp.matches) {
      if (m.similarity < 0.85 || m.todoCount > 0 || m.lintCount > 0 || m.isStub) {
        pendingKeys.add(m.sourcePath);
      }
    }

    const pending = [...pendingKeys]
      .map((k) => ({ key: k, file: comp.sourceFiles.get(k) }))
      .filter((x): x is { key: string; file: any } => Boolean(x.file))
      .sort(
        (a, b) =>
          (comp.sourceDeps.nodes.get(b.key)?.dependents.length || 0) -
          (comp.sourceDeps.nodes.get(a.key)?.dependents.length || 0),
      );

    tm.tasks = [];
    for (const it of pending) {
      const qualified = it.file.qualifiedName;
      if (completedMap.has(qualified)) continue;
      const deps = comp.sourceDeps.nodes.get(it.key)?.dependents.length || 0;
      const taskOut: any = {
        source_path: it.file.relativePath,
        source_qualified: qualified,
        target_path: targetPathFromSource(it.file.relativePath, tm.source_lang, tm.target_lang),
        dependent_count: deps,
        dependency_count: it.file.imports.length || 0,
        status: TaskStatus.PENDING,
        dependencies: it.file.imports,
      };
      const assigned = assignedMap.get(qualified);
      if (assigned) {
        taskOut.status = TaskStatus.ASSIGNED;
        taskOut.assigned_to = assigned.assigned_to;
        taskOut.assigned_at = assigned.assigned_at;
      }
      tm.tasks.push(taskOut);
    }

    for (const [qualified, completedAt] of completedMap.entries()) {
      const t: any = {
        source_path: qualified,
        source_qualified: qualified,
        target_path: "",
        dependent_count: 0,
        dependency_count: 0,
        status: TaskStatus.COMPLETED,
        completed_at: completedAt,
      };
      for (const [key, f] of comp.sourceFiles.entries()) {
        if (f.qualifiedName === qualified) {
          t.source_path = f.relativePath;
          t.dependent_count = comp.sourceDeps.nodes.get(key)?.dependents.length || 0;
          t.dependency_count = f.imports.length || 0;
          break;
        }
      }
      tm.tasks.push(t);
    }

    tm.save();
    const stats = tm.get_stats();
    const total = stats.pending + stats.assigned + stats.completed;
    console.log(`Progress: ${stats.completed}/${total} completed`);
    console.log(`Remaining: ${stats.pending} pending, ${stats.assigned} assigned\n`);

    console.log("Updated top priorities:");
    const pendingOut = tm.tasks.filter((t) => t.status === TaskStatus.PENDING);
    for (const t of pendingOut.slice(0, 5)) {
      console.log(`  ${t.source_qualified.padEnd(30)} deps=${t.dependent_count}`);
    }
  });

program
  .command("release")
  .argument("<taskFile>")
  .argument("<sourceQualified>")
  .action((taskFile, sourceQualified) => {
    const tm = new TaskManager(taskFile);
    if (!tm.load()) {
      console.error(`Error: Could not load task file: ${taskFile}`);
      process.exit(1);
    }

    const task = tm.tasks.find((t) => t.source_qualified === sourceQualified);
    if (!task || task.status !== TaskStatus.ASSIGNED) {
      console.error(`Task not found or not assigned: ${sourceQualified}`);
      process.exit(1);
    }

    if (GUARD.agent > 0 && String(task.assigned_to || "") !== String(GUARD.agent) && !GUARD.overrideMode) {
      console.error(
        `Error: Agent #${GUARD.agent} cannot release a task assigned to agent ${String(task.assigned_to || "")}\n` +
          "Use --override only if you are explicitly taking over the task.",
      );
      process.exit(2);
    }

    const targetPath = path.join(tm.target_root, task.target_path);
    if (fs.existsSync(targetPath)) {
      const sourcePath = path.join(tm.source_root, task.source_path);

      if (!GUARD.overrideMode) {
        if (fileHasTodoMarkers(targetPath)) {
          console.error(
            "Error: Cannot release task - target file contains TODO/FIXME markers\n" +
              "Complete the real implementation or delete the file to release.",
          );
          process.exit(2);
        }
      }

      const sl = parseLanguage(tm.source_lang);
      const tl = parseLanguage(tm.target_lang);
      const sp = parseFile(sourcePath, sl);
      const tp = parseFile(targetPath, tl);
      if (!sp || !tp) {
        console.error(
          "Error: Cannot parse files for comparison\n" +
            "This usually means the target file has syntax errors.\n" +
            "Fix the errors or delete the file to release.",
        );
        process.exit(2);
      }

      if (tp.hasStubBodies && !GUARD.overrideMode) {
        console.error(
          "Error: Cannot release task - target file contains stub/TODO markers in function bodies\n" +
            "The code is fake. Complete the real implementation or delete the file.",
        );
        process.exit(2);
      }

      const fileSim = combinedSimilarityWithContent(sp, tp);
      const cov = functionNameCoverage(sp, tp);
      const similarity = fileSim * cov.ratio;

      if (similarity < 0.5 && !GUARD.overrideMode) {
        console.error(
          `Error: Cannot release task with low similarity: ${similarity.toFixed(4)}\n` +
            "Target file exists but identifier content doesn't match source.\n" +
            "Either complete the port or delete the target file to release.",
        );
        process.exit(2);
      }

      console.error(`Warning: Releasing with partial port (similarity ${similarity.toFixed(4)})`);
      console.error("Consider completing it instead (use --complete).");
    }

    if (!tm.release_task(sourceQualified)) {
      console.error(`Task not found or not assigned: ${sourceQualified}`);
      process.exit(1);
    }
    console.log(`Released task: ${sourceQualified}`);
  });

// Scan for TODOs
program
  .command("todos")
  .argument("<directory>")
  .action((directory) => {
    const files = parseDirectory(directory, Language.TYPESCRIPT);
    let totalTodos = 0;

    console.log(chalk.bold("=== TODO Scan ===\n"));

    for (const file of files.values()) {
      for (const filePath of file.paths) {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        lines.forEach((line, idx) => {
          const matches = line.match(/TODO[:\s](.*)/i);
          if (matches) {
            totalTodos++;
            console.log(`${chalk.cyan(file.filename)}:${idx + 1}`);
            console.log(`  ${matches[1].trim()}\n`);
          }
        });
      }
    }

    console.log(`Total TODOs: ${totalTodos}`);
  });

function parseGuardrailFlags(argv: string[]): {
  agent: number;
  taskFileFlag: string;
  overrideMode: boolean;
  rest: string[];
} {
  let agent = 0;
  let taskFileFlag = "";
  let overrideMode = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--agent" && i + 1 < argv.length) {
      agent = Number(argv[++i]) || 0;
      continue;
    }
    if (a.startsWith("--agent=")) {
      agent = Number(a.slice("--agent=".length)) || 0;
      continue;
    }
    if (a === "--task-file" && i + 1 < argv.length) {
      taskFileFlag = argv[++i] || "";
      continue;
    }
    if (a.startsWith("--task-file=")) {
      taskFileFlag = a.slice("--task-file=".length);
      continue;
    }
    if (a === "--override") {
      overrideMode = true;
      continue;
    }
    rest.push(a);
  }

  return { agent, taskFileFlag, overrideMode, rest };
}

function mapLegacyFlagCommand(args: string[]): string[] {
  if (args.length === 0) return args;
  const first = args[0] || "";
  const map: Record<string, string> = {
    "--deep": "deep",
    "--dump": "dump",
    "--scan": "scan",
    "--missing": "missing",
    "--todos": "todos",
    "--init-tasks": "init-tasks",
    "--tasks": "tasks",
    "--assign": "assign",
    "--complete": "complete",
    "--release": "release",
  };
  const mapped = map[first];
  if (!mapped) return args;
  return [mapped, ...args.slice(1)];
}

function resolveTaskFile(mode: string, rest: string[], taskFileFlag: string): string {
  if (taskFileFlag) return taskFileFlag;

  if ((mode === "tasks" || mode === "assign" || mode === "complete" || mode === "release") && rest.length >= 2) {
    return rest[1] || "";
  }
  if (mode === "init-tasks" && rest.length >= 6) {
    return rest[5] || "";
  }

  if (fs.existsSync("tasks.json")) return "tasks.json";
  return "";
}

function installAgentLockCleanup(): void {
  function release(): void {
    if (!gAgentLock) return;
    try {
      gAgentLock.release();
    } catch {
      // ignore
    }
    gAgentLock = null;
  }

  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(143);
  });
}

const parsed = parseGuardrailFlags(process.argv.slice(2));
const rest = mapLegacyFlagCommand(parsed.rest);
const mode = rest[0] || "";
const taskFile = resolveTaskFile(mode, rest, parsed.taskFileFlag);

GUARD.agent = parsed.agent;
GUARD.taskFile = taskFile;
GUARD.overrideMode = parsed.overrideMode;

if (taskFile) {
  const tmCheck = new TaskManager(taskFile);
  GUARD.active = tmCheck.load();
} else {
  GUARD.active = false;
}

// Guardrails: if a task system exists, require --agent and lock the session number.
if (GUARD.active && mode !== "assign" && GUARD.agent <= 0) {
  console.error(`Error: task system detected (${GUARD.taskFile}).`);
  console.error("All commands require an agent session number.");
  console.error(`Get one with: ast_distance --assign ${GUARD.taskFile}`);
  console.error("Then re-run with: ast_distance --agent <number> ...");
  process.exit(2);
}

if (GUARD.active && mode !== "assign" && GUARD.agent > 0) {
  gAgentLock = new AgentLock(GUARD.taskFile, GUARD.agent, GUARD.overrideMode);
  if (!gAgentLock.locked()) {
    const holder = gAgentLock.holderPid();
    let msg = `Agent #${GUARD.agent} appears to be in use`;
    if (holder > 0) msg += ` by pid ${holder}`;
    msg += ".\nRe-run with --override to wait, or pick a different agent number.\n";
    console.error(`Error: ${msg}`);
    writeAgentNotice(GUARD.taskFile, GUARD.agent, `Conflict: another PID attempted to use this agent number.\n${msg}`);
    process.exit(3);
  }
  printAndClearAgentNotice(GUARD.taskFile, GUARD.agent);
  touchAgentLastUsed(GUARD.taskFile, GUARD.agent);
  installAgentLockCleanup();
}

program.parse([process.argv[0] || "node", process.argv[1] || "cli.js", ...rest]);
