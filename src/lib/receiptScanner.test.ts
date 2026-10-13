import { describe, expect, it } from 'vitest';
import { parseReceiptText } from './receiptScanner';

const day = (d?: Date) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;

/*
 * Regression receipts: OCR text from the receipt bench (sample receipts read by
 * Florence-2, misreads kept as they came out), trimmed to the lines that matter.
 * Personal names have been removed.
 */
const ACME = `Acme Point of Sale
Built for specialty retail.
Total Businessllare Inc.
Date/Tine 01/26/2018 04:32:46 PM
6033610000025 Stapler -Medium hand held  6.50
SUBTOTAL  54.98
Sales Tax (6.53)  3.31
TOTAL  58.29
EBT Fodd Stamp (SNAP)  4.06
Cash  50.00
Account Saved  3.55
Total Savings  3.555
Number Of Items 25`;

const DINEFINE = `DINEFINE
RESTAURANT
30/09/2025 20:15
2X CAESAR SALAD  $24.00
GRILLED SALMON  $22.00
SUBTOTAL :  $47.50
TAX:  $3.80
TOTAL:  $51.30
TIME:  INVALID DATE`;

const CIDER = `Cider ceLLar
SALES RECEIPT
4 Bulmen Original Bottle  E4.00
1x Bulmers Pear Bottle  E4,00
Sub Total:  E8.00
Line Discount:  -E3.00
Transaction Discount:  -E0.50
Discount Total:  -E2.50
Total:  £4.50
Cash  £5.00
Tendered Total:  E5.00
Change:  E5.50  E0.50
THANK YOU
22285 24/09/2018 14:30  Admin`;

const WALMART = `Walmart
Save money. Live better.
BREAD  007225003712 F  2.88 N
FOLGERS  00876422682 F  10.48
SUBTOTAL  46.04
TAX 1  7.000 %  0.26
TOTAL  46.30
DEBIT TEND  16.30
CHANGE DUE  0.00
46. 30 TOTAL PURCHASE
PAYMENT DECLINED DEBIT NOT AVAILABLE
11/06/11  02:21:54
6.30 TOTAL PURchASE
11/05/11  02:22:54`;

const HOTEL = `123 Main Street
Date: 11/24/2025 | Time: 10:22 PM
Room Rate  $149,00
Room Service  $32,50
Subtotal  $181,50
Tax  $15,43
Total  $196,93
Payment  Amex`;

const COSTCO = `COSTCO
WHOLESALE
09/18/2026 09:41
SAMPLE-C1 PAPER TOWELS / 6  $18.50
Subtotal  $40.50
Tax (8.25%)  $3.34
TOTAL USD  $43.84`;

describe('parseReceiptText: totals', () => {
  it('takes TOTAL, not "Total Savings" further down', () => {
    expect(parseReceiptText(ACME).amount).toBe(58.29);
  });

  it('takes Total, not "Tendered Total" or "Discount Total"', () => {
    expect(parseReceiptText(CIDER).amount).toBe(4.5);
  });

  it('takes TOTAL, not a later "TOTAL PURCHASE" payment line', () => {
    expect(parseReceiptText(WALMART).amount).toBe(46.3);
  });

  it('reads a comma as the decimal point', () => {
    expect(parseReceiptText(HOTEL).amount).toBe(196.93);
  });

  it('ignores a currency code on the total line', () => {
    expect(parseReceiptText(COSTCO).amount).toBe(43.84);
  });

  it('still prefers a strong keyword such as "amount due"', () => {
    expect(parseReceiptText('Subtotal 10.00\nTotal 10.80\nAmount Due 12.80').amount).toBe(12.8);
  });

  it('keeps thousands separators working', () => {
    expect(parseReceiptText('TOTAL $1,234.56').amount).toBe(1234.56);
    expect(parseReceiptText('TOTAL 1.234,56 €').amount).toBe(1234.56);
  });

  it('keeps the regular case working', () => {
    expect(parseReceiptText(DINEFINE).amount).toBe(51.3);
  });
});

