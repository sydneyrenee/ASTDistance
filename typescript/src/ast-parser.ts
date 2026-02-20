import Parser from "tree-sitter";
import TreeSitterTypeScript from "tree-sitter-typescript";
import Rust from "tree-sitter-rust";
import Cpp from "tree-sitter-cpp";
import * as fs from "fs";
import * as path from "path";
import {
  Language,
  NodeType,
  TreeNode,
  ParseResult,
  CommentStats,
  PortLintHeader,
  IdentifierStats,
} from "./types.js";
import { getNodeMap } from "./node-maps.js";

const STOP_WORDS = new Set(["the", "and", "for", "this", "that", "with"]);
const STUB_MARKERS = [
  "todo",
  "stub",
  "placeholder",
  "fixme",
  "not yet implemented",
  "not implemented",
  // Common stub constructs without spaces (Rust `unimplemented!`, Kotlin/Python `NotImplementedError`)
  "unimplemented",
  "notimplemented",
];
const ARITHMETIC_OPS = new Set(["+", "-", "*", "/", "%", "**"]);
const COMPARISON_OPS = new Set(["==", "!=", "<", ">", "<=", ">=", "===", "!=="]);
const LOGICAL_OPS = new Set(["&&", "||", "!"]);
const BITWISE_OPS = new Set(["&", "|", "^", "~", "<<", ">>"]);
const ASSIGNMENT_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
]);

function getTypeScriptLanguage(): any {
  const candidate = (TreeSitterTypeScript as any).typescript ??
    (TreeSitterTypeScript as any).default ??
    (TreeSitterTypeScript as any);
  return candidate;
}

/**
 * Get tree-sitter parser for language
 */
function getTreeSitterLanguage(lang: Language): any {
  switch (lang) {
    case Language.TYPESCRIPT:
      return getTypeScriptLanguage();
    case Language.RUST:
      return Rust as unknown as any;
    case Language.CPP:
    case Language.C:
      return Cpp as unknown as any;
    default:
      throw new Error(`Unsupported language: ${lang}`);
  }
}

/**
 * Normalize tree-sitter node type to our NodeType enum
 */
function normalizeNodeType(type: string, language: Language): NodeType {
  const mapping = getNodeMap(language);
  return mapping[type] || NodeType.UNKNOWN;
}

function classifyOperator(type: string): NodeType | null {
  if (ARITHMETIC_OPS.has(type)) return NodeType.ARITHMETIC_OP;
  if (COMPARISON_OPS.has(type)) return NodeType.COMPARISON_OP;
  if (LOGICAL_OPS.has(type)) return NodeType.LOGICAL_OP;
  if (BITWISE_OPS.has(type)) return NodeType.BITWISE_OP;
  if (ASSIGNMENT_OPS.has(type)) return NodeType.ASSIGNMENT_OP;
  return null;
}

/**
 * Convert tree-sitter tree to our TreeNode structure
 */
function convertTree(
  node: Parser.SyntaxNode,
  source: string,
  language: Language,
): TreeNode {
  const nodeType = normalizeNodeType(node.type, language);
  const treeNode = new TreeNode(nodeType, node.type);

  treeNode.startPosition = {
    row: node.startPosition.row,
    column: node.startPosition.column,
  };
  treeNode.endPosition = {
    row: node.endPosition.row,
    column: node.endPosition.column,
  };

  if (node.children.length === 0) {
    treeNode.label = source.slice(node.startIndex, node.endIndex);
    return treeNode;
  }

  for (const child of node.children) {
    if (child.isNamed) {
      treeNode.children.push(convertTree(child, source, language));
      continue;
    }

    const opType = classifyOperator(child.type);
    if (opType !== null) {
      treeNode.children.push(new TreeNode(opType, child.type));
    }
  }

  return treeNode;
}

/**
 * Extract comments from source code
 */
