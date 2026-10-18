public struct CodeToken: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case keyword, string, comment, number, type, key, meta, inserted, deleted
    }

    public let range: Range<String.Index>
    public let kind: Kind
}

/// A small lexer for the languages agents write most, enough to color
/// keywords, strings, comments, numbers and types. Unclosed strings and
/// comments, as in a code block still streaming in, run to the end of their
/// line or of the code. Unknown languages stay plain.
public enum CodeHighlighter {
    public static func tokens(in code: String, language: String?) -> [CodeToken] {
        guard let name = language?.lowercased() else { return [] }
        if name == "diff" || name == "patch" { return diffTokens(in: code) }
        guard let grammar = Grammar.named(name) else { return [] }
        var lexer = Lexer(code: code, grammar: grammar)
        return lexer.run()
    }

    private static func diffTokens(in code: String) -> [CodeToken] {
        var tokens: [CodeToken] = []
        var lineStart = code.startIndex
        while lineStart < code.endIndex {
            let lineEnd = code[lineStart...].firstIndex(of: "\n") ?? code.endIndex
            let line = code[lineStart..<lineEnd]
            let kind: CodeToken.Kind? =
                line.hasPrefix("@@") || line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff ") ? .meta
                : line.hasPrefix("+") ? .inserted
                : line.hasPrefix("-") ? .deleted
                : nil
            if let kind, !line.isEmpty { tokens.append(CodeToken(range: lineStart..<lineEnd, kind: kind)) }
            lineStart = lineEnd < code.endIndex ? code.index(after: lineEnd) : code.endIndex
        }
        return tokens
    }
}

private struct Grammar {
    var keywords: Set<String>
    var lineComments: [String] = []
    var blockComment: (open: String, close: String)?
    var quotes: Set<Character> = ["\"", "'"]
    /// Quotes whose strings may span lines, as JavaScript's template literals.
    var multilineQuotes: Set<Character> = []
    var tripleQuotes = false
    var capitalizedTypes = false
    var caseInsensitive = false
    /// A string or bare word followed by a colon is a key, as in JSON and YAML.
    var keys = false
    /// A line comment only starts at a token boundary, as shell's `#` does.
    var lineCommentsNeedWordStart = false

    static func named(_ name: String) -> Grammar? {
        switch name {
        case "swift":
            Grammar(keywords: swift, lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\""], tripleQuotes: true, capitalizedTypes: true)
        case "js", "javascript", "jsx", "ts", "typescript", "tsx", "mjs", "cjs":
            Grammar(keywords: javascript, lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\"", "'", "`"], multilineQuotes: ["`"], capitalizedTypes: true)
        case "python", "py":
            Grammar(keywords: python, lineComments: ["#"], tripleQuotes: true, capitalizedTypes: true)
        case "go", "golang":
            Grammar(keywords: go, lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\"", "'", "`"], multilineQuotes: ["`"], capitalizedTypes: true)
        case "rust", "rs":
            Grammar(keywords: rust, lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\""], capitalizedTypes: true)
        case "bash", "sh", "shell", "zsh", "console", "shellsession":
            Grammar(keywords: shell, lineComments: ["#"], lineCommentsNeedWordStart: true)
        case "c", "h", "cpp", "c++", "cc", "objc", "objective-c", "java", "kotlin", "kt", "cs", "csharp", "c#", "scala", "dart":
            Grammar(keywords: cFamily, lineComments: ["//"], blockComment: ("/*", "*/"), capitalizedTypes: true)
        case "ruby", "rb":
            Grammar(keywords: ruby, lineComments: ["#"], capitalizedTypes: true)
        case "sql":
            Grammar(keywords: sql, lineComments: ["--"], blockComment: ("/*", "*/"), caseInsensitive: true)
        case "json", "jsonc", "json5":
            Grammar(keywords: ["true", "false", "null"], lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\""], keys: true)
        case "yaml", "yml":
            Grammar(keywords: ["true", "false", "null", "yes", "no", "on", "off"], lineComments: ["#"], keys: true, lineCommentsNeedWordStart: true)
        case "toml":
            Grammar(keywords: ["true", "false", "null", "yes", "no", "on", "off"], lineComments: ["#"], keys: true)
        default:
            nil
        }
    }

    static let swift: Set<String> = ["let", "var", "func", "if", "else", "guard", "return", "try", "catch", "throw", "throws", "rethrows", "do", "for", "in", "while", "repeat", "switch", "case", "default", "break", "continue", "struct", "class", "enum", "protocol", "extension", "import", "public", "private", "fileprivate", "internal", "open", "package", "static", "final", "init", "deinit", "self", "Self", "super", "nil", "true", "false", "async", "await", "actor", "some", "any", "where", "as", "is", "inout", "mutating", "nonmutating", "nonisolated", "isolated", "sending", "consuming", "borrowing", "typealias", "associatedtype", "defer", "fallthrough", "get", "set", "willSet", "didSet", "lazy", "weak", "unowned", "override", "convenience", "required", "subscript", "operator", "macro"]
    static let javascript: Set<String> = ["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "new", "delete", "typeof", "instanceof", "in", "of", "class", "extends", "super", "this", "import", "export", "from", "as", "async", "await", "try", "catch", "finally", "throw", "yield", "null", "undefined", "true", "false", "void", "interface", "type", "enum", "implements", "public", "private", "protected", "readonly", "static", "abstract", "declare", "namespace", "keyof", "satisfies"]
    static let python: Set<String> = ["def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "break", "continue", "lambda", "yield", "global", "nonlocal", "None", "True", "False", "async", "await", "assert", "del", "match", "case", "self"]
    static let go: Set<String> = ["func", "package", "import", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "return", "if", "else", "for", "range", "switch", "case", "default", "break", "continue", "select", "fallthrough", "goto", "nil", "true", "false"]
    static let rust: Set<String> = ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "crate", "self", "Self", "super", "match", "if", "else", "for", "while", "loop", "in", "return", "break", "continue", "as", "ref", "move", "async", "await", "dyn", "where", "const", "static", "unsafe", "extern", "type", "true", "false", "Some", "None", "Ok", "Err"]
    static let shell: Set<String> = ["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "readonly", "declare", "unset", "source", "alias", "echo", "exit", "set", "shift", "cd", "sudo"]
    static let cFamily: Set<String> = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "goto", "struct", "union", "enum", "typedef", "static", "const", "extern", "void", "int", "char", "float", "double", "long", "short", "unsigned", "signed", "bool", "boolean", "true", "false", "null", "nullptr", "class", "public", "private", "protected", "new", "delete", "this", "virtual", "override", "final", "namespace", "using", "template", "typename", "try", "catch", "throw", "throws", "import", "package", "interface", "extends", "implements", "fun", "val", "var", "when", "object", "auto", "async", "await"]
    static let ruby: Set<String> = ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "nil", "true", "false", "self", "require", "attr_accessor", "attr_reader"]
    static let sql: Set<String> = ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "as", "null", "is", "in", "distinct", "primary", "key", "references", "default", "with", "union", "case", "when", "then", "else", "end", "returning"]
}

