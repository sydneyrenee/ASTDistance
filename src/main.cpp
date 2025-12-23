#include "ast_parser.hpp"
#include "similarity.hpp"
#include "tree_lstm.hpp"
#include <iostream>
#include <filesystem>
#include <iomanip>

using namespace ast_distance;

void print_usage(const char* program) {
    std::cerr << "Usage: " << program << " <rust_file> <kotlin_file>\n";
    std::cerr << "       " << program << " --compare-functions <rust_file> <kotlin_file>\n";
    std::cerr << "       " << program << " --dump <file> <rust|kotlin>\n";
    std::cerr << "\nCompare AST similarity between Rust and Kotlin source files.\n";
}

void dump_tree(Tree* node, int indent = 0) {
    std::string pad(indent * 2, ' ');
    const char* type_name = node_type_name(static_cast<NodeType>(node->node_type));

    std::cout << pad << type_name << " (" << node->label << ")";
    if (node->is_leaf()) {
        std::cout << " [leaf]";
    }
    std::cout << "\n";

    for (auto& child : node->children) {
        dump_tree(child.get(), indent + 1);
    }
}

void print_histogram(const std::vector<int>& hist) {
    std::cout << "Node Type Histogram:\n";
    for (int i = 0; i < static_cast<int>(hist.size()); ++i) {
        if (hist[i] > 0) {
            const char* name = node_type_name(static_cast<NodeType>(i));
            std::cout << "  " << std::setw(15) << std::left << name
                      << ": " << hist[i] << "\n";
        }
    }
}

int main(int argc, char* argv[]) {
    if (argc < 3) {
        print_usage(argv[0]);
        return 1;
    }

    std::string mode = argv[1];

    try {
        ASTParser parser;

        if (mode == "--dump" && argc >= 4) {
            std::string filepath = argv[2];
            std::string lang_str = argv[3];
            Language lang = (lang_str == "rust") ? Language::RUST : Language::KOTLIN;

            std::cout << "Parsing " << filepath << " as " << lang_str << "...\n\n";
            TreePtr tree = parser.parse_file(filepath, lang);

            std::cout << "AST Structure:\n";
            dump_tree(tree.get());

            std::cout << "\n";
            auto hist = tree->node_type_histogram(ASTSimilarity::NUM_NODE_TYPES);
            print_histogram(hist);

            std::cout << "\nTree Statistics:\n";
            std::cout << "  Size:  " << tree->size() << " nodes\n";
            std::cout << "  Depth: " << tree->depth() << "\n";

        } else if (mode == "--compare-functions" && argc >= 4) {
            std::string rust_file = argv[2];
            std::string kotlin_file = argv[3];

            std::cout << "Extracting functions from " << rust_file << "...\n";
            std::ifstream rs_stream(rust_file);
            std::stringstream rs_buffer;
            rs_buffer << rs_stream.rdbuf();
            auto rust_funcs = parser.extract_functions(rs_buffer.str(), Language::RUST);

            std::cout << "Found " << rust_funcs.size() << " Rust functions\n";
            for (const auto& [name, tree] : rust_funcs) {
                std::cout << "  - " << name << " (" << tree->size() << " nodes)\n";
            }

            std::cout << "\nExtracting functions from " << kotlin_file << "...\n";
            std::ifstream kt_stream(kotlin_file);
            std::stringstream kt_buffer;
            kt_buffer << kt_stream.rdbuf();
            auto kotlin_funcs = parser.extract_functions(kt_buffer.str(), Language::KOTLIN);

            std::cout << "Found " << kotlin_funcs.size() << " Kotlin functions\n";
            for (const auto& [name, tree] : kotlin_funcs) {
                std::cout << "  - " << name << " (" << tree->size() << " nodes)\n";
            }

            // Compare functions with similar names
            std::cout << "\n=== Function Similarity Matrix ===\n\n";
            std::cout << std::setw(20) << "";
            for (const auto& [kt_name, _] : kotlin_funcs) {
                std::cout << std::setw(12) << kt_name.substr(0, 10);
            }
            std::cout << "\n";

            for (const auto& [rs_name, rs_tree] : rust_funcs) {
                std::cout << std::setw(20) << rs_name.substr(0, 18);
                for (const auto& [kt_name, kt_tree] : kotlin_funcs) {
                    float sim = ASTSimilarity::combined_similarity(
                        rs_tree.get(), kt_tree.get());
                    std::cout << std::setw(12) << std::fixed << std::setprecision(3) << sim;
                }
                std::cout << "\n";
            }

        } else {
            // Default: compare two files
            std::string rust_file = argv[1];
            std::string kotlin_file = argv[2];

            std::cout << "Parsing Rust file: " << rust_file << "\n";
            TreePtr rust_tree = parser.parse_file(rust_file, Language::RUST);

            std::cout << "Parsing Kotlin file: " << kotlin_file << "\n";
            TreePtr kotlin_tree = parser.parse_file(kotlin_file, Language::KOTLIN);

            std::cout << "\n";
            auto report = ASTSimilarity::compare(rust_tree.get(), kotlin_tree.get());
            report.print();

            std::cout << "\n=== Rust AST Histogram ===\n";
            print_histogram(report.hist1);

            std::cout << "\n=== Kotlin AST Histogram ===\n";
            print_histogram(report.hist2);
        }

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
