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
    Connection
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';

import * as antlr4 from 'antlr4';
import ToyLangLexer from './parser/ToyLangLexer.js';
import ToyLangParser from './parser/ToyLangParser.js';
import MyInterpreter from './MyInterpreter.js';


const interpreter = new MyInterpreter() as any;

function parseDocument(code: string) {
    const chars = new antlr4.InputStream(code);
    const lexer = new ToyLangLexer(chars);
    const tokens = new antlr4.CommonTokenStream(lexer as unknown as antlr4.Lexer);
    const parser = new ToyLangParser(tokens);

    const tree = parser.program(); 

    return interpreter.visit(tree);
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
            }
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
        const triggerSequence = '?';
        
        // --- Core Logic to Detect Trigger Sequence ---
        
        // Check if the text immediately preceding the cursor matches the trigger
        if (line.endsWith(triggerSequence)) {
			console.log("I am here");
            console.log("I am here333333333333");
            let res = parseDocument(document.getText())
            console.log(res);
            console.log("I am here44444444444444");
            const startChar = position.character - triggerSequence.length;
            
            // Define the range to replace (the {|?} symbols themselves)
            const replaceRange: Range = {
                start: { line: position.line, character: startChar },
                end: position
            };

            // Create the Completion Item (only the label and kind are required here)
            // We store the replacement range in the 'data' field to be used in resolve.
            const snippetCompletion: CompletionItem = {
                label: 'Replace with Function Snippet',
                kind: CompletionItemKind.Snippet,
                
                // Store necessary context data for the resolve step
                data: { 
                    id: 'function-snippet-replacement',
                    range: replaceRange
                }
            };

            return [snippetCompletion];
        }

        return [];
    }
);

// Handler for completion item resolution (Step 2: Populate expensive details when item is selected)
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        // Ensure this item is one we created
        if (item.data && item.data.id === 'function-snippet-replacement') {
            console.log("I am here as well");
            // Retrieve the replacement range stored in the data field
            const replaceRange = item.data.range as Range;

            // Define the code snippet to be inserted (using LSP snippet syntax)
            const codeSnippet = [
                '// A helpful comment',
                'function ${1:functionName}(${2:params}) {',
                '    return ${3:true};',
                '}'
            ].join('\n');

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


// Listen for text document synchronization messages
documents.listen(connection);

// Listen on the connection
connection.listen();