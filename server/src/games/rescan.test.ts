import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ps3FoldersAsGames, romSignature } from './games.js';

describe('games rescan', () => {
  it('notices an added game', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roms-'));
    fs.mkdirSync(path.join(root, 'gba'));
    const a = romSignature(root);
    fs.writeFileSync(path.join(root, 'gba', 'New Game.zip'), 'x');
    expect(romSignature(root)).not.toBe(a);
  });
  it('turns PS3 disc folders into .ps3dir games', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps3-'));
    fs.mkdirSync(path.join(root, 'My Game', 'PS3_GAME'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Not a game'));
    expect(ps3FoldersAsGames(root)).toEqual(['My Game']);
    expect(fs.existsSync(path.join(root, 'My Game.ps3dir', 'PS3_GAME'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Not a game'))).toBe(true);
  });
});
