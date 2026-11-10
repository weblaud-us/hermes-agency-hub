/**
 * A QR-shaped placeholder for sample mode: three finder patterns, timing lines and
 * a fixed scatter of modules. It has the look of a code and none of the content, so
 * a phone cannot read it as a real link. The screen marks it as a sample as well.
 */
const SIZE = 29;

export function sampleQrMatrix(): string[] {
  const grid: boolean[][] = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  const reserved: boolean[][] = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));

  const finder = (left: number, top: number) => {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const px = left + x;
        const py = top + y;
        if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        grid[py][px] = ring !== 2 && ring !== 4;
        reserved[py][px] = true;
      }
    }
  };
  finder(0, 0);
  finder(SIZE - 7, 0);
  finder(0, SIZE - 7);

  for (let i = 8; i < SIZE - 8; i += 1) {
    grid[6][i] = i % 2 === 0;
    reserved[6][i] = true;
    grid[i][6] = i % 2 === 0;
    reserved[i][6] = true;
  }

  // A fixed linear congruential sequence, so the pattern is the same on every render.
  let seed = 20240611;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (reserved[y][x]) continue;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      grid[y][x] = (seed >> 16) % 2 === 0;
    }
  }
  return grid.map((row) => row.map((on) => (on ? "1" : "0")).join(""));
}
