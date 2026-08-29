export interface DecimalParts {
  coefficient: bigint;
  exponent10: number;
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export function parseDecimalExact(input: string): DecimalParts {
  const value = input.trim();
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid decimal literal: ${input}`);

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2]!;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? '0');
  if (!Number.isSafeInteger(exponent)) throw new Error(`Unsafe decimal exponent: ${input}`);

  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const coefficient = sign * BigInt(digits || '0');
  return { coefficient, exponent10: exponent - fraction.length };
}

function pow10BigInt(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new Error(`Invalid power-of-ten exponent: ${exponent}`);
  return 10n ** BigInt(exponent);
}

export function powerOfTenDigits(scale: number): number {
  if (!Number.isSafeInteger(scale) || scale < 1) throw new Error(`price_scale must be a positive safe integer: ${scale}`);
  let remaining = scale;
  let digits = 0;
  while (remaining > 1 && remaining % 10 === 0) {
    remaining /= 10;
    digits += 1;
  }
  if (remaining !== 1) throw new Error(`price_scale must be a power of ten: ${scale}`);
  return digits;
}

export function decimalToScaledIntExact(input: string, priceScale: number): bigint | null {
  const scaleDigits = powerOfTenDigits(priceScale);
  const { coefficient, exponent10 } = parseDecimalExact(input);
  const adjustedExponent = exponent10 + scaleDigits;
  if (adjustedExponent >= 0) return coefficient * pow10BigInt(adjustedExponent);

  const divisor = pow10BigInt(-adjustedExponent);
  if (coefficient % divisor !== 0n) return null;
  return coefficient / divisor;
}

export function normalizedDecimalKey(input: string): string {
  let { coefficient, exponent10 } = parseDecimalExact(input);
  if (coefficient === 0n) return '0e0';
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent10 += 1;
  }
  return `${coefficient.toString()}e${exponent10}`;
}

export function requiredDecimalPlaces(input: string): number {
  let { coefficient, exponent10 } = parseDecimalExact(input);
  if (coefficient === 0n) return 0;
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent10 += 1;
  }
  return Math.max(0, -exponent10);
}

/**
 * Mirrors dukascopy-node v1.50.0 getPriceScale(multiplier): the library first
 * parses JSON into a Number, then uses Number#toString to derive the formatted
 * decimal scale. This function deliberately reproduces that decoder contract.
 */
export function decoderPriceDigitsFromMultiplierRaw(multiplierRaw: string): {
  multiplierNumberString: string;
  priceDigits: number;
  priceScale: number;
} {
  const multiplier = Number(multiplierRaw);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`Invalid upstream multiplier: ${multiplierRaw}`);
  }

  const numberString = multiplier.toString().toLowerCase();
  const [coefficient, exponentText = '0'] = numberString.split('e');
  const decimalPlaces = coefficient!.split('.')[1]?.length ?? 0;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) throw new Error(`Invalid multiplier exponent: ${numberString}`);
  const priceDigits = Math.max(0, decimalPlaces - exponent);
  const priceScale = 10 ** priceDigits;
  if (!Number.isSafeInteger(priceScale)) {
    throw new Error(`Derived price_scale is not a safe integer: ${priceScale}`);
  }
  return { multiplierNumberString: numberString, priceDigits, priceScale };
}

export function scaledDeltaMinimum(values: bigint[]): bigint | null {
  let minimum: bigint | null = null;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i]! >= values[i - 1]! ? values[i]! - values[i - 1]! : values[i - 1]! - values[i]!;
    if (delta > 0n && (minimum === null || delta < minimum)) minimum = delta;
  }
  return minimum;
}
