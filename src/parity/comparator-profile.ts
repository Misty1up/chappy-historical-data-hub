import { phase6JsonSha256 } from './trace-contract.js';
import type { Phase6ParityLayer } from './trace-contract.js';

export const PHASE6_COMPARATOR_PROFILE_SCHEMA_VERSION = 'HDH_P6_COMPARATOR_PROFILE_V1' as const;
export type Phase6ComparatorType = 'EXACT' | 'ABSOLUTE' | 'RELATIVE' | 'ABS_OR_REL';

export interface Phase6ComparatorRule {
  layer: Phase6ParityLayer;
  field_path: string;
  comparator: Phase6ComparatorType;
  abs_tolerance?: number;
  rel_tolerance?: number;
  units?: string;
  rationale?: string;
}

export interface Phase6ComparatorProfile {
  comparator_profile_schema_version: typeof PHASE6_COMPARATOR_PROFILE_SCHEMA_VERSION;
  comparator_profile_id: string;
  comparator_profile_sha256: string;
  rules: Phase6ComparatorRule[];
}

export class Phase6ComparatorProfileError extends Error {
  constructor(public readonly code: 'P6_COMPARATOR_PROFILE_INVALID', message: string) {
    super(message);
    this.name = 'Phase6ComparatorProfileError';
  }
}

const EXACT_AUTHORITY_FIELD_NAMES = new Set([
  'dataset_id', 'source_hash_root', 'canonical_logical_hash_root', 'parquet_file_hash_root', 'mt5_derivative_hash_root',
  'tick_count', 'tick_count_total', 'timestamp_msc', 'canonical_ordinal', 'source_seq', 'price_digits', 'price_scale',
  'bid_scaled', 'ask_scaled',
]);

function profileError(message: string): never {
  throw new Phase6ComparatorProfileError('P6_COMPARATOR_PROFILE_INVALID', message);
}

function isAuthorityPath(fieldPath: string): boolean {
  const segments = fieldPath.replaceAll('[', '.').replaceAll(']', '').split('.').filter(Boolean);
  return segments.some(segment => EXACT_AUTHORITY_FIELD_NAMES.has(segment) || segment.endsWith('_id'));
}

function validateRule(rule: Phase6ComparatorRule, index: number): void {
  if (!['INPUT', 'INDICATOR_FEATURE', 'SIGNAL', 'EXECUTION', 'RESULT'].includes(rule.layer)) profileError(`rules[${index}].layer is invalid`);
  if (typeof rule.field_path !== 'string' || !rule.field_path.startsWith('fields.') || rule.field_path.length <= 'fields.'.length) {
    profileError(`rules[${index}].field_path must target one explicit fields.* path`);
  }
  if (rule.field_path.includes('*')) profileError(`rules[${index}].field_path must not use wildcard/global tolerance`);
  if (!['EXACT', 'ABSOLUTE', 'RELATIVE', 'ABS_OR_REL'].includes(rule.comparator)) profileError(`rules[${index}].comparator is invalid`);
  for (const [name, value] of [['abs_tolerance', rule.abs_tolerance], ['rel_tolerance', rule.rel_tolerance]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) profileError(`rules[${index}].${name} must be finite and non-negative`);
  }
  if (rule.comparator === 'EXACT') {
    if (rule.abs_tolerance !== undefined || rule.rel_tolerance !== undefined) profileError(`rules[${index}] EXACT must not declare tolerance`);
    return;
  }
  if (rule.layer !== 'INDICATOR_FEATURE' && rule.layer !== 'RESULT') {
    profileError(`rules[${index}] tolerance is restricted to derived INDICATOR_FEATURE or RESULT fields`);
  }
  if (isAuthorityPath(rule.field_path)) profileError(`rules[${index}] cannot make an authority/identity field tolerant`);
  if (typeof rule.units !== 'string' || rule.units.length === 0) profileError(`rules[${index}] tolerant comparator requires units`);
  if (typeof rule.rationale !== 'string' || rule.rationale.length === 0) profileError(`rules[${index}] tolerant comparator requires rationale`);
  if (rule.comparator === 'ABSOLUTE' && rule.abs_tolerance === undefined) profileError(`rules[${index}] ABSOLUTE requires abs_tolerance`);
  if (rule.comparator === 'RELATIVE' && rule.rel_tolerance === undefined) profileError(`rules[${index}] RELATIVE requires rel_tolerance`);
  if (rule.comparator === 'ABS_OR_REL' && rule.abs_tolerance === undefined && rule.rel_tolerance === undefined) {
    profileError(`rules[${index}] ABS_OR_REL requires abs_tolerance and/or rel_tolerance`);
  }
}

function normalizedRules(rules: readonly Phase6ComparatorRule[]): Phase6ComparatorRule[] {
  return rules.map(rule => ({ ...rule })).sort((a, b) => a.layer.localeCompare(b.layer) || a.field_path.localeCompare(b.field_path));
}

function profileHashInput(profileId: string, rules: readonly Phase6ComparatorRule[]) {
  return {
    comparator_profile_schema_version: PHASE6_COMPARATOR_PROFILE_SCHEMA_VERSION,
    comparator_profile_id: profileId,
    rules: normalizedRules(rules),
  };
}

export function createPhase6ComparatorProfile(profileId: string, rules: readonly Phase6ComparatorRule[]): Phase6ComparatorProfile {
  if (typeof profileId !== 'string' || profileId.length === 0) profileError('comparator_profile_id must be non-empty');
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    validateRule(rule, index);
    const key = `${rule.layer}:${rule.field_path}`;
    if (seen.has(key)) profileError(`duplicate comparator rule ${key}`);
    seen.add(key);
  });
  const normalized = normalizedRules(rules);
  return {
    comparator_profile_schema_version: PHASE6_COMPARATOR_PROFILE_SCHEMA_VERSION,
    comparator_profile_id: profileId,
    comparator_profile_sha256: phase6JsonSha256(profileHashInput(profileId, normalized)),
    rules: normalized,
  };
}

export function validatePhase6ComparatorProfile(profile: Phase6ComparatorProfile): void {
  if (profile.comparator_profile_schema_version !== PHASE6_COMPARATOR_PROFILE_SCHEMA_VERSION) profileError('comparator_profile_schema_version is unsupported');
  const expected = createPhase6ComparatorProfile(profile.comparator_profile_id, profile.rules);
  if (expected.comparator_profile_sha256 !== profile.comparator_profile_sha256) profileError('comparator_profile_sha256 does not match profile contents');
}

export function findPhase6ComparatorRule(
  profile: Phase6ComparatorProfile,
  layer: Phase6ParityLayer,
  fieldPath: string,
): Phase6ComparatorRule {
  return profile.rules.find(rule => rule.layer === layer && rule.field_path === fieldPath) ?? {
    layer,
    field_path: fieldPath,
    comparator: 'EXACT',
  };
}
