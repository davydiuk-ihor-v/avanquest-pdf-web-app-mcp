import type { App } from '@modelcontextprotocol/ext-apps';

export type AppPlatform = 'desktop' | 'web' | 'mobile' | 'unknown';

/**
 * Detect the host platform using the official ext-apps SDK as primary source,
 * with a User-Agent heuristic as fallback for older hosts that omit `platform`.
 *
 * Call after `app.connect()` resolves — `getHostContext()` returns undefined before that.
 */
export function detectPlatform(app: App): AppPlatform {
  const ctx = (app as any).getHostContext?.();
  const p = ctx?.platform as string | undefined;
  if (p === 'desktop' || p === 'web' || p === 'mobile') return p;

  // Fallback: Claude Desktop runs inside Electron
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')) {
    return 'desktop';
  }

  return 'unknown';
}

export const isDesktop = (app: App): boolean => detectPlatform(app) === 'desktop';
export const isWeb     = (app: App): boolean => detectPlatform(app) === 'web';
export const isMobile  = (app: App): boolean => detectPlatform(app) === 'mobile';
