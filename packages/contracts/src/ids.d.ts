// 공통 ID 검사기 타입 선언 (src/ids.mjs)
export type IdStatus = 'confirmed' | 'draft';

export interface IdTypeSpec {
  status: IdStatus;
  pattern: RegExp;
  label: string;
  issuer: string;
  examples: string[];
  source: string;
}

export const LEGAL_ENTITIES: readonly string[];
export const DOC_KINDS: readonly string[];
export const ID_TYPES: Readonly<Record<string, IdTypeSpec>>;
export const CONFIRMED_TYPES: readonly string[];
export const DRAFT_TYPES: readonly string[];

export interface IdCheck {
  ok: boolean;
  type: string;
  status?: IdStatus;
  reason?: 'unknown_type' | 'not_a_string' | 'surrounding_whitespace' | 'pattern_mismatch';
}

export function validateId(type: string, value: unknown): IdCheck;
export function isValidId(type: string, value: unknown): boolean;
export function detectIdType(value: unknown): string | null;
export function assertId(type: string, value: unknown): string;
