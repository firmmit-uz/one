// 수동 입력 검증 (fail-closed: 모르는 필드·잘못된 타입·빈 값 거부)
import { ROLES, type Role } from './env';

export class ValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly field: string,
  ) {
    super(`${code}: ${field}`);
    this.name = 'ValidationError';
  }
}

export type Validator<T> = (value: unknown, field: string) => T;

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
/** 제어문자(탭·개행 포함)는 어떤 입력에도 넣지 않는다. cctv.ts 도 이 규칙을 쓴다. */
export const CONTROL_RE = /[\x00-\x1f\x7f]/;

export function str(opts: { min?: number; max: number; pattern?: RegExp }): Validator<string> {
  return (v, field) => {
    if (typeof v !== 'string') throw new ValidationError('invalid_type', field);
    const t = v.trim();
    if (t.length === 0) throw new ValidationError('empty_value', field);
    if (t.length < (opts.min ?? 1) || t.length > opts.max) throw new ValidationError('invalid_length', field);
    // 제어문자 거부
    if (CONTROL_RE.test(t)) throw new ValidationError('invalid_characters', field);
    if (opts.pattern && !opts.pattern.test(t)) throw new ValidationError('invalid_format', field);
    return t;
  };
}

export const email: Validator<string> = (v, field) => {
  if (typeof v !== 'string') throw new ValidationError('invalid_type', field);
  if (v.trim().length === 0) throw new ValidationError('empty_value', field);
  if (v !== v.trim() || v.length > 254 || !EMAIL_RE.test(v)) throw new ValidationError('invalid_email', field);
  return v.toLowerCase();
};

export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

/** 정수 범위. 문자열·소수·범위 밖은 거부한다 (null ≠ 0 원칙과 같은 결). */
export function int(opts: { min: number; max: number }): Validator<number> {
  return (v, field) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < opts.min || v > opts.max) { // MUTATION:INT-RANGE
      throw new ValidationError('invalid_value', field);
    }
    return v;
  };
}

export const bool: Validator<boolean> = (v, field) => {
  if (v !== true && v !== false) throw new ValidationError('invalid_type', field);
  return v;
};

export function oneOf<T extends string>(values: readonly T[]): Validator<T> {
  return (v, field) => {
    if (typeof v !== 'string') throw new ValidationError('invalid_type', field);
    if (!(values as readonly string[]).includes(v)) throw new ValidationError('invalid_value', field);
    return v as T;
  };
}

export const role: Validator<Role> = oneOf(ROLES);

// 미래 시각만 허용하는 ISO-8601 UTC
export function futureIsoUtc(now: () => Date): Validator<string> {
  return (v, field) => {
    if (typeof v !== 'string') throw new ValidationError('invalid_type', field);
    if (!ISO_UTC_RE.test(v)) throw new ValidationError('invalid_datetime', field);
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw new ValidationError('invalid_datetime', field);
    const d = new Date(ms);
    // 2026-02-30 같은 값 거부 (왕복 비교)
    if (d.toISOString().slice(0, 19) !== v.slice(0, 19)) throw new ValidationError('invalid_datetime', field);
    if (ms <= now().getTime()) throw new ValidationError('not_in_future', field);
    return d.toISOString();
  };
}

export function arrayOf<T>(item: Validator<T>, opts: { min?: number; max: number; unique?: boolean }): Validator<T[]> {
  return (v, field) => {
    if (!Array.isArray(v)) throw new ValidationError('invalid_type', field);
    if (v.length < (opts.min ?? 0) || v.length > opts.max) throw new ValidationError('invalid_length', field);
    const out = v.map((x, i) => item(x, `${field}[${i}]`));
    if (opts.unique && new Set(out.map((x) => JSON.stringify(x))).size !== out.length) {
      throw new ValidationError('duplicate_value', field);
    }
    return out;
  };
}

type Spec = { v: Validator<unknown>; optional?: boolean; nullable?: boolean };
type FieldSpec = Record<string, Spec>;
type Out<S extends Spec> = (S['v'] extends Validator<infer T> ? T : never) | (S['nullable'] extends true ? null : never);
type Parsed<S extends FieldSpec> = {
  [K in keyof S]: S[K]['optional'] extends true ? Out<S[K]> | undefined : Out<S[K]>;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function objectOf<S extends FieldSpec>(spec: S): Validator<Parsed<S>> {
  return (v, field) => {
    if (!isPlainObject(v)) throw new ValidationError('invalid_type', field || 'body');
    for (const k of Object.keys(v)) {
      if (!Object.prototype.hasOwnProperty.call(spec, k)) {
        throw new ValidationError('unknown_field', field ? `${field}.${k}` : k);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(spec)) {
      const name = field ? `${field}.${k}` : k;
      if (!Object.prototype.hasOwnProperty.call(v, k)) {
        if (s.optional) continue;
        throw new ValidationError('missing_field', name);
      }
      const val = v[k];
      if (val === null) {
        if (s.nullable) {
          out[k] = null;
          continue;
        }
        throw new ValidationError('null_not_allowed', name);
      }
      out[k] = s.v(val, name);
    }
    return out as Parsed<S>;
  };
}

// 요청 본문 JSON 파싱 (크기 제한)
export const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req: Request): Promise<unknown> {
  const len = req.headers.get('content-length');
  if (len !== null && (!/^\d+$/.test(len) || Number(len) > MAX_BODY_BYTES)) {
    throw new ValidationError('body_too_large', 'body');
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new ValidationError('body_too_large', 'body');
  if (text.trim().length === 0) throw new ValidationError('empty_body', 'body');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError('invalid_json', 'body');
  }
}
