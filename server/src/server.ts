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
import MyInterpreter from './MyInterpreter.js';
import { CharStream, CommonTokenStream, ParseTreeWalker } from 'antlr4ng';
import { UsageGraphListener } from './UsageGraphListener';
import { constructTypeString, Type } from './types.js';
import { getSourceLocationKey } from './utils.js';



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
    

    const interpreter = new MyInterpreter(listener) as any;
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
            console.log(key)
            console.log(hole)
            const suggestions = hole.suggestions;
            const type = hole.type;

            const typeString = constructTypeString(type);

            const holeArgs = [
                hole,
                typeString,
                textDocument.uri
            ];
            const holeCommandUri = `command:myExtension.showHoleInfo?${encodeURIComponent(JSON.stringify(holeArgs))}`;

            console.log("Suggestions:", suggestions);

            const validSuggestions = suggestions.map((suggestion: any) => {
                console.log("hey")
                console.log(suggestion)
                let replacementWithTypes = ''
                let replacementWithoutTypes = ''
                if (suggestion.suggestionType === 'variable') {
                    replacementWithTypes = suggestion.suggestion.name
                    replacementWithoutTypes = suggestion.suggestion.name
                } else if (suggestion.suggestionType === 'function'){
                    let paramStringWithTypes = suggestion.suggestion.params.map((param: any) => `??: ${constructTypeString(param.type)}`).join(', ')
                    let paramStringWithoutTypes = suggestion.suggestion.params.map(() => `??`).join(', ')
                    let name = suggestion.suggestion.name.slice(0, -2)
                    if (suggestion.suggestion.structName) {
                        name = `${suggestion.suggestion.structName}::${name}`
                    }
                    replacementWithTypes = `${name}(${paramStringWithTypes})`
                    replacementWithoutTypes = `${name}(${paramStringWithoutTypes})`
                } else if (suggestion.suggestionType === 'method') {
                    let paramStringWithTypes = suggestion.suggestion.params.slice(1).map((param: any) => `??: ${constructTypeString(param.type)}`).join(', ')
                    let paramStringWithoutTypes = suggestion.suggestion.params.slice(1).map(() => `??`).join(', ')
                    replacementWithTypes = `${suggestion.suggestion.name.slice(0, -2)}(${paramStringWithTypes})`
                    replacementWithoutTypes = `${suggestion.suggestion.name.slice(0, -2)}(${paramStringWithoutTypes})`
                } else if (suggestion.suggestionType === 'field') {
                    replacementWithTypes = suggestion.suggestion.name
                    replacementWithoutTypes = suggestion.suggestion.name
                } else if (suggestion.suggestionType === 'slice') {
                    replacementWithTypes = suggestion.suggestion.name
                    replacementWithoutTypes = suggestion.suggestion.name
                }

                const args = [
                    textDocument.uri,
                    replaceRange,
                    replacementWithoutTypes
                ];
                const commandUri = `command:myExtension.applySuggestion?${encodeURIComponent(JSON.stringify(args))}`;
                return `**Suggestion:** [Replace](${commandUri}) with\`${replacementWithTypes}\``;
            });
            console.log("Hey")

            let hoverContent = "";

            if (validSuggestions.length > 0) {
                hoverContent = "Type: " + typeString + "\n\n" + validSuggestions.join('\n\n') + `\n\n[Show Full Context](${holeCommandUri})`;
            } else {
                hoverContent = "Type: " + typeString + "\n\nNo suggestions\n\n[Show Full Context](${holeCommandUri})";
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

// Listen for text document synchronization messages
documents.listen(connection);

// Listen on the connection
connection.listen();
