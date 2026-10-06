import { describe, expect, it } from 'vitest';
import { finalPay } from '../src/utils/money.js';

describe('authoritative final-pay rounding', () => {
  it.each([
    ['1000.00', '1000'],
    ['1000.01', '1000'],
    ['1000.49', '1000'],
    ['1000.50', '1001'],
    ['1000.51', '1001'],
    ['1000.99', '1001'],
    ['-1000.49', '-1000'],
    ['-1000.50', '-1001'],
  ])('%s becomes %s whole baht using HALF_UP', (input, expected) => {
    expect(finalPay(input).payableNet.toFixed(0)).toBe(expected);
  });

  it('retains the precise net and exposes the adjustment', () => {
    const result = finalPay('36648.42');
    expect(result.netPayBeforeRounding.toFixed(2)).toBe('36648.42');
    expect(result.roundingAdjustment.toFixed(2)).toBe('-0.42');
    expect(result.payableNet.toFixed(0)).toBe('36648');
  });
});
