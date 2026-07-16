import type { Page, Browser, BrowserContext, Route, Request } from 'playwright-core';
import type { INodeExecutionData, IBinaryData } from 'n8n-workflow';

/**
 * Options for screenshot helper
 */
export interface ScreenshotOptions {
	fullPage?: boolean;
	type?: 'png' | 'jpeg';
	quality?: number;
	clip?: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	omitBackground?: boolean;
	binaryPropertyName?: string;
}

/**
 * Options for PDF helper
 */
export interface PdfOptions {
	format?: 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid';
	landscape?: boolean;
	printBackground?: boolean;
	scale?: number;
	margin?: {
		top?: string;
		bottom?: string;
		left?: string;
		right?: string;
	};
	pageRanges?: string;
	headerTemplate?: string;
	footerTemplate?: string;
	binaryPropertyName?: string;
}

/**
 * Options for download helper
 */
export interface DownloadOptions {
	clickSelector?: string;
	headers?: Record<string, string>;
	timeout?: number;
	binaryPropertyName?: string;
}

/**
 * File data for upload helper
 */
export interface UploadFileData {
	name: string;
	mimeType: string;
	buffer: Buffer;
}

/**
 * Options for upload helper
 */
export interface UploadOptions {
	/** Selector for input[type="file"] element */
	selector?: string;
	/** Click selector to trigger file chooser (for non-input uploads) */
	clickSelector?: string;
	/** Timeout for file chooser to appear (default: 30000) */
	timeout?: number;
}

/**
 * Helper functions available in user code as $helpers
 */
export interface PlaywrightHelpers {
	screenshot(page: Page, options?: ScreenshotOptions): Promise<IBinaryData>;
	pdf(page: Page, options?: PdfOptions): Promise<IBinaryData>;
	download(source: Page | string, options?: DownloadOptions): Promise<IBinaryData>;
	binaryToFile(binaryPropertyName: string, itemIndex?: number): Promise<UploadFileData>;
	upload(page: Page, files: UploadFileData | UploadFileData[], options: UploadOptions): Promise<void>;
	interceptRequests(
		page: Page,
		urlPattern: string | RegExp,
		handler: (route: Route, request: Request) => Promise<void> | void,
	): Promise<void>;
	snapshot(page: Page): Promise<string>;
}

/**
 * Sandbox context for user code execution
 */
export interface ExecutionSandbox {
	$playwright: typeof import('playwright-core');
	$browser: Browser;
	$context: BrowserContext;
	$helpers: PlaywrightHelpers;
	$input: {
		item: INodeExecutionData;
		all: () => INodeExecutionData[];
		first: () => INodeExecutionData;
		last: () => INodeExecutionData;
	};
	$json: Record<string, unknown>;
	$binary: Record<string, IBinaryData> | undefined;
	$itemIndex: number;
	$node: Record<string, unknown>;
	$workflow: Record<string, unknown>;
	$env: Record<string, string | undefined>;
	$executionId: string;
	$runIndex: number;
}

/**
 * Possible return types from user code
 */
export type UserCodeResult =
	| Record<string, unknown>
	| { json?: Record<string, unknown>; binary?: Record<string, IBinaryData> }
	| Array<{ json?: Record<string, unknown>; binary?: Record<string, IBinaryData> }>;

/**
 * Node parameters
 */
export interface NodeParameters {
	cdpEndpoint: string;
	code: string;
	connectionTimeout: number;
	executionTimeout: number;
}
