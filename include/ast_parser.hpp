#pragma once

#include "tree.hpp"
#include "node_types.hpp"
#include <tree_sitter/api.h>
#include <string>
#include <fstream>
#include <sstream>

// External declarations for tree-sitter language functions
extern "C" {
    const TSLanguage* tree_sitter_rust();
    const TSLanguage* tree_sitter_kotlin();
}

namespace ast_distance {

enum class Language {
    RUST,
    KOTLIN
};

/**
 * AST Parser using tree-sitter.
 * Parses source files into normalized Tree structures.
 */
class ASTParser {
public:
    ASTParser() {
        parser_ = ts_parser_new();
    }

    ~ASTParser() {
        if (parser_) {
            ts_parser_delete(parser_);
        }
    }

    // Non-copyable
    ASTParser(const ASTParser&) = delete;
    ASTParser& operator=(const ASTParser&) = delete;

    // Movable
    ASTParser(ASTParser&& other) noexcept : parser_(other.parser_) {
        other.parser_ = nullptr;
    }

    /**
     * Parse a source file into a normalized AST.
     */
    TreePtr parse_file(const std::string& filepath, Language lang) {
        std::ifstream file(filepath);
        if (!file.is_open()) {
            throw std::runtime_error("Cannot open file: " + filepath);
        }

        std::stringstream buffer;
        buffer << file.rdbuf();
        return parse_string(buffer.str(), lang);
    }

    /**
     * Parse source code string into a normalized AST.
     */
    TreePtr parse_string(const std::string& source, Language lang) {
        // Set language
        const TSLanguage* ts_lang = (lang == Language::RUST)
            ? tree_sitter_rust()
            : tree_sitter_kotlin();

        if (!ts_parser_set_language(parser_, ts_lang)) {
            throw std::runtime_error("Failed to set parser language");
        }

        // Parse
        TSTree* ts_tree = ts_parser_parse_string(
            parser_, nullptr, source.c_str(), source.length());

        if (!ts_tree) {
            throw std::runtime_error("Failed to parse source");
        }

        // Convert to our Tree structure
        TSNode root = ts_tree_root_node(ts_tree);
        TreePtr result = convert_node(root, source, lang);

        ts_tree_delete(ts_tree);
        return result;
    }

    /**
     * Parse and extract only function bodies for comparison.
     */
    std::vector<std::pair<std::string, TreePtr>> extract_functions(
            const std::string& source, Language lang) {
        std::vector<std::pair<std::string, TreePtr>> functions;

        // Set language
        const TSLanguage* ts_lang = (lang == Language::RUST)
            ? tree_sitter_rust()
            : tree_sitter_kotlin();

        if (!ts_parser_set_language(parser_, ts_lang)) {
            throw std::runtime_error("Failed to set parser language");
        }

        TSTree* ts_tree = ts_parser_parse_string(
            parser_, nullptr, source.c_str(), source.length());

        if (!ts_tree) {
            throw std::runtime_error("Failed to parse source");
        }

        TSNode root = ts_tree_root_node(ts_tree);
        extract_functions_recursive(root, source, lang, functions);

        ts_tree_delete(ts_tree);
        return functions;
    }

private:
    TSParser* parser_;

    TreePtr convert_node(TSNode node, const std::string& source, Language lang) {
        const char* type_str = ts_node_type(node);

        // Normalize node type
        NodeType normalized_type = (lang == Language::RUST)
            ? rust_node_to_type(type_str)
            : kotlin_node_to_type(type_str);

        auto tree_node = std::make_shared<Tree>(
            static_cast<int>(normalized_type), type_str);

        // For leaf nodes, store the index
        uint32_t child_count = ts_node_child_count(node);
        if (child_count == 0) {
            // Get the actual text for debugging
            uint32_t start = ts_node_start_byte(node);
            uint32_t end = ts_node_end_byte(node);
            if (end > start && end <= source.length()) {
                tree_node->label = source.substr(start, end - start);
            }
        }

        // Recursively process children
        for (uint32_t i = 0; i < child_count; ++i) {
            TSNode child = ts_node_child(node, i);
            // Skip unnamed nodes (syntax tokens like punctuation)
            if (ts_node_is_named(child)) {
                tree_node->add_child(convert_node(child, source, lang));
            }
        }

        return tree_node;
    }

    void extract_functions_recursive(
            TSNode node,
            const std::string& source,
            Language lang,
            std::vector<std::pair<std::string, TreePtr>>& functions) {

        const char* type_str = ts_node_type(node);
        bool is_function = false;
        std::string func_name;

        // Check if this is a function declaration
        if (lang == Language::RUST) {
            is_function = (std::string(type_str) == "function_item");
        } else {
            is_function = (std::string(type_str) == "function_declaration");
        }

        if (is_function) {
            // Extract function name
            uint32_t child_count = ts_node_child_count(node);
            for (uint32_t i = 0; i < child_count; ++i) {
                TSNode child = ts_node_child(node, i);
                const char* child_type = ts_node_type(child);

                if ((lang == Language::RUST && std::string(child_type) == "identifier") ||
                    (lang == Language::KOTLIN && std::string(child_type) == "simple_identifier")) {
                    uint32_t start = ts_node_start_byte(child);
                    uint32_t end = ts_node_end_byte(child);
                    if (end > start && end <= source.length()) {
                        func_name = source.substr(start, end - start);
                        break;
                    }
                }
            }

            // Convert the function AST
            TreePtr func_tree = convert_node(node, source, lang);
            functions.emplace_back(func_name, func_tree);
        }

        // Recurse into children
        uint32_t child_count = ts_node_child_count(node);
        for (uint32_t i = 0; i < child_count; ++i) {
            TSNode child = ts_node_child(node, i);
            extract_functions_recursive(child, source, lang, functions);
        }
    }
};

} // namespace ast_distance
