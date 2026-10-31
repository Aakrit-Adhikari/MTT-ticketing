import { csvCell, toCsv } from './csv';

describe('CSV writer', () => {
  it('quotes fields and doubles embedded quotes', () => {
    expect(csvCell('He said "hi", ok')).toBe('"He said ""hi"", ok"');
    expect(csvCell(null)).toBe('""');
  });

  it('neutralises spreadsheet formula injection in customer-controlled values', () => {
    for (const evil of ['=HYPERLINK("http://evil","x")', '+cmd|calc', '@SUM(1)', '-2+3', '\t=1+1']) {
      expect(csvCell(evil).startsWith(`"'`)).toBe(true);
    }
  });

  it('leaves genuine numbers (including negatives) alone', () => {
    expect(csvCell('-250.00')).toBe('"-250.00"');
    expect(csvCell('4200.50')).toBe('"4200.50"');
  });

  it('writes a BOM, a header row and CRLF line endings', () => {
    const csv = toCsv([{ header: 'Name', value: (r: { n: string }) => r.n }], [{ n: 'Sita' }, { n: '=1+1' }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('"Name"\r\n"Sita"\r\n"\'=1+1"\r\n');
  });
});
