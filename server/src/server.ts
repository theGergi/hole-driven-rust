import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    Range,
    TextEdit,
    InsertTextFormat,
    Connection,
    Hover,
    HoverParams
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';

import { RustLexer } from './parser/RustLexer';
import { RustParser } from './parser/RustParser';
import TypeChecker from './TypeChecker';
import { CharStream, CommonTokenStream, ParseTreeWalker } from 'antlr4ng';
import { UsageGraphListener } from './UsageListener';
import { getSourceLocationKey } from './utils.js';
import { parseStdJsonFile } from './stdParser';

const MAX_SUGGESTIONS = 20;

const stdParseResult = parseStdJsonFile();

function safeStringify(value: any): string {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, val) => {
        if (key === 'owner') return undefined;
        if (val !== null && typeof val === 'object') {
            if (seen.has(val)) return undefined;
            seen.add(val);
        }
        return val;
    });
}

function buildCommandUri(command: string, args: any): string {
    const encoded = encodeURIComponent(safeStringify(args))
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
    return `command:${command}?${encoded}`;
}

const HOLE_TRIGGER = '??';

function buildHoleInfo(hole: any, uri: string, range: Range) {
    return {
        typeString: hole.type.toTypeString(),
        variables: hole.context?.variables ?? [],
        functions: hole.context?.functions ?? [],
        suggestions: hole.suggestions ?? [],
        range,
        uri
    };
}

function findHoleAt(uri: string, line: number, character: number) {
    const document = documents.get(uri);
    if (!document) return null;

    const results = parseDocument(document.getText());
    const key = getSourceLocationKey({ line: line + 1, column: character, length: HOLE_TRIGGER.length });
    return results.get(key) ?? null;
}

// Toggle ownership on or off
const OWNERSHIP = !process.argv.includes('--no-ownership');

function parseDocument(code: string) {
    const inputStream = CharStream.fromString(code);
    
    // 1. Lexer: Breaks text into tokens
    const lexer = new RustLexer(inputStream);
    const tokenStream = new CommonTokenStream(lexer);
    
    // 2. Parser: Builds the logic tree
    const parser = new RustParser(tokenStream);
    
    const tree = parser.crate(); 
    
    const listener = new UsageGraphListener();
    ParseTreeWalker.DEFAULT.walk(listener, tree);
    

    const interpreter = new TypeChecker(listener, stdParseResult, OWNERSHIP) as any;
    interpreter.visit(tree)
    return interpreter.getFinalResult();
}


// Create a connection for the server. The connection uses Node's IPC as a transport.
const connection: Connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. This is used to hold the content of open text documents.
const documents = new TextDocuments<TextDocument>(TextDocument);

// Global variable to hold initialization parameters
let hasConfigurationCapability = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
    // Check if the client supports the Configuration feature (optional)
    const capabilities = params.capabilities;
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );

    const result: InitializeResult = {
        capabilities: {
            // 1. Tell the client we support full document synchronization.
            textDocumentSync: TextDocumentSyncKind.Full,

            // 2. Tell the client we support completion requests.
            completionProvider: {
                // IMPORTANT: Setting this to true enables the onCompletionResolve handler
                resolveProvider: true, 
                triggerCharacters: ['?'], // Key characters that might trigger completion early
            },
            hoverProvider: true
            // If using Code Actions, you would add:
            // codeActionProvider: true,
        }
    };
    return result;
});

// The initialized notification is sent from the client to the server after the client has received the
// result of the initialize request but before the client is opened in the editor.
connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for configuration changes if needed
    }
    connection.console.log('Language Server initialized and ready.');
});

connection.onHover((params: HoverParams): Hover | null => {
    const { textDocument, position } = params;
    const document = documents.get(textDocument.uri);
    
    if (!document) return null;

    // Get the specific line text
    const lineText = document.getText({
        start: { line: position.line, character: 0 },
        end: { line: position.line + 1, character: 0 }
    });

    const triggerSequence = '??';
    let startIndex = lineText.indexOf(triggerSequence);

    // If '??' exists on this line
    while (startIndex !== -1) {
        const endIndex = startIndex + triggerSequence.length;
        // Check if the cursor is actually hovering over the '??'
        if (position.character >= startIndex && position.character <= startIndex + triggerSequence.length) {
            
            // Run your parser
            const fullText = document.getText();
            const results = parseDocument(fullText);

            const replaceRange: Range = {
                start: { line: position.line, character: startIndex },
                end: { line: position.line, character: startIndex + triggerSequence.length }
            };
            const key = getSourceLocationKey({line: position.line + 1, column: startIndex, length: triggerSequence.length});
            const hole = results.get(key)

            if (!hole) {
                return null;
            }

            const suggestions = hole.suggestions.slice(0, MAX_SUGGESTIONS) ?? [];
            const type = hole.type;

            const typeString = type.toTypeString();

            const holeCommandUri = buildCommandUri('myExtension.showHoleInfo', [{
                uri: textDocument.uri,
                line: position.line,
                character: startIndex
            }]);

            console.log("Suggestions:", suggestions);

            const validSuggestions = suggestions.map((suggestion: any) => {
                
                const replacementWithTypes = suggestion.suggestionNameWithTypes;
                const replacementWithoutTypes = suggestion.suggestionNameWithoutTypes;

                const args = [
                    textDocument.uri,
                    replaceRange,
                    replacementWithoutTypes
                ];
                const commandUri = buildCommandUri('myExtension.applySuggestion', args);
                return ` - [Replace](${commandUri}) with\`${replacementWithTypes}\``;
            });
            console.log("Hey")

            let hoverContent = "";

            if (validSuggestions.length > 0) {
                hoverContent = "Type: " + typeString + "\n\n**Valid Fits:**\n\n" + validSuggestions.join('\n\n') + `\n\n[Show Full Context](${holeCommandUri})`;
            } else {
                hoverContent = "Type: " + typeString + "\n\nNo suggestions\n\n" + `[Show Full Context](${holeCommandUri})`;
            }

            return {
                contents: {
                    kind: 'markdown',
                    value: hoverContent
                },
                range: replaceRange
            }
        }
        startIndex = lineText.indexOf(triggerSequence, endIndex);
    }

    return null;
});

interface HoleInfoRequest {
    uri: string;
    line: number;
    character: number;
}

connection.onRequest('toy/getHoleInfo', (params: HoleInfoRequest) => {
    const hole = findHoleAt(params.uri, params.line, params.character);
    if (!hole) return null;

    const range: Range = {
        start: { line: params.line, character: params.character },
        end: { line: params.line, character: params.character + HOLE_TRIGGER.length }
    };

    return JSON.parse(safeStringify(buildHoleInfo(hole, params.uri, range)));
});

// Listen for text document synchronization messages
documents.listen(connection);

// Listen on the connection
connection.listen();
