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
import MyInterpreter, { getSourceLocationKey, SourceLocation, Variable } from './MyInterpreter.js';
import { CharStream, CommonTokenStream } from 'antlr4ng';



function parseDocument(code: string) {
    const interpreter = new MyInterpreter() as any;
    const inputStream = CharStream.fromString(code);

    // 1. Lexer: Breaks text into tokens
    const lexer = new RustLexer(inputStream);
    const tokenStream = new CommonTokenStream(lexer);

    // 2. Parser: Builds the logic tree
    const parser = new RustParser(tokenStream);
    
    const tree = parser.crate(); 

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
    connection.console.log('Language Server initialized and ready.3');
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
    const startIndex = lineText.indexOf(triggerSequence);

    // If '??' exists on this line
    if (startIndex !== -1) {
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
            const suggestions = hole.suggestions;
            const type = hole.type;
            
            if (!suggestions) {
                return null;
            }
            const validSuggestions = suggestions.map((suggestion: any) => {
                let replacement = ''
                if (suggestion.suggestionType === 'variable') {
                    replacement = suggestion.suggestion.name
                } else if (suggestion.suggestionType === 'function'){
                    let paramString = suggestion.suggestion.params.map((param: any) => `??: ${param.type}`).join(', ')
                    replacement = `${suggestion.suggestion.name}(${paramString})`
                }
                console.log("hey")
                const args = [
                    textDocument.uri,
                    replaceRange,
                    replacement
                ];
                const commandUri = `command:myExtension.applySuggestion?${encodeURIComponent(JSON.stringify(args))}`;
                return `**Suggestion:** [Replace](${commandUri}) with \`${replacement}\``;
            });
            if (validSuggestions.length > 0) {
                return {
                    contents: {
                        kind: 'markdown',
                        value: "Type: " + type + "\n\n" + validSuggestions.join('\n\n')
                    },
                    range: replaceRange
                }
            }
        }
    }

    return null;
});

// Listen for text document synchronization messages
documents.listen(connection);

// Listen on the connection
connection.listen();
