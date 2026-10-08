declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
export const DEFAULT_ORIGIN = 'https://app.jotbus.com';
export const DEFAULT_URL = `${DEFAULT_ORIGIN}/mcp`;
