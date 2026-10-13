import { describe, expect, it } from 'vitest';
import { correctedViewportHeight } from './viewport';

const base = { screenWidth: 390, screenHeight: 844, viewportWidth: 390, layoutHeight: 797, keyboardOpen: false };

describe('the installed-app viewport correction', () => {
  it('leaves a browser tab alone', () => {
    expect(correctedViewportHeight({ ...base, visualHeight: 664, standalone: false })).toBe(664);
  });

  it('reaches the true screen edge in an installed app whose viewport stops short', () => {
    expect(correctedViewportHeight({ ...base, visualHeight: 797, standalone: true })).toBe(844);
  });

  it('uses the short side of the screen in landscape', () => {
    expect(correctedViewportHeight({ ...base, viewportWidth: 844, visualHeight: 369, layoutHeight: 369, standalone: true })).toBe(390);
  });

  it('never stretches over the keyboard or a large gap it cannot explain', () => {
    expect(correctedViewportHeight({ ...base, visualHeight: 508, standalone: true, keyboardOpen: true })).toBe(508);
    expect(correctedViewportHeight({ ...base, visualHeight: 500, standalone: true })).toBe(500);
    expect(correctedViewportHeight({ ...base, visualHeight: 844, standalone: true })).toBe(844);
  });
});
