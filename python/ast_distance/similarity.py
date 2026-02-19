"""Compute various similarity metrics between ASTs."""

from __future__ import annotations

import math

from .tree import Tree
from .node_types import NodeType
from .ast_parser import IdentifierStats


NUM_NODE_TYPES = int(NodeType.NUM_TYPES)

# ── Semantic weights ─────────────────────────────────────────────────────────

_STRUCTURAL = frozenset({
    NodeType.CLASS, NodeType.STRUCT, NodeType.FUNCTION, NodeType.IF,
    NodeType.WHILE, NodeType.FOR, NodeType.SWITCH, NodeType.TRY,
    NodeType.INTERFACE, NodeType.ENUM,
})
_OPERATIONS = frozenset({
    NodeType.CALL, NodeType.METHOD_CALL, NodeType.RETURN, NodeType.THROW,
    NodeType.LAMBDA, NodeType.COMPARISON_OP, NodeType.LOGICAL_OP,
})
_OPERATORS = frozenset({
    NodeType.ARITHMETIC_OP, NodeType.BITWISE_OP, NodeType.ASSIGNMENT_OP,
})
_COMMON = frozenset({NodeType.VARIABLE, NodeType.VAR_DECL})


def _get_node_weight(nt_int: int) -> float:
    try:
        nt = NodeType(nt_int)
    except ValueError:
        return 1.0
    if nt in _STRUCTURAL:
        return 5.0
    if nt in _OPERATIONS:
        return 2.0
    if nt in _OPERATORS:
        return 1.5
    if nt in _COMMON:
        return 0.5
    return 1.0


