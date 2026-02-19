"""Tree structure for normalized AST representation."""

from __future__ import annotations

from typing import Callable

from .node_types import NodeType


class Tree:
    """A basic tree structure for AST representation."""

    __slots__ = ("node_type", "label", "children", "parent", "leaf_idx",
                 "_cached_size", "_cached_depth")

    def __init__(self, node_type: int = 0, label: str = "") -> None:
        self.node_type: int = node_type
        self.label: str = label
        self.children: list[Tree] = []
        self.parent: Tree | None = None
        self.leaf_idx: int = -1
        self._cached_size: int = -1
        self._cached_depth: int = -1

    def add_child(self, child: Tree) -> None:
        child.parent = self
        self.children.append(child)
        self._invalidate()

    def is_leaf(self) -> bool:
        return len(self.children) == 0

    def size(self) -> int:
        if self._cached_size >= 0:
            return self._cached_size
        s = 1
        for child in self.children:
            s += child.size()
        self._cached_size = s
        return s

    def depth(self) -> int:
        if self._cached_depth >= 0:
            return self._cached_depth
        d = 0
        for child in self.children:
            d = max(d, child.depth())
        if self.children:
            d += 1
        self._cached_depth = d
        return d

    def traverse_preorder(self, fn: Callable[[Tree], None]) -> None:
        fn(self)
        for child in self.children:
            child.traverse_preorder(fn)

    def traverse_postorder(self, fn: Callable[[Tree], None]) -> None:
        for child in self.children:
            child.traverse_postorder(fn)
        fn(self)

    def get_leaves(self) -> list[Tree]:
        leaves: list[Tree] = []
        self.traverse_preorder(lambda n: leaves.append(n) if n.is_leaf() else None)
        return leaves

    def node_type_histogram(self, num_types: int = NodeType.NUM_TYPES) -> list[int]:
        hist = [0] * num_types
        def _count(node: Tree) -> None:
            if 0 <= node.node_type < num_types:
                hist[node.node_type] += 1
        self.traverse_preorder(_count)
        return hist

    def flatten_node_type(self, type_to_flatten: int) -> None:
        """Flatten nodes of a specific type, replacing them with their children."""
        if not self.children:
            return
        new_children: list[Tree] = []
        for child in self.children:
            child.flatten_node_type(type_to_flatten)
            if child.node_type == type_to_flatten:
                for gc in child.children:
                    gc.parent = self
                    new_children.append(gc)
            else:
                new_children.append(child)
        self.children = new_children
        self._invalidate()

    def _invalidate(self) -> None:
        self._cached_size = -1
        self._cached_depth = -1
