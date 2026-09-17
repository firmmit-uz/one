// Cloudflare Workers 진입점 타입 선언 (src/worker.mjs)
export interface ContractError {
  layer: 'parse' | 'raw' | 'schema' | 'semantic';
  rule: string;
  path: string;
  message: string;
  schemaPath?: string;
}

export interface ContractResult {
  ok: boolean;
  errors: ContractError[];
}

export interface ValidateOptions {
  /** 시험 전용: 규칙 ID → false 면 그 규칙을 끈다. 모르는 ID 는 예외. */
  unsafeTestRuleOverrides?: Record<string, boolean>;
}

/** 원문 JSON 텍스트 → 검증 결과 (원문 토큰 → 스키마 → 의미 순서, fail-closed) */
export function validateEnvelope(rawText: string, opts?: ValidateOptions): ContractResult;

/** 이미 파싱된 객체에 스키마만 적용 */
export function validateSchemaOnly(doc: unknown): ContractResult;

/** 사전 컴파일 검사기가 만들어진 스키마 파일의 SHA-256 */
export const SCHEMA_SHA256: string;
export const SCHEMA_ID: string | null;
export const RUNTIME_RULES: Readonly<Record<string, string>>;