function extractComments(source: string, tree: Parser.Tree): CommentStats {
  const stats: CommentStats = {
    docCommentCount: 0,
    lineCommentCount: 0,
    blockCommentCount: 0,
    totalCommentLines: 0,
    totalDocLines: 0,
    docTexts: [],
    wordFreq: new Map(),
  };

  const commentNodeTypes = new Set([
    "comment",
    "line_comment",
    "block_comment",
    "multiline_comment",
  ]);

  function tokenizeDoc(text: string) {
    const words = text
      .replace(/[^a-zA-Z0-9_]/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

    for (const word of words) {
      stats.wordFreq.set(word, (stats.wordFreq.get(word) || 0) + 1);
    }
  }

  function walk(node: Parser.SyntaxNode) {
    if (commentNodeTypes.has(node.type)) {
      const text = source.slice(node.startIndex, node.endIndex);
      const linesCount = node.endPosition.row - node.startPosition.row + 1;
      stats.totalCommentLines += linesCount;

      const isDoc =
        text.startsWith("/**") ||
        text.startsWith("///") ||
        text.startsWith("//!");

      if (isDoc) {
        stats.docCommentCount++;
        stats.totalDocLines += linesCount;
        stats.docTexts.push(text);
        tokenizeDoc(text);
      } else if (text.startsWith("//")) {
        stats.lineCommentCount++;
      } else {
        stats.blockCommentCount++;
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return stats;
}

/**
 * Build node type histogram
 */
function buildHistogram(node: TreeNode): Map<NodeType, number> {
  const histogram = new Map<NodeType, number>();

  function walk(treeNode: TreeNode) {
    histogram.set(
      treeNode.nodeType,
      (histogram.get(treeNode.nodeType) || 0) + 1,
    );
    for (const child of treeNode.children) {
      walk(child);
    }
  }

  walk(node);
  return histogram;
}

function canonicalizeIdentifier(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

function extractIdentifierStats(source: string, tree: Parser.Tree): IdentifierStats {
  const stats: IdentifierStats = {
    identifierFreq: new Map(),
    canonicalFreq: new Map(),
    totalIdentifiers: 0,
  };

  const identifierNodeTypes = new Set([
    "identifier",
    "simple_identifier",
    "type_identifier",
    "field_identifier",
    "property_identifier",
  ]);

  function walk(node: Parser.SyntaxNode) {
    if (identifierNodeTypes.has(node.type)) {
      const text = source.slice(node.startIndex, node.endIndex);
      if (text.length > 1 && text !== "it" && text !== "this") {
        stats.identifierFreq.set(text, (stats.identifierFreq.get(text) || 0) + 1);
        const canonical = canonicalizeIdentifier(text);
        stats.canonicalFreq.set(canonical, (stats.canonicalFreq.get(canonical) || 0) + 1);
        stats.totalIdentifiers++;
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return stats;
}

function extractFunctionNames(source: string, tree: Parser.Tree, language: Language): string[] {
  const names: string[] = [];

  const functionTypesByLang: Record<string, Set<string>> = {
    [Language.TYPESCRIPT]: new Set([
      "function_declaration",
      "method_definition",
      // Note: arrow_function / function_expression are often anonymous; parity scoring
      // treats "<anonymous>" as ignorable noise, so we keep the set minimal.
    ]),
    [Language.RUST]: new Set(["function_item"]),
    [Language.CPP]: new Set(["function_definition", "function_declarator"]),
    [Language.C]: new Set(["function_definition", "function_declarator"]),
  };

  const funcTypes = functionTypesByLang[language] || new Set<string>();

  function nodeText(node: Parser.SyntaxNode): string {
    return source.slice(node.startIndex, node.endIndex);
  }

  function extractTsLikeName(node: Parser.SyntaxNode): string | null {
    const byField = node.childForFieldName("name");
    if (byField) {
      const text = nodeText(byField).trim();
      if (text) return text;
    }

    // Fallback: find first identifier-like named child.
    for (const child of node.namedChildren) {
      if (child.type === "identifier" || child.type === "property_identifier") {
        const text = nodeText(child).trim();
        if (text) return text;
      }
    }
    return null;
  }

  function extractRustName(node: Parser.SyntaxNode): string | null {
    const byField = node.childForFieldName("name");
    if (byField) {
      const text = nodeText(byField).trim();
      if (text) return text;
    }
    for (const child of node.namedChildren) {
      if (child.type === "identifier") {
        const text = nodeText(child).trim();
        if (text) return text;
      }
    }
    return null;
  }

  function extractCppDeclaratorName(node: Parser.SyntaxNode | null): string | null {
    if (!node) return null;

    const leafTypes = new Set([
      "identifier",
      "field_identifier",
      "operator_name",
      "destructor_name",
      "qualified_identifier",
      "namespace_identifier",
    ]);

    // Unwrap declarator wrappers that often contain another declarator field.
    const unwrapTypes = new Set([
      "pointer_declarator",
      "reference_declarator",
      "array_declarator",
      "parenthesized_declarator",
      "attributed_declarator",
    ]);

    let cur: Parser.SyntaxNode | null = node;
    for (let i = 0; i < 32 && cur && unwrapTypes.has(cur.type); i++) {
      const inner = cur.childForFieldName("declarator");
      if (inner) {
        cur = inner;
        continue;
      }
      cur = cur.namedChildren.length > 0 ? cur.namedChildren[0]! : null;
    }
    if (!cur) return null;

    if (cur.type === "qualified_identifier") {
      // Prefer the last identifier-like token inside the qualified name.
      let best: string | null = null;
      for (const ch of cur.namedChildren) {
        if (
          ch.type === "identifier" ||
          ch.type === "field_identifier" ||
          ch.type === "operator_name" ||
          ch.type === "destructor_name"
        ) {
          const t = nodeText(ch).trim();
          if (t) best = t;
        }
      }
      return best;
    }

    if (leafTypes.has(cur.type)) {
      const t = nodeText(cur).trim();
      return t || null;
    }

    // Generic fallback: recurse into named children looking for a leaf.
    for (const ch of cur.namedChildren) {
      const t = extractCppDeclaratorName(ch);
      if (t) return t;
    }
    return null;
  }

  function extractCppName(node: Parser.SyntaxNode): string | null {
    // Prefer extracting name from the function_declarator's base declarator field,
    // to avoid picking up parameter identifiers.
    const funcDecl =
      node.type === "function_declarator"
        ? node
        : (node.descendantsOfType?.("function_declarator")?.[0] as Parser.SyntaxNode | undefined);
    if (funcDecl) {
      const base = funcDecl.childForFieldName("declarator");
      const name = extractCppDeclaratorName(base);
      if (name) return name;
    }

    // Fallback: best-effort search for an identifier in the declarator subtree.
    const decl = node.childForFieldName("declarator");
    if (decl) {
      const name = extractCppDeclaratorName(decl);
      if (name) return name;
    }

    return null;
  }

  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (funcTypes.has(node.type)) {
      let name: string | null = null;
      if (language === Language.TYPESCRIPT) {
        name = extractTsLikeName(node);
      } else if (language === Language.RUST) {
        name = extractRustName(node);
      } else if (language === Language.CPP || language === Language.C) {
        name = extractCppName(node);
      }
      names.push(name && name.length > 0 ? name : "<anonymous>");
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }

  return names;
}

function textHasStubMarkers(text: string): boolean {
  const lower = text.toLowerCase();

  function isWordChar(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_";
  }

  function hasWord(word: string): boolean {
    let start = 0;
    while (true) {
      const idx = lower.indexOf(word, start);
      if (idx < 0) return false;
      const leftOk = idx === 0 || !isWordChar(lower[idx - 1]!);
      const end = idx + word.length;
      const rightOk = end >= lower.length || !isWordChar(lower[end]!);
      if (leftOk && rightOk) return true;
      start = idx + 1;
    }
  }

  // Use word-boundary style matching for short markers so we don't trip on
  // explanatory text like "TODOs/stubs are a failure mode" inside the tool itself.
  return (
    hasWord("todo") ||
    hasWord("stub") ||
    hasWord("placeholder") ||
    hasWord("fixme") ||
    lower.includes("not yet implemented") ||
    lower.includes("not implemented") ||
    hasWord("unimplemented") ||
    hasWord("notimplemented")
  );
}

function commentHasStubMarkers(text: string): boolean {
  // For comment nodes, be stricter: only treat as a stub marker when the
  // comment itself starts with TODO/FIXME/STUB/etc. This avoids false positives
  // from explanatory comments inside the tool.
  const lower = text.toLowerCase();

  let i = 0;
  if (lower.startsWith("//")) {
    i = 2;
    while (i < lower.length && lower[i] === "/") i++;
  } else if (lower.startsWith("#")) {
    i = 1;
    while (i < lower.length && lower[i] === "#") i++;
  } else if (lower.startsWith("/*")) {
    i = 2;
    if (i < lower.length && lower[i] === "*") i++; // /** ...
  }

  while (i < lower.length && /\s/.test(lower[i]!)) i++;
  while (i < lower.length && lower[i] === "*") {
    i++;
    while (i < lower.length && /\s/.test(lower[i]!)) i++;
  }

  function isWordChar(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_";
  }

  function startsWithWord(word: string): boolean {
    if (!lower.startsWith(word, i)) return false;
    const end = i + word.length;
    if (end >= lower.length) return true;
    return !isWordChar(lower[end]!);
  }

  if (
    startsWithWord("todo") ||
    startsWithWord("fixme") ||
    startsWithWord("stub") ||
    startsWithWord("placeholder") ||
    startsWithWord("unimplemented") ||
    startsWithWord("notimplemented")
  ) {
    return true;
  }

  if (lower.startsWith("not implemented", i) || lower.startsWith("not yet implemented", i)) {
    return true;
  }

  return false;
}

function detectStubBodies(source: string, tree: Parser.Tree, language: Language): boolean {
  const functionTypesByLang: Record<string, Set<string>> = {
    [Language.TYPESCRIPT]: new Set([
      "function_declaration",
      "function_expression",
      "arrow_function",
      "method_definition",
    ]),
    [Language.RUST]: new Set(["function_item"]),
    [Language.CPP]: new Set(["function_definition", "function_declarator"]),
    [Language.C]: new Set(["function_definition", "function_declarator"]),
  };

  const bodyTypes = new Set([
    "function_body",
    "body",
    "block",
    "compound_statement",
    "statement_block",
    "expression_body",
  ]);

  const markerTypes = new Set([
    "line_comment",
    "block_comment",
    "comment",
    "multiline_comment",
  ]);

  const functionTypes = functionTypesByLang[language] || new Set<string>();

  function subtreeHasMarker(root: Parser.SyntaxNode): boolean {
    const stack: Parser.SyntaxNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      // Strong stub constructs that don't rely on comments/strings.
      if (language === Language.RUST && node.type === "macro_invocation") {
        const text = source
          .slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 96))
          .toLowerCase();
        if (
          text.includes("todo!") ||
          text.includes("unimplemented!") ||
          text.includes("unreachable!") ||
          textHasStubMarkers(text)
        ) {
          return true;
        }
      }
      if (markerTypes.has(node.type)) {
        const text = source.slice(node.startIndex, node.endIndex);
        if (commentHasStubMarkers(text)) {
          return true;
        }
      }
      for (const child of node.children) {
        stack.push(child);
      }
    }
    return false;
  }

  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (functionTypes.has(node.type)) {
      const bodies = node.children.filter((ch) => bodyTypes.has(ch.type));
      const scanRoots = bodies.length > 0 ? bodies : [node];
      for (const body of scanRoots) {
        if (subtreeHasMarker(body)) {
          return true;
        }
      }
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  return false;
}

/**
 * Extract import and export paths
 */
function extractImportsExports(
  source: string,
  tree: Parser.Tree,
): {
  imports: string[];
  exports: string[];
} {
  const imports: string[] = [];
  const exports: string[] = [];

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "import_statement" || node.type === "use_declaration" || node.type === "preproc_include") {
      const text = source.slice(node.startIndex, node.endIndex);
      const fromMatch = text.match(/from\s+['"]([^'"]+)['"]/);
      if (fromMatch) {
        imports.push(fromMatch[1]);
      } else {
        imports.push(text.trim());
      }
    } else if (node.type === "export_statement") {
      const text = source.slice(node.startIndex, node.endIndex);
      exports.push(text);
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return { imports, exports };
}

/**
 * Extract port-lint header from file
 */
function extractPortLintHeader(
  source: string,
  filename: string,
): PortLintHeader | null {
  const lines = source.split("\n").slice(0, 50).join("\n");
  const match = lines.match(/\/\/\s*port-lint:\s*(?:source|tests)\s+([^\s\n]+)/);

  if (match) {
    return {
      sourcePath: match[1],
      matchedBy: "header",
      confidence: 1.0,
    };
  }

  return null;
}

function buildParseResult(
  source: string,
  language: Language,
  filename: string,
): ParseResult {
  const parser = new Parser();
  parser.setLanguage(getTreeSitterLanguage(language));

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch {
    // Older tree-sitter Node bindings can reject large strings; callback mode is robust.
    tree = parser.parse((index: number) => {
      if (index >= source.length) return null;
      return source.slice(index, index + 8192);
    });
  }
  const rootNode = convertTree(tree.rootNode, source, language);
  const commentStats = extractComments(source, tree);
  const identifierStats = extractIdentifierStats(source, tree);
  const functionNames = extractFunctionNames(source, tree, language);
  const hasStubBodies = detectStubBodies(source, tree, language);
  const nodeTypes = buildHistogram(rootNode);
  const { imports, exports } = extractImportsExports(source, tree);

  return {
    tree: rootNode,
    filename,
    language,
    commentStats,
    identifierStats,
    functionNames,
    hasStubBodies,
    nodeTypes,
    importPaths: imports,
    exportPaths: exports,
  };
}

/**
 * Parse a source file and generate AST
 */
export function parseFile(
  filePath: string | string[],
  language: Language,
): ParseResult | null {
  try {
    const filePaths = Array.isArray(filePath) ? filePath : [filePath];
    if (filePaths.length === 0) {
      return null;
    }
    const source = filePaths
      .map((p) => fs.readFileSync(p, "utf-8"))
      .join("\n\n");
    const displayName = path.basename(filePaths[0] || "<unknown>");
    const result = buildParseResult(source, language, displayName);

    const headerSource = fs.readFileSync(filePaths[0], "utf-8");
    const header = extractPortLintHeader(headerSource, filePaths[0]);
    result.portLintHeader = header || undefined;
    return result;
  } catch (error) {
    const desc = Array.isArray(filePath) ? filePath.join(", ") : filePath;
    console.error(`Error parsing ${desc}:`, (error as Error).message);
    return null;
  }
}

/**
 * Parse source string directly
 */
export function parseString(
  source: string,
  language: Language,
  filename: string = "<stdin>",
): ParseResult | null {
  try {
    return buildParseResult(source, language, filename);
  } catch (error) {
    console.error(`Error parsing ${filename}:`, (error as Error).message);
    return null;
  }
}
