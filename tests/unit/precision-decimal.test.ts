import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decimalToScaledIntExact,
  decoderPriceDigitsFromMultiplierRaw,
  normalizedDecimalKey,
  powerOfTenDigits,
  requiredDecimalPlaces,
  scaledDeltaMinimum,
} from '../../src/precision/decimal.js';

test('decoder multiplier contract matches decimal and exponent forms', () => {
  assert.deepEqual(decoderPriceDigitsFromMultiplierRaw('0.00001'), {
    multiplierNumberString: '0.00001',
    priceDigits: 5,
    priceScale: 100000,
  });
  assert.deepEqual(decoderPriceDigitsFromMultiplierRaw('1e-7'), {
    multiplierNumberString: '1e-7',
    priceDigits: 7,
    priceScale: 10000000,
  });
  assert.deepEqual(decoderPriceDigitsFromMultiplierRaw('0.001'), {
    multiplierNumberString: '0.001',
    priceDigits: 3,
    priceScale: 1000,
  });
});

test('decimalToScaledIntExact never silently rounds', () => {
  assert.equal(decimalToScaledIntExact('1.23456', 100000), 123456n);
  assert.equal(decimalToScaledIntExact('1.234560', 100000), 123456n);
  assert.equal(decimalToScaledIntExact('1.234561', 100000), null);
  assert.equal(decimalToScaledIntExact('2345.67', 100), 234567n);
  assert.equal(decimalToScaledIntExact('2.34567e3', 100), 234567n);
  assert.equal(decimalToScaledIntExact('-0.01', 100), -1n);
});

test('decimal normalization is lexical-form independent', () => {
  assert.equal(normalizedDecimalKey('1.2300'), normalizedDecimalKey('1.23'));
  assert.equal(normalizedDecimalKey('123e-2'), normalizedDecimalKey('1.23'));
  assert.equal(requiredDecimalPlaces('1.2300'), 2);
  assert.equal(requiredDecimalPlaces('1e-5'), 5);
});

test('price scale must be decimal power of ten', () => {
  assert.equal(powerOfTenDigits(1), 0);
  assert.equal(powerOfTenDigits(100000), 5);
  assert.throws(() => powerOfTenDigits(25));
});

test('scaled delta minimum ignores flats', () => {
  assert.equal(scaledDeltaMinimum([100n, 100n, 103n, 101n, 101n]), 2n);
  assert.equal(scaledDeltaMinimum([100n, 100n]), null);
});
