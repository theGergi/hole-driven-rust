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
import MyInterpreter, { SourceLocation, Variable } from './MyInterpreter.js';
import { CharStream, CommonTokenStream } from 'antlr4ng';


const interpreter = new MyInterpreter() as any;

function parseDocument(code: string) {
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


// Handler for the core feature: textDocument/completion (Step 1: Return minimal data quickly)
connection.onCompletion(
    (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        const document = documents.get(textDocumentPosition.textDocument.uri);
        if (!document) {
            return [];
        }

        const position = textDocumentPosition.position;
        const line = document.getText({ start: { line: position.line, character: 0 }, end: position });
        const triggerSequence = '??';
        
        // --- Core Logic to Detect Trigger Sequence ---
        
        // Check if the text immediately preceding the cursor matches the trigger
        if (line.endsWith(triggerSequence)) {
            const startChar = position.character - triggerSequence.length;

            // Define the range to replace (the {?} symbols themselves)

            const replaceRange: Range = {
                start: { line: position.line, character: startChar },
                end: position
            };

            let results = parseDocument(document.getText())
            results.forEach((variable: Variable, location: SourceLocation) => {
                const { line, column, length } = location;

                // Note: Many parsers use 1-based indexing for lines/columns. 
                // VS Code uses 0-based indexing. Adjust if necessary (e.g., line - 1).
                const isSameLocation = 
                    position.line + 1 === line && 
                    startChar === column && 
                    triggerSequence.length === length;
                console.log("hey")
                console.log(position)
                console.log(location)
                console.log(variable)
                console.log(isSameLocation)
                if (isSameLocation) {

                    const snippetCompletion: CompletionItem = {
                        label: `Replace with ${variable.name}`,
                        kind: CompletionItemKind.Snippet,
                        // insertText is what actually gets put into the document
                        insertText: variable.name, 
                        
                        data: { 
                            id: 'function-snippet-replacement',
                            range: replaceRange,
                        }
                    };
                    console.log("hey2")

                    return [snippetCompletion];
                }
            });
        }

        return [];
    }
);

// Handler for completion item resolution (Step 2: Populate expensive details when item is selected)
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        console.log("I am here as well");
        // Ensure this item is one we created
        if (item.data && item.data.id === 'function-snippet-replacement') {
            console.log("I am here as well");
            // Retrieve the replacement range stored in the data field
            const replaceRange = item.data.range as Range;
            const codeSnippet = item.insertText as string;

            // Populate the detailed fields now that the user has selected the item
            item.detail = 'Expands {?} into a boilerplate function.';
            
            // CRUCIAL: TextEdit is used for multi-line insertions AND for replacing existing text.
            item.textEdit = TextEdit.replace(replaceRange, codeSnippet);
            
            // Ensures the client knows to interpret the content as a snippet
            item.insertTextFormat = InsertTextFormat.Snippet;

            // Optional: Re-adding insertText as a robust fallback for the client
            item.insertText = codeSnippet;
        }
        return item;
    }
);

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
            
            for (const [location, variable] of results) {
                const { line, column, length } = location;

                // Note: Many parsers use 1-based indexing for lines/columns. 
                // VS Code uses 0-based indexing. Adjust if necessary (e.g., line - 1).
                const isSameLocation = 
                    position.line + 1 === line && 
                    startIndex === column && 
                    triggerSequence.length === length;
                console.log("hey")
                console.log(startIndex)
                console.log(position)
                console.log(location)
                console.log(variable)
                console.log(isSameLocation)
                const replaceRange: Range = {
                    start: { line: position.line, character: startIndex },
                    end: { line: position.line, character: startIndex + triggerSequence.length }
                };
                console.log(replaceRange)
                if (isSameLocation) {

                    return {
                        contents: {
                            kind: 'markdown',
                            value: `**Suggestion:** Replace with \`${variable.name}\`\n\n*Matches parsed location at col ${location.column}*`
                        },
                        range: replaceRange
                    };
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
