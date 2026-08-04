/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, commands, Range, WorkspaceEdit, Uri, window, ViewColumn } from 'vscode';
import { constructTypeString, formatFunction, formatVariable } from '../../shared/out/types.js';

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
		commands.registerCommand('myExtension.showHoleInfo', async (location: { uri: string; line: number; character: number }) => {
			const holeInfo: any = await client.sendRequest('toy/getHoleInfo', location);
			if (!holeInfo) {
				window.showInformationMessage('No hole information available at this position.');
				return;
			}

			const result = {
				typeString: holeInfo.typeString,
				variables: holeInfo.variables ?? [],
				functions: holeInfo.functions ?? [],
				suggestions: holeInfo.suggestions ?? [],
				range: holeInfo.range,
				uri: holeInfo.uri
			};

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

			// const possibleValues = result.possibleValues.map((v: any) => `<li> ${v.name || v} </li>`);

			const suggestionsHtml = result.suggestions.map((s: any) => {
				let replacement = '';
				if (s.suggestionType === 'variable') {
					replacement = formatVariable(s.suggestion);
				} else if (s.suggestionType === 'function') {
					replacement = formatFunction(s.suggestion);
				} else if (s.suggestionType === 'method' || s.suggestionType === 'field' || s.suggestionType === 'slice' || s.suggestionType === 'index' || s.suggestionType === 'range') {
					replacement = s.suggestion.name;
				}
				if (!replacement) return '';
				const escapedReplacement = replacement.replace(/'/g, "\\'").replace(/"/g, '\\"');
				return `<li><a href="#" onclick="apply('${escapedReplacement}')">${replacement}</a></li>`;
			}).join('');

			const formattedVariables = result.variables
				.map((v: any) => formatVariable(v))
				.join('<br>');
			const formattedFunctions = result.functions
				.map((f: any) => formatFunction(f))
				.join('<br>');

			panel.webview.html = `
				<!DOCTYPE html>
				<html>
				<head>
					<style>
						body { font-family: Arial, sans-serif; zoom: 1.2; }
						pre { background: #f4f4f4; padding: 10px; border-radius: 4px; }
						.context { font-family: 'Courier New', monospace; margin: 0; }
					</style>
				</head>
				<body>
					<h3>Type:</h3>
					<div class="context">${result.typeString}</div>
					<h3>Current Full Context:</h3>
					<h4>Variables:</h4>
					<div class="context">${formattedVariables}</div>
					<h4>Functions:</h4>
					<div class="context">${formattedFunctions}</div>
					<h3>Valid Fits:</h3>
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
