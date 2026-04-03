/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, commands, Range, WorkspaceEdit, Uri, window, ViewColumn } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);


	context.subscriptions.push(
		commands.registerCommand('myExtension.applySuggestion', (uri: string, range: Range, newText: string) => {
			const edit = new WorkspaceEdit();
			edit.replace(Uri.parse(uri), range, newText);
			workspace.applyEdit(edit);
		})
	);

	context.subscriptions.push(
		commands.registerCommand('myExtension.showHoleInfo', async (uri: string, line: number, column: number) => {
			const result: any = await client.sendRequest('custom/holeInfo', { uri, line, column });
			if (!result) return;

			const panel = window.createWebviewPanel(
				'holeInfo',
				'Hole Information',
				ViewColumn.Beside,
				{ enableScripts: true }
			);

			panel.webview.onDidReceiveMessage(async (message) => {
				if (message.command === 'applySuggestion') {
					const { uri, range, newText } = message.args;
					const edit = new WorkspaceEdit();
					edit.replace(Uri.parse(uri), range, newText);
					await workspace.applyEdit(edit);
				}
			});

			let typeString = "Type: ";
			const type = result.type;
			if (type.valType == 'reference') {
				typeString += "&";
				if (type.mutableReference) {
					typeString += "mut ";
				}
				typeString += type.elementType;
			} else if (type.valType == 'Vec') {
				typeString += "Vec<" + type.elementType + ">";
			} else {
				typeString += type.valType;
			}

			const possibleValues = result.possibleValues.map((v: any) => v.name || v).join(', ');

			const suggestionsHtml = result.suggestions.map((s: any) => {
				let replacement = '';
				if (s.suggestionType === 'variable') {
					replacement = s.suggestion.name;
				} else if (s.suggestionType === 'function') {
					const paramString = s.suggestion.params.map((param: any) => `??: ${param.type}`).join(', ');
					replacement = `${s.suggestion.name}(${paramString})`;
				}
				const escapedReplacement = replacement.replace(/'/g, "\\'").replace(/"/g, '\\"');
				return `<li><a href="#" onclick="apply('${escapedReplacement}')">${replacement}</a></li>`;
			}).join('');

			panel.webview.html = `
				<!DOCTYPE html>
				<html>
				<head>
					<style>
						body { font-family: Arial, sans-serif; padding: 20px; }
						pre { background: #f4f4f4; padding: 10px; border-radius: 4px; }
						ul { list-style-type: disc; margin-left: 20px; }
					</style>
				</head>
				<body>
					<h2>${typeString}</h2>
					<h3>Current Full Context:</h3>
					<pre>${result.context}</pre>
					<h3>Possible Values to Fill:</h3>
					<p>${possibleValues}</p>
					<h3>Suggestions:</h3>
					<ul>${suggestionsHtml}</ul>
					<script>
						const vscode = acquireVsCodeApi();
						function apply(replacement) {
							vscode.postMessage({
								command: 'applySuggestion',
								args: {
									uri: '${result.uri}',
									range: ${JSON.stringify(result.range)},
									newText: replacement
								}
							});
						}
					</script>
				</body>
				</html>
			`;
		})
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'rust' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		},
		markdown: {
			isTrusted: true,
			supportHtml: true
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'languageServerExample',
		'Language Server Example',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
