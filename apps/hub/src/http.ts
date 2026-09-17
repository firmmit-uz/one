import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// 보안 헤더 (public/_headers 와 같은 값 유지)
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function jsonError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json(errorBody(code, message), status);
}

// 오류 메시지에 특정 문구가 있는지 (D1 은 원인 문구를 message 에 포함)
export function errorIncludes(err: unknown, needle: string): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur instanceof Error) {
      if (cur.message.includes(needle)) return true;
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      return String(cur).includes(needle);
    }
  }
  return false;
}
