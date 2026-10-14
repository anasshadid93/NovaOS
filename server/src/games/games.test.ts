import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-games-'));
process.env.MANAR_MEDIA_ROOT = tmp;
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
const { biosStatus, library } = await import('./games.js');

const touch = (p: string, size = 10) => {
  fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
  fs.writeFileSync(path.join(tmp, p), Buffer.alloc(size));
};

describe('games library', () => {
  it('counts games per console; a .cue and its .bin tracks are one PS1 game', () => {
    touch('Games/ROMs/psx/Crash/Crash Bandicoot.cue');
    touch('Games/ROMs/psx/Crash/Crash Bandicoot (Track 1).bin', 1000);
    touch('Games/ROMs/psx/Crash/Crash Bandicoot (Track 2).bin', 1000);
    touch('Games/ROMs/ps2/God of War.iso', 5000);
    touch('Games/ROMs/psx/Final Fantasy VII (USA).m3u/Final Fantasy VII (USA) (Disc 1).chd');
    touch('Games/ROMs/psx/Final Fantasy VII (USA).m3u/Final Fantasy VII (USA) (Disc 2).chd');
    touch('Games/ROMs/psx/Final Fantasy VII (USA).m3u/Final Fantasy VII (USA).m3u');
    touch('Games/ROMs/ps2/readme.txt');
    touch('Games/ROMs/ps3/Demon Souls/PS3_GAME/PARAM.SFO');
    touch('Games/ROMs/ps4/Bloodborne.ps4/eboot.bin');
    touch('Games/ROMs/ps4/Bloodborne.ps4/sce_sys/param.sfo');
    const lib = Object.fromEntries(library().map((s) => [s.id, s]));
    expect(lib.psx.count).toBe(2);
    expect(lib.psx.bytes).toBe(2040);
    expect(lib.ps2.count).toBe(1);
    expect(lib.ps2.games.map((g) => g.name)).toEqual(['God of War']);
    expect(lib.ps3.count).toBe(1);
    expect(lib.ps4.count).toBe(1);
    expect(lib.ps4.games.map((g) => g.name)).toEqual(['Bloodborne']);
    expect(lib.snes.count).toBe(0);
  });
  it('knows which BIOS files are there', () => {
    touch('Games/bios/scph5501.bin');
    touch('Games/bios/PS3UPDAT.PUP');
    touch('Games/bios/ps4/sys_modules/libSceNgs2.sprx');
    const b = Object.fromEntries(biosStatus().map((x) => [x.system, x.present]));
    expect(b).toMatchObject({ psx: true, ps2: false, ps3: true, ps4: true });
  });
});
