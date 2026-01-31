import {
  TreeNode,
  NodeType,
  ParseResult,
  SimilarityMetrics,
  DocumentationComparison,
} from "./types.js";

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(
  vec1: Map<NodeType, number>,
  vec2: Map<NodeType, number>,
): number {
  let dot = 0;
  let norm1 = 0;
  let norm2 = 0;

  const allKeys = new Set([...vec1.keys(), ...vec2.keys()]);

  for (const key of allKeys) {
    const v1 = vec1.get(key) || 0;
    const v2 = vec2.get(key) || 0;

    dot += v1 * v2;
    norm1 += v1 * v1;
    norm2 += v2 * v2;
  }

  if (norm1 === 0 || norm2 === 0) return 0;
  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

/**
 * Compute Jaccard similarity between two sets
 */
function jaccardSimilarity(set1: Set<NodeType>, set2: Set<NodeType>): number {
  const intersection = new Set<NodeType>();
  const union = new Set<NodeType>();

  for (const item of set1) {
    if (set2.has(item)) {
      intersection.add(item);
    }
    union.add(item);
  }

  for (const item of set2) {
    union.add(item);
  }

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Extract node types as a set
 */
function extractNodeTypes(tree: TreeNode): Set<NodeType> {
  const types = new Set<NodeType>();

  function walk(node: TreeNode) {
    types.add(node.nodeType);
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree);
  return types;
}

/**
 * Compare structure similarity (size and depth)
 */
function structureSimilarity(tree1: TreeNode, tree2: TreeNode): number {
  const size1 = tree1.size();
  const size2 = tree2.size();

  const depth1 = tree1.depth();
  const depth2 = tree2.depth();

  const sizeSim = 1 - Math.abs(size1 - size2) / Math.max(size1, size2);
  const depthSim = 1 - Math.abs(depth1 - depth2) / Math.max(depth1, depth2);

  return (sizeSim + depthSim) / 2;
}

/**
 * Compute similarity metrics between two ASTs
 */
export function computeSimilarity(
  result1: ParseResult,
  result2: ParseResult,
): SimilarityMetrics {
  // Clone trees to avoid modifying originals
  const tree1 = cloneTree(result1.tree);
  const tree2 = cloneTree(result2.tree);

  // Normalize ASTs: Flatten PACKAGE nodes to reduce structural noise
  tree1.flattenNodeType(NodeType.PACKAGE);
  tree2.flattenNodeType(NodeType.PACKAGE);

  const histogram1 = result1.nodeTypes;
  const histogram2 = result2.nodeTypes;

  const cosineHistogram = cosineSimilarity(histogram1, histogram2);

  const structure = structureSimilarity(tree1, tree2);

  const nodeTypes1 = extractNodeTypes(tree1);
  const nodeTypes2 = extractNodeTypes(tree2);
  const jaccard = jaccardSimilarity(nodeTypes1, nodeTypes2);

  // Combined score weighted: histogram (40%), structure (30%), jaccard (30%)
  const combined = cosineHistogram * 0.4 + structure * 0.3 + jaccard * 0.3;

  return {
    cosineHistogram,
    structure,
    jaccard,
    combined,
  };
}

/**
 * Deep clone a tree node
 */
function cloneTree(node: TreeNode): TreeNode {
  const clone = new TreeNode(node.nodeType, node.label);
  clone.startPosition = { ...node.startPosition };
  clone.endPosition = { ...node.endPosition };
  clone.children = node.children.map(child => cloneTree(child));
  return clone;
}

/**
 * Compute cosine similarity of doc word frequencies
 */
export function docCosineSimilarity(
  freq1: Map<string, number>,
  freq2: Map<string, number>,
): number {
  if (freq1.size === 0 || freq2.size === 0) return 0;

  let dot = 0;
  let norm1 = 0;
  let norm2 = 0;

  const allWords = new Set([...freq1.keys(), ...freq2.keys()]);

  for (const word of allWords) {
    const f1 = freq1.get(word) || 0;
    const f2 = freq2.get(word) || 0;

    dot += f1 * f2;
    norm1 += f1 * f1;
    norm2 += f2 * f2;
  }

  if (norm1 === 0 || norm2 === 0) return 0;
  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

/**
 * Compare documentation between two parse results
 */
export function compareDocumentation(
  result1: ParseResult,
  result2: ParseResult,
): DocumentationComparison {
  const docCommentDifference =
    result2.commentStats.docCommentCount - result1.commentStats.docCommentCount;

  const docLineDifference =
    result2.commentStats.totalDocLines - result1.commentStats.totalDocLines;

  const docTextCosine = docCosineSimilarity(
    result1.commentStats.wordFreq,
    result2.commentStats.wordFreq,
  );

  return {
    docCommentDifference,
    docLineDifference,
    docTextCosine,
  };
}

/**
 * Format similarity as percentage string
 */
export function formatSimilarity(value: number): string {
  return (value * 100).toFixed(2) + "%";
}

/**
 * Print similarity report to console
 */
export function printSimilarityReport(
  result1: ParseResult,
  result2: ParseResult,
): void {
  console.log("=== AST Similarity Report ===");
  console.log(`File 1: ${result1.filename} (${result1.language})`);
  console.log(
    `  Tree size: ${result1.tree.size()}, depth: ${result1.tree.depth()}\n`,
  );

  console.log(`File 2: ${result2.filename} (${result2.language})`);
  console.log(
    `  Tree size: ${result2.tree.size()}, depth: ${result2.tree.depth()}\n`,
  );

  const metrics = computeSimilarity(result1, result2);

  console.log("Similarity Metrics:");
  console.log(
    `  Cosine (histogram):    ${formatSimilarity(metrics.cosineHistogram)}`,
  );
  console.log(
    `  Structure:             ${formatSimilarity(metrics.structure)}`,
  );
  console.log(`  Jaccard:               ${formatSimilarity(metrics.jaccard)}`);
  console.log(
    `  Combined Score:        ${formatSimilarity(metrics.combined)}\n`,
  );

  const docComparison = compareDocumentation(result1, result2);
  console.log("=== Documentation Comparison ===");
  console.log(
    `  Doc count:    ${result1.commentStats.docCommentCount} vs ${result2.commentStats.docCommentCount} (diff: ${docComparison.docCommentDifference})`,
  );
  console.log(
    `  Doc lines:    ${result1.commentStats.totalDocLines} vs ${result2.commentStats.totalDocLines} (diff: ${docComparison.docLineDifference})`,
  );
  console.log(
    `  Doc cosine:   ${formatSimilarity(docComparison.docTextCosine)}\n`,
  );
}