describe('parseReceiptText: line items', () => {
  const items = (text: string) => parseReceiptText(text).lineItems?.map((i) => [i.description, i.amount]);

  it('strips barcodes, PLU codes and quantity columns from names', () => {
    const got = items(`6033610000025 Stapler -Medium hand held  6.50
076711003531 Binder Econ 3 Ring 1/2"B1  12  33.48
3115  Peaches  3  0.95
SUBTOTAL  54.98`);
    expect(got).toEqual([
      ['Stapler -Medium Hand Held', 6.5],
      ['Binder Econ 3 Ring 1/2"B1', 33.48],
      ['Peaches', 0.95],
    ]);
  });

  it('reads prices followed by a tax flag, and drops the flag from the name', () => {
    expect(items(`BREAD  007225003712 F  2.88 N
FOLGERS  00876422682 F  10.48
SUBTOTAL  46.04`)).toEqual([
      ['Bread', 2.88],
      ['Folgers', 10.48],
    ]);
  });

  it('reads £, € and comma-decimal prices', () => {
    expect(items(`1x Bulmers Pear Bottle  £4.00
Wine  €12,50
Room Rate  $149,00
Total  $165.50`)).toEqual([
      ['Bulmers Pear Bottle', 4],
      ['Wine', 12.5],
      ['Room Rate', 149],
    ]);
  });

  it('reads OCR\'s "E" for £ and skips discount lines', () => {
    expect(items(`4 Bulmen Original Bottle  E4.00
Line Discount:  -E3.00
Sub Total:  E8.00`)).toEqual([['Bulmen Original Bottle', 4]]);
  });

  it('stops at the totals, so payment and savings lines are not items', () => {
    expect(items(ACME)).toEqual([['Stapler -Medium Hand Held', 6.5]]);
  });

  it('still reads every line on a receipt with no total printed', () => {
    expect(items(`Cold Beverage  2.80
Lunch Salmon  14.50
Dessert Rosa  7.20`)).toEqual([
      ['Cold Beverage', 2.8],
      ['Lunch Salmon', 14.5],
      ['Dessert Rosa', 7.2],
    ]);
  });
});

describe('parseReceiptText: dates', () => {
  it('reads day-first dates when the day is over 12', () => {
    expect(day(parseReceiptText(DINEFINE).date)).toBe('2025-09-30');
    expect(day(parseReceiptText(CIDER).date)).toBe('2018-09-24');
  });

  it('keeps US month-first dates', () => {
    expect(day(parseReceiptText(ACME).date)).toBe('2018-01-26');
    expect(day(parseReceiptText(HOTEL).date)).toBe('2025-11-24');
    expect(day(parseReceiptText(WALMART).date)).toBe('2011-11-06');
  });

  it('settles ambiguous dates by currency: £ or € means day first', () => {
    expect(day(parseReceiptText('Total £5.00\n05/09/2026').date)).toBe('2026-09-05');
    expect(day(parseReceiptText('Total $5.00\n05/09/2026').date)).toBe('2026-05-09');
  });

  it('falls back to the given preference when nothing else decides', () => {
    expect(day(parseReceiptText('05/09/2026', { dayFirst: true }).date)).toBe('2026-09-05');
    expect(day(parseReceiptText('05/09/2026', { dayFirst: false }).date)).toBe('2026-05-09');
  });

  it('reads dotted European dates day first', () => {
    expect(day(parseReceiptText('Data 05.09.2026').date)).toBe('2026-09-05');
  });
});

describe('parseReceiptText: total candidates', () => {
  const picks = (text: string) => parseReceiptText(text).totalCandidates?.map((c) => [c.amount, c.label]);

  it('puts the chosen total first, then subtotal, and leaves out payment lines', () => {
    expect(picks(WALMART)).toEqual([
      [46.3, 'Total'],
      [46.04, 'Subtotal'],
    ]);
  });

  it('skips savings and tendered lines but keeps the subtotal', () => {
    expect(picks(CIDER)).toEqual([
      [4.5, 'Total'],
      [8, 'Subtotal'],
    ]);
    expect(picks(ACME)).toEqual([
      [58.29, 'Total'],
      [54.98, 'Subtotal'],
    ]);
  });

  it('adds the largest amount when it is not already a candidate', () => {
    expect(picks('Coffee 3.50\nCake 12.00\nSubtotal 15.50\nTax 1.24\nAmount due 16.74\nCash 20.00')).toEqual([
      [16.74, 'Amount due'],
      [15.5, 'Subtotal'],
      [20, 'Largest amount'],
    ]);
  });

  it('labels a receipt with no total line by its largest amount', () => {
    expect(picks('Cold Beverage  2.80\nLunch Salmon  14.50')).toEqual([[14.5, 'Total']]);
  });
});

describe('parseReceiptText: currency', () => {
  it('reads a currency from symbols or codes', () => {
    expect(parseReceiptText(CIDER).currency).toBe('GBP');
    expect(parseReceiptText('Wine  €12,50\nTotal  €12,50').currency).toBe('EUR');
    expect(parseReceiptText(COSTCO).currency).toBe('USD'); // "TOTAL USD"
  });

  it('says nothing for a plain dollar sign', () => {
    expect(parseReceiptText(DINEFINE).currency).toBeUndefined();
  });
});
