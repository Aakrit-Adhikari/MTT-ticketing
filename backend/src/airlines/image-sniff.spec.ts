import { sniffImage } from './image-sniff';

const pad = (head: number[] | string) => Buffer.concat([Buffer.from(head as never), Buffer.alloc(16)]);

describe('sniffImage', () => {
  it('recognises common image formats from their bytes', () => {
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(pad('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]))).toBe('image/webp');
    expect(sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)]))).toBe('image/avif');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
  });

  it('rejects everything else, whatever the file is called', () => {
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('MZ' + 'x'.repeat(40)))).toBeNull();
    expect(sniffImage(Buffer.alloc(4))).toBeNull();
  });
});
