// WP3: 토큰 암호화 (WebCrypto AES-GCM)
//
// 평문 토큰은 D1·로그·오류 메시지에 절대 남기지 않는다.
// 키는 Worker Secret 으로만 넣는다(설정 파일·저장소에 두지 않는다).
import type { Env } from '../env';

export const KEY_VERSION = 1;
/** 키를 넣는 Worker Secret 이름. 키를 바꾸면 V2 를 더하고 key_version 을 올린다. */
export const KEY_SECRET_NAME = 'TOKEN_KEY_V1';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 권장 길이
const PLACEHOLDER_RE = /^<.*>$/;

export interface Sealed {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyVersion: number;
}

function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Secret 에서 키 원본을 꺼낸다. 없거나 자리표시자·길이가 다르면 null (fail-closed). */
export function keyMaterial(env: Env): Uint8Array | null {
  const raw = env.TOKEN_KEY_V1; // = KEY_SECRET_NAME
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length === 0 || PLACEHOLDER_RE.test(t)) return null;
  const bytes = fromBase64(t);
  if (bytes === null || bytes.byteLength !== KEY_BYTES) return null;
  return bytes;
}

export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 설정된 키를 가져온다. 키가 없으면 null → 갱신을 실행하지 않는다. */
export async function loadKey(env: Env): Promise<CryptoKey | null> {
  const raw = keyMaterial(env);
  return raw === null ? null : importKey(raw);
}

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: new Uint8Array(buf), iv, keyVersion: KEY_VERSION };
}

/** 풀기 실패는 예외 대신 null (오류 메시지로 내용이 새지 않게 한다). */
export async function open(key: CryptoKey, sealed: { ciphertext: Uint8Array; iv: Uint8Array }): Promise<string | null> {
  try {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv as unknown as BufferSource },
      key,
      sealed.ciphertext as unknown as BufferSource,
    );
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

/** D1 에서 읽은 값을 Uint8Array 로 (환경에 따라 ArrayBuffer 로 올 수 있다) */
export function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return Uint8Array.from(v as number[]);
  return null;
}
