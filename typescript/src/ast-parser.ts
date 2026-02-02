import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import * as fs from "fs";
import * as path from "path";
import {
  Language,
  NodeType,
  TreeNode,
  ParseResult,
  CommentStats,
  PortLintHeader,
} from "./types.js";

/**
 * Get tree-sitter parser for language
 */
function getTreeSitterLanguage(lang: Language): Parser.Language {
  switch (lang) {
    case Language.TYPESCRIPT:
      return TypeScript;
    case Language.RUST:
      // Will need tree-sitter-rust when added
      throw new Error("Rust parser not yet implemented");
    default:
      throw new Error(`Unsupported language: ${lang}`);
  }
}

/**
 * Normalize tree-sitter node type to our NodeType enum
 */
function normalizeNodeType(type: string): NodeType {
  const mapping: Record<string, NodeType> = {
    // TypeScript types
    source_file: NodeType.SOURCE_FILE,
    program: NodeType.SOURCE_FILE,
    function_declaration: NodeType.FUNCTION_DECLARATION,
    function_definition: NodeType.FUNCTION_DEFINITION,
    class_declaration: NodeType.CLASS_DECLARATION,
    interface_declaration: NodeType.INTERFACE_DECLARATION,
    type_alias_declaration: NodeType.TYPE_DECLARATION,
    enum_declaration: NodeType.ENUM_DECLARATION,
    variable_declaration: NodeType.VARIABLE_DECLARATION,
    block: NodeType.BLOCK,
    if_statement: NodeType.IF_STATEMENT,
    for_statement: NodeType.FOR_STATEMENT,
    while_statement: NodeType.WHILE_STATEMENT,
    return_statement: NodeType.RETURN_STATEMENT,
    expression_statement: NodeType.EXPRESSION_STATEMENT,
    assignment_expression: NodeType.ASSIGNMENT,
    call_expression: NodeType.CALL_EXPRESSION,
    member_expression: NodeType.MEMBER_EXPRESSION,
    binary_expression: NodeType.BINARY_EXPRESSION,
    unary_expression: NodeType.UNARY_EXPRESSION,
    string: NodeType.LITERAL,
    number: NodeType.LITERAL,
    true: NodeType.LITERAL,
    false: NodeType.LITERAL,
    identifier: NodeType.IDENTIFIER,
    formal_parameters: NodeType.PARAMETER_LIST,
    parameter: NodeType.PARAMETER,
    type_annotation: NodeType.TYPE_ANNOTATION,
    type_identifier: NodeType.TYPE_IDENTIFIER,
    import_statement: NodeType.IMPORT_STATEMENT,
    export_statement: NodeType.EXPORT_STATEMENT,
    comment: NodeType.COMMENT,
    property_identifier: NodeType.PROPERTY,

    // Rust specific types (for future)
    rust_function_item: NodeType.FUNCTION_DECLARATION,
    rust_impl_item: NodeType.CLASS_DECLARATION,
    rust_struct_item: NodeType.CLASS_DECLARATION,
    rust_trait_item: NodeType.INTERFACE_DECLARATION,
    rust_enum_item: NodeType.ENUM_DECLARATION,
    rust_let_declaration: NodeType.VARIABLE_DECLARATION,
  };

  return mapping[type] || NodeType.UNKNOWN;
}

/**
 * Convert tree-sitter tree to our TreeNode structure
 */
function convertTree(node: Parser.SyntaxNode): TreeNode {
  const nodeType = normalizeNodeType(node.type);
  const label = node.type;

  const children: TreeNode[] = [];
  for (const child of node.children) {
    children.push(convertTree(child));
  }

  const treeNode = new TreeNode(nodeType, label, children);
  treeNode.startPosition = {
    row: node.startPosition.row,
    column: node.startPosition.column,
  };
  treeNode.endPosition = {
    row: node.endPosition.row,
    column: node.endPosition.column,
  };

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

  const lines = source.split("\n");
  const commentNodeTypes = new Set([
    "comment",
    "line_comment",
    "block_comment",
  ]);

  function walk(node: Parser.SyntaxNode) {
    if (commentNodeTypes.has(node.type)) {
      const text = source.slice(node.startIndex, node.endIndex);
      const linesCount = node.endPosition.row - node.startPosition.row + 1;

      stats.totalCommentLines += linesCount;

      // Check for documentation comments
      if (
        text.startsWith("/**") ||
        text.startsWith("///") ||
        text.startsWith("*")
      ) {
        stats.docCommentCount++;
        stats.totalDocLines += linesCount;
        stats.docTexts.push(text);

        // Extract words for frequency analysis
        const words = text
          .replace(/[\/\*\s\@]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2);

        for (const word of words) {
          stats.wordFreq.set(word, (stats.wordFreq.get(word) || 0) + 1);
        }
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
    if (node.type === "import_statement") {
      const text = source.slice(node.startIndex, node.endIndex);
      // Extract from import ... from ...
      const match = text.match(/import\s+.*?from\s+['"]([^'"]+)['"]/);
      if (match) {
        imports.push(match[1]);
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
 *
 * Matches:
 *   // port-lint: source <path>
 *   // port-lint: tests <path>
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

/**
 * Parse a source file and generate AST
 */
export function parseFile(
  filePath: string,
  language: Language,
): ParseResult | null {
  try {
    const source = fs.readFileSync(filePath, "utf-8");

    const parser = new Parser();
    parser.setLanguage(getTreeSitterLanguage(language));

    const tree = parser.parse(source);
    const rootNode = convertTree(tree.rootNode);

    const commentStats = extractComments(source, tree);
    const nodeTypes = buildHistogram(rootNode);
    const { imports, exports } = extractImportsExports(source, tree);

    const header = extractPortLintHeader(source, filePath);

    return {
      tree: rootNode,
      filename: path.basename(filePath),
      language,
      commentStats,
      nodeTypes,
      importPaths: imports,
      exportPaths: exports,
      portLintHeader: header || undefined,
    };
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, (error as Error).message);
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
    const parser = new Parser();
    parser.setLanguage(getTreeSitterLanguage(language));

    const tree = parser.parse(source);
    const rootNode = convertTree(tree.rootNode);

    const commentStats = extractComments(source, tree);
    const nodeTypes = buildHistogram(rootNode);
    const { imports, exports } = extractImportsExports(source, tree);

    return {
      tree: rootNode,
      filename,
      language,
      commentStats,
      nodeTypes,
      importPaths: imports,
      exportPaths: exports,
    };
  } catch (error) {
    console.error(`Error parsing ${filename}:`, (error as Error).message);
    return null;
  }
}