class ASTSimilarity:
    """Compute similarity metrics between ASTs."""

    @staticmethod
    def histogram_cosine_similarity(tree1: Tree, tree2: Tree) -> float:
        """Weighted cosine similarity based on node-type histogram."""
        hist1 = tree1.node_type_histogram(NUM_NODE_TYPES)
        hist2 = tree2.node_type_histogram(NUM_NODE_TYPES)
        dot = norm1 = norm2 = 0.0
        for i in range(NUM_NODE_TYPES):
            w = _get_node_weight(i)
            w1 = w * hist1[i]
            w2 = w * hist2[i]
            dot += w1 * w2
            norm1 += w1 * w1
            norm2 += w2 * w2
        if norm1 < 1e-8 or norm2 < 1e-8:
            return 0.0
        return dot / (math.sqrt(norm1) * math.sqrt(norm2))

    @staticmethod
    def histogram_cosine_similarity_macro(tree1: Tree, tree2: Tree) -> float:
        """Macro-friendly cosine similarity for Rust macro-heavy files."""
        hist1 = tree1.node_type_histogram(NUM_NODE_TYPES)
        hist2 = tree2.node_type_histogram(NUM_NODE_TYPES)
        dot = norm1 = norm2 = 0.0
        for i in range(NUM_NODE_TYPES):
            try:
                nt = NodeType(i)
            except ValueError:
                nt = NodeType.UNKNOWN
            weight = 1.0 if nt in (NodeType.VARIABLE, NodeType.UNKNOWN) else 0.0
            w1 = weight * hist1[i]
            w2 = weight * hist2[i]
            dot += w1 * w2
            norm1 += w1 * w1
            norm2 += w2 * w2
        if norm1 < 1e-8 or norm2 < 1e-8:
            return 0.0
        return dot / (math.sqrt(norm1) * math.sqrt(norm2))

    @staticmethod
    def node_type_jaccard(tree1: Tree, tree2: Tree) -> float:
        """Jaccard similarity of node type multisets."""
        hist1 = tree1.node_type_histogram(NUM_NODE_TYPES)
        hist2 = tree2.node_type_histogram(NUM_NODE_TYPES)
        inter = union = 0
        for i in range(NUM_NODE_TYPES):
            inter += min(hist1[i], hist2[i])
            union += max(hist1[i], hist2[i])
        return inter / union if union else 1.0

    @staticmethod
    def structure_similarity(tree1: Tree, tree2: Tree) -> float:
        """Compare tree shape (size + depth)."""
        s1, s2 = tree1.size(), tree2.size()
        d1, d2 = tree1.depth(), tree2.depth()
        size_sim = 1.0 - abs(s1 - s2) / max(s1, s2) if max(s1, s2) > 0 else 1.0
        depth_sim = 1.0 - abs(d1 - d2) / max(d1, d2) if max(d1, d2) > 0 else 1.0
        return 0.5 * size_sim + 0.5 * depth_sim

    @staticmethod
    def combined_similarity(
        tree1: Tree, tree2: Tree, *,
        hist_weight: float = 0.5,
        struct_weight: float = 0.3,
        jaccard_weight: float = 0.2,
    ) -> float:
        """Combined similarity score using multiple metrics."""
        h = ASTSimilarity.histogram_cosine_similarity(tree1, tree2)
        s = ASTSimilarity.structure_similarity(tree1, tree2)
        j = ASTSimilarity.node_type_jaccard(tree1, tree2)
        return hist_weight * h + struct_weight * s + jaccard_weight * j

    @staticmethod
    def combined_similarity_with_content(
        tree1: Tree,
        tree2: Tree,
        ids1: IdentifierStats,
        ids2: IdentifierStats,
    ) -> float:
        """Content-aware combined similarity with identifier dominance."""
        id_cos = ids1.canonical_cosine_similarity(ids2)
        id_jac = ids1.canonical_jaccard_similarity(ids2)
        hist = ASTSimilarity.histogram_cosine_similarity(tree1, tree2)
        jac = ASTSimilarity.node_type_jaccard(tree1, tree2)
        struct = ASTSimilarity.structure_similarity(tree1, tree2)
        return 0.50 * id_cos + 0.15 * id_jac + 0.15 * hist + 0.10 * jac + 0.10 * struct

    @staticmethod
    def tree_edit_distance(tree1: Tree, tree2: Tree) -> int:
        """Simplified tree edit distance via DP on post-order node sequences."""
        nodes1: list[Tree] = []
        tree1.traverse_postorder(lambda n: nodes1.append(n))
        nodes2: list[Tree] = []
        tree2.traverse_postorder(lambda n: nodes2.append(n))
        n, m = len(nodes1), len(nodes2)
        dp = [[0] * (m + 1) for _ in range(n + 1)]
        for i in range(n + 1):
            dp[i][0] = i
        for j in range(m + 1):
            dp[0][j] = j
        for i in range(1, n + 1):
            for j in range(1, m + 1):
                cost = 0 if nodes1[i - 1].node_type == nodes2[j - 1].node_type else 1
                dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
        return dp[n][m]

    @staticmethod
    def normalized_edit_distance(tree1: Tree, tree2: Tree) -> float:
        """Normalized edit distance (0→1, where 1 = identical)."""
        dist = ASTSimilarity.tree_edit_distance(tree1, tree2)
        max_size = max(tree1.size(), tree2.size())
        if max_size == 0:
            return 1.0
        return 1.0 - dist / max_size

    @staticmethod
    def compare(tree1: Tree, tree2: Tree, macro_friendly: bool = False) -> dict:
        """Full comparison report."""
        cosine = (
            ASTSimilarity.histogram_cosine_similarity_macro(tree1, tree2)
            if macro_friendly else
            ASTSimilarity.histogram_cosine_similarity(tree1, tree2)
        )
        struct = ASTSimilarity.structure_similarity(tree1, tree2)
        jaccard = ASTSimilarity.node_type_jaccard(tree1, tree2)
        edit = ASTSimilarity.normalized_edit_distance(tree1, tree2)
        combined = ASTSimilarity.combined_similarity(tree1, tree2)
        return {
            "cosine_sim": cosine,
            "structure_sim": struct,
            "jaccard_sim": jaccard,
            "edit_distance_sim": edit,
            "combined_score": combined,
            "size1": tree1.size(),
            "size2": tree2.size(),
            "depth1": tree1.depth(),
            "depth2": tree2.depth(),
        }