private struct Lexer {
    let code: String
    let grammar: Grammar
    var tokens: [CodeToken] = []
    var index: String.Index

    init(code: String, grammar: Grammar) {
        self.code = code
        self.grammar = grammar
        index = code.startIndex
    }

    mutating func run() -> [CodeToken] {
        while index < code.endIndex {
            let start = index
            let c = code[index]
            if let block = grammar.blockComment, code[index...].hasPrefix(block.open) {
                index = code.range(of: block.close, range: code.index(index, offsetBy: block.open.count)..<code.endIndex)?.upperBound ?? code.endIndex
                emit(start, .comment)
            } else if let marker = grammar.lineComments.first(where: { code[index...].hasPrefix($0) }),
                      !grammar.lineCommentsNeedWordStart || marker != "#" || atWordStart {
                index = endOfLine
                emit(start, .comment)
            } else if grammar.tripleQuotes, let triple = ["\"\"\"", "'''"].first(where: { code[index...].hasPrefix($0) }) {
                index = code.range(of: triple, range: code.index(index, offsetBy: 3)..<code.endIndex)?.upperBound ?? code.endIndex
                emit(start, .string)
            } else if grammar.quotes.contains(c) {
                scanString(quote: c)
                emit(start, grammar.keys && followedByColon ? .key : .string)
            } else if c.isNumber, c.isASCII, !afterIdentifierCharacter {
                advance(while: { $0.isHexDigit || $0 == "." || $0 == "_" || $0 == "x" || $0 == "X" })
                emit(start, .number)
            } else if c.isLetter || c == "_" {
                advance(while: { $0.isLetter || $0.isNumber || $0 == "_" })
                classifyWord(from: start)
            } else {
                index = code.index(after: index)
            }
        }
        return tokens
    }

    private mutating func classifyWord(from start: String.Index) {
        let word = code[start..<index]
        // A member after a dot is never a keyword: `FileManager.default`.
        if start > code.startIndex, code[code.index(before: start)] == "." { return }
        if grammar.keys, followedByColon, isFirstOnLine(start) {
            emit(start, .key)
        } else if grammar.keywords.contains(grammar.caseInsensitive ? word.lowercased() : String(word)) {
            emit(start, .keyword)
        } else if grammar.capitalizedTypes, word.first?.isUppercase == true {
            emit(start, .type)
        }
    }

    private mutating func scanString(quote: Character) {
        index = code.index(after: index)
        let multiline = grammar.multilineQuotes.contains(quote)
        while index < code.endIndex {
            let c = code[index]
            if c == "\\" {
                index = code.index(after: index)
                if index < code.endIndex { index = code.index(after: index) }
            } else if c == quote {
                index = code.index(after: index)
                return
            } else if c == "\n", !multiline {
                return
            } else {
                index = code.index(after: index)
            }
        }
    }

    private mutating func advance(while predicate: (Character) -> Bool) {
        while index < code.endIndex, predicate(code[index]) { index = code.index(after: index) }
    }

    private mutating func emit(_ start: String.Index, _ kind: CodeToken.Kind) {
        tokens.append(CodeToken(range: start..<index, kind: kind))
    }

    private var endOfLine: String.Index {
        code[index...].firstIndex(of: "\n") ?? code.endIndex
    }

    private var atWordStart: Bool {
        index == code.startIndex || code[code.index(before: index)].isWhitespace
    }

    private var afterIdentifierCharacter: Bool {
        guard index > code.startIndex else { return false }
        let previous = code[code.index(before: index)]
        return previous.isLetter || previous == "_"
    }

    private var followedByColon: Bool {
        code[index...].first { $0 != " " && $0 != "\t" } == ":"
    }

    private func isFirstOnLine(_ start: String.Index) -> Bool {
        let lineStart = code[..<start].lastIndex(of: "\n").map(code.index(after:)) ?? code.startIndex
        return code[lineStart..<start].allSatisfy { $0 == " " || $0 == "\t" || $0 == "-" }
    }
}
