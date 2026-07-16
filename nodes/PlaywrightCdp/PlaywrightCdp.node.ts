import type {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	INodeExecutionData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import * as playwright from 'playwright-core';
import { createHelpers } from './helpers';
import { executeUserCode, normalizeResult } from './execute';
import type { ExecutionSandbox } from './types';

type HumanPreset = 'default' | 'careful';

function applyCloakConnectionOptions(
	endpoint: string,
	options: { proxy?: string; geoip?: boolean },
): string {
	const url = new URL(endpoint);

	// cloakserve reads these values from the CDP connection query string.
	// Manager profile endpoints ignore them; configure those values on the
	// profile before launching it instead.
	if (options.proxy?.trim()) {
		url.searchParams.set('proxy', options.proxy.trim());
	}
	if (options.geoip) {
		url.searchParams.set('geoip', 'true');
	}

	return url.toString();
}

interface NativeHumanModule {
	patchBrowser(browser: playwright.Browser, config: Record<string, unknown>): void;
	resolveConfig(preset?: HumanPreset): Record<string, unknown>;
}

let nativeHumanModulePromise: Promise<NativeHumanModule> | undefined;

/**
 * CloakBrowser is ESM-only while n8n community nodes are emitted as CommonJS.
 * Keep the native human module as a runtime ESM import so the packaged node can
 * load it without changing n8n's module format.
 */
function loadNativeHumanModule(): Promise<NativeHumanModule> {
	if (!nativeHumanModulePromise) {
		const dynamicImport = new Function(
			'modulePath',
			'return import(modulePath);',
		) as (modulePath: string) => Promise<NativeHumanModule>;
		nativeHumanModulePromise = dynamicImport('cloakbrowser/human');
	}

	return nativeHumanModulePromise;
}

const DEFAULT_CODE = `// Available variables:
// $('NodeName') - Get data from another node (like n8n Code node)
// $playwright - Playwright instance
// $browser - Connected browser instance
// $context - Default browser context (humanized by CloakBrowser when enabled)
// $helpers - Helper functions:
//   - screenshot(page, options) - Take screenshot, returns binary
//   - pdf(page, options) - Generate PDF (headless only)
//   - download(url | page, options) - Download file, returns binary
//   - binaryToFile(propertyName, itemIndex?) - Convert n8n binary to file
//   - upload(page, files, options) - Upload files to page
//   - interceptRequests(page, pattern, handler) - Intercept requests
//   - snapshot(page) - Get accessibility snapshot as string
// $input - Input data from previous node
// $json - Shortcut for $input.item.json
// $binary - Binary data from previous node
// $humanized - true if CloakBrowser humanize is enabled

const page = await $context.newPage();
await page.goto('https://example.com');

const title = await page.title();
await page.close();

return { title };`;

export class PlaywrightCdp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Playwright CDP',
		name: 'playwrightCdp',
		icon: 'file:playwright-cdp.svg',
		group: ['transform'],
		version: 1,
		subtitle: 'Execute Playwright code via CDP',
		description: 'Connect to browser via CDP and execute Playwright code',
		defaults: {
			name: 'Playwright CDP',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'CDP Endpoint URL',
				name: 'cdpEndpoint',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'http://cloakbrowser:9222',
				description:
					'URL exposed by CloakBrowser cloakserve. Use the Docker service name when n8n and CloakBrowser share a network, or host.docker.internal when they run in separate containers.',
			},
			{
				displayName: 'JavaScript Code',
				name: 'code',
				type: 'string',
				typeOptions: {
					editor: 'codeNodeEditor',
					editorLanguage: 'javaScript',
					rows: 10,
				},
				default: DEFAULT_CODE,
				required: true,
				noDataExpression: true,
				description: 'Code to execute. Available: $playwright, $browser, $context, $helpers, $input, $JSON.',
			},
			{
				displayName: 'Emulate Human Behavior',
				name: 'emulateHuman',
				type: 'boolean',
				default: false,
				description:
					'Whether to enable CloakBrowser native humanization for mouse curves, realistic typing, scrolling, locators, frames, and element handles',
			},
			{
				displayName: 'Humanize Preset',
				name: 'humanPreset',
				type: 'options',
				options: [
					{
						name: 'Default',
						value: 'default',
						description: 'Normal human speed',
					},
					{
						name: 'Careful',
						value: 'careful',
						description: 'Slower, more deliberate actions with idle micro-movements',
					},
				],
				default: 'default',
				displayOptions: {
					show: {
						emulateHuman: [true],
					},
				},
				description:
					'Native CloakBrowser preset. Individual actions can also override settings with the human_config option.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Connection Timeout (Ms)',
						name: 'connectionTimeout',
						type: 'number',
						default: 30000,
						description: 'Timeout for connecting to CDP endpoint in milliseconds',
						typeOptions: {
							minValue: 1000,
							maxValue: 300000,
						},
					},
					{
						displayName: 'Execution Timeout (Ms)',
						name: 'executionTimeout',
						type: 'number',
						default: 60000,
						description: 'Maximum code execution time in milliseconds. 0 = no limit.',
						typeOptions: {
							minValue: 0,
							maxValue: 3600000,
						},
					},
					{
						displayName: 'GeoIP',
						name: 'geoip',
						type: 'boolean',
						default: false,
						description:
							'Whether CloakBrowser should detect timezone and locale from the proxy exit IP. Applies to cloakserve connection URLs.',
					},
					{
						displayName: 'Proxy URL',
						name: 'proxy',
						type: 'string',
						default: '',
						placeholder: 'http://user:password@proxy:8080',
						description:
							'HTTP or SOCKS5 proxy passed to CloakBrowser cloakserve. For Manager profiles, configure the proxy on the profile before launching it.',
					},
					{
						displayName: 'Session Cleanup',
						name: 'sessionCleanup',
						type: 'options',
						options: [
							{
								name: 'Close Browser',
								value: 'close',
								description: 'Close the remote browser session after this node finishes',
							},
							{
								name: 'Disconnect Only',
								value: 'disconnect',
								description: 'Keep the remote browser and pages alive for later n8n nodes',
							},
						],
						default: 'close',
						description:
							'Choose whether this node closes the Manager/CloakBrowser session or only disconnects its CDP client connection',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let browser: playwright.Browser | null = null;
			let sessionCleanup: 'close' | 'disconnect' = 'close';

			try {
				// Get parameters
				const cdpEndpoint = this.getNodeParameter('cdpEndpoint', itemIndex) as string;
				const code = this.getNodeParameter('code', itemIndex) as string;
				const emulateHuman = this.getNodeParameter('emulateHuman', itemIndex) as boolean;
				const humanPreset = this.getNodeParameter('humanPreset', itemIndex, 'default') as HumanPreset;
				const options = this.getNodeParameter('options', itemIndex, {}) as {
					connectionTimeout?: number;
					executionTimeout?: number;
					proxy?: string;
					geoip?: boolean;
					sessionCleanup?: 'close' | 'disconnect';
				};
				const connectionTimeout = options.connectionTimeout ?? 30000;
				const executionTimeout = options.executionTimeout ?? 60000;
				const proxy = options.proxy ?? '';
				const geoip = options.geoip ?? false;
				sessionCleanup = options.sessionCleanup ?? 'close';
				const connectionEndpoint = applyCloakConnectionOptions(cdpEndpoint, {
					proxy,
					geoip,
				});

				// Validate CDP endpoint
				if (!cdpEndpoint) {
					throw new NodeOperationError(this.getNode(), 'CDP Endpoint URL is required', {
						itemIndex,
					});
				}

				// Connect to browser
				try {
					browser = await playwright.chromium.connectOverCDP(connectionEndpoint, {
						timeout: connectionTimeout,
					});
				} catch (connectError) {
					const message =
						connectError instanceof Error ? connectError.message : String(connectError);
					throw new NodeOperationError(
						this.getNode(),
						`Failed to connect to CDP endpoint: ${cdpEndpoint}\n\n` +
							`Error: ${message}\n\n` +
							`Please verify:\n` +
							`- Browser is running and accessible\n` +
							`- CDP endpoint URL is correct\n` +
							`- Port is not blocked by firewall`,
						{ itemIndex },
					);
				}

				// CloakBrowser's native human layer is designed for CDP-connected browsers.
				// It patches all existing pages/contexts and any pages created afterwards.
				if (emulateHuman) {
					const { patchBrowser, resolveConfig } = await loadNativeHumanModule();
					patchBrowser(browser, resolveConfig(humanPreset));
				}

				// Get browser context (use existing or create new). If no context exists,
				// patchBrowser has already wrapped browser.newContext() for us.
				const contexts = browser.contexts();
				const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

				// Create helpers
				const helpers = createHelpers(this, context);

				// Create $ function for accessing other nodes' data
				const $getNodeData = (nodeName: string) => {
					try {
						return this.evaluateExpression(
							`{{ $('${nodeName}') }}`,
							itemIndex,
						);
					} catch (err) {
						throw new NodeOperationError(
							this.getNode(),
							`Cannot access node "${nodeName}": ${err instanceof Error ? err.message : String(err)}`,
							{ itemIndex },
						);
					}
				};

				// Build sandbox with all available variables
				const allItems = items;
				const sandbox: ExecutionSandbox & { $humanized: boolean; $: typeof $getNodeData } = {
					$: $getNodeData,
					$playwright: playwright,
					$browser: browser,
					$context: context,
					$helpers: helpers,
					$input: {
						item: items[itemIndex],
						all: () => allItems,
						first: () => allItems[0],
						last: () => allItems[allItems.length - 1],
					},
					$json: (items[itemIndex].json || {}) as Record<string, unknown>,
					$binary: items[itemIndex].binary,
					$itemIndex: itemIndex,
					$node: {
						name: this.getNode().name,
						type: this.getNode().type,
					},
					$workflow: {
						id: this.getWorkflow().id,
						name: this.getWorkflow().name,
					},
					$env: process.env as Record<string, string | undefined>,
					$executionId: this.getExecutionId(),
					$runIndex: this.getNode().typeVersion,
					$humanized: emulateHuman,
				};

				// Execute user code
				const result = await executeUserCode(code, sandbox, executionTimeout);

				// Normalize and add results
				const normalizedResults = normalizeResult(result);
				for (const item of normalizedResults) {
					returnData.push({
						json: item.json,
						binary: item.binary,
						pairedItem: { item: itemIndex },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error instanceof Error ? error.message : String(error),
						},
						pairedItem: { item: itemIndex },
					});
				} else {
					if (error instanceof NodeOperationError) {
						throw error;
					}
					throw new NodeOperationError(this.getNode(), error as Error, {
						itemIndex,
					});
				}
			} finally {
				// Close the remote browser only when explicitly requested. Disconnecting
				// leaves Manager/CloakBrowser's profile and its open pages available to
				// later n8n nodes that connect to the same CDP endpoint.
				if (browser) {
					if (sessionCleanup === 'disconnect') {
						// Playwright's public Browser API does not expose disconnect() for
						// connectOverCDP. Closing the internal transport disconnects this
						// client without closing the remote Manager profile or its pages.
						const browserWithConnection = browser as playwright.Browser & {
							_connection?: { close?: () => void };
						};
						browserWithConnection._connection?.close?.();
					} else {
						await browser.close().catch(() => {
						// Ignore errors during cleanup
						});
					}
				}
			}
		}

		return [returnData];
	}
}
