// WP3: provider 어댑터 (회전형 refresh token)
//
// **실제 외부 호출은 하지 않는다.** 이번 범위는 인터페이스와 가짜 서버 왕복까지다.
// cafe24 는 몰 ID 미확인 · 앱 등록 전이라 주소도 자리표시자로 둔다.
//
// 공식 문서(R2 §1.1, 2026-09-16 확인): cafe24 는 갱신할 때마다 refresh token 이 함께 바뀌고
// 기존 것은 그 자리에서 만료된다 → 동시 갱신·응답 유실이 곧 토큰 분실이다.

export interface RefreshRequest {
  /** 지금 가지고 있는 refresh token 평문 (로그·오류에 절대 넣지 않는다) */
  refreshToken: string;
  accountRef: string;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  readonly name: string;
  /** 응답 **원문**을 돌려준다. 파싱 전에 그대로 암호화해 선기록하기 위해서다. */
  call(req: RefreshRequest): Promise<{ status: number; body: string }>;
  /** 원문 → 새 토큰. 해석할 수 없으면 null. */
  parse(body: string): ParsedToken | null;
}

export interface ParsedToken {
  refreshToken: string;
  /** refresh token 만료 시각 (있으면). 형식은 YYYY-MM-DDTHH:MM:SS.sssZ */
  expiresAt: string | null;
}

const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return ISO_MS_RE.test(iso) ? iso : null;
}

/**
 * cafe24 어댑터 (아직 켜지 않는다).
 * 주소·몰 ID 는 자리표시자다 — 실제 값은 앱 등록·최초 인증 뒤에 넣는다.
 */
export const cafe24Adapter: ProviderAdapter = {
  name: 'cafe24',
  async call(): Promise<{ status: number; body: string }> {
    // 실제 호출은 만들지 않는다. 몰 ID·앱 등록·최초 관리자 동의가 모두 끝난 뒤에 붙인다(G03).
    throw new Error('provider_not_configured');
  },
  parse(body: string): ParsedToken | null {
    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      return null;
    }
    if (typeof doc !== 'object' || doc === null) return null;
    const o = doc as Record<string, unknown>;
    const token = o.refresh_token;
    if (typeof token !== 'string' || token.length < 8) return null;
    return { refreshToken: token, expiresAt: normalizeIso(o.refresh_token_expires_at) };
  },
};

export const ADAPTERS: Record<string, ProviderAdapter> = { cafe24: cafe24Adapter };

export function adapterFor(provider: string): ProviderAdapter | null {
  return ADAPTERS[provider] ?? null;
}
