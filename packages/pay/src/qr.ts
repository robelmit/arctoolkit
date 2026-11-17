/** A payment link as a QR code, in SVG, for a checkout page or a printed till card. */

import { renderSVG } from 'uqr';

export function qrSvg(text: string): string {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2_000) throw new Error('a QR code holds 1 to 2,000 characters here');
  // A quiet border of four modules, as scanners expect; medium error correction survives a scuffed print.
  return renderSVG(text, { border: 4, ecc: 'M' });
}
