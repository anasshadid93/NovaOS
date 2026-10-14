#!/usr/bin/env python3
"""Box art for every game in Games/ROMs, from libretro-thumbnails (same names as the No-Intro/Redump
files), into Games/media/<system>/covers/<game>.png — where ES-DE (MediaDirectory=/media) looks.
Re-runnable: existing covers are skipped, misses are remembered for a week."""
import concurrent.futures as cf, json, os, re, time, urllib.parse, urllib.request

ROMS = '/srv/data/external/Toshiba/Games/ROMs'
MEDIA = '/srv/data/external/Toshiba/Games/media'
REPOS = {
    'nes': 'Nintendo_-_Nintendo_Entertainment_System', 'snes': 'Nintendo_-_Super_Nintendo_Entertainment_System',
    'n64': 'Nintendo_-_Nintendo_64', 'gb': 'Nintendo_-_Game_Boy', 'gbc': 'Nintendo_-_Game_Boy_Color',
    'gba': 'Nintendo_-_Game_Boy_Advance', 'megadrive': 'Sega_-_Mega_Drive_-_Genesis',
    'mastersystem': 'Sega_-_Master_System_-_Mark_III', 'gamegear': 'Sega_-_Game_Gear',
    'pcengine': 'NEC_-_PC_Engine_-_TurboGrafx_16', 'psx': 'Sony_-_PlayStation', 'ps2': 'Sony_-_PlayStation_2',
    'fbneo': 'FBNeo_-_Arcade_Games', 'ps3': 'Sony_-_PlayStation_3', 'psp': 'Sony_-_PlayStation_Portable',
    'nds': 'Nintendo_-_Nintendo_DS', 'dreamcast': 'Sega_-_Dreamcast', 'gamecube': 'Nintendo_-_GameCube',
    'wii': 'Nintendo_-_Wii', 'n64dd': 'Nintendo_-_Nintendo_64DD',
}
# Arcade ROMs are short names (mslug.zip); the thumbnails use the full title from FBNeo's list.
TITLES = {}
_dat = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fbneo.dat')
if os.path.exists(_dat):
    for _n, _d in re.findall(r'<game name="([^"]+)"[^>]*>\s*<description>([^<]+)</description>', open(_dat, encoding='utf-8', errors='replace').read()):
        TITLES[_n] = _d.replace('&amp;', '&').replace('&apos;', "'").replace('&quot;', '"')
MISS = os.path.join(MEDIA, '.misses.json')
misses = json.load(open(MISS)) if os.path.exists(MISS) else {}


def libretro_name(n):
    return re.sub(r'[&*/:`<>?\\|]', '_', n)


def candidates(game):
    if game in TITLES:
        yield TITLES[game]
    yield game
    yield re.sub(r' \((v\d[\d.]*|Rev \d+)\)', '', game)  # without version/revision
    yield f'{game} (Disc 1)'
    yield re.sub(r'\s*\([^)]*\)', '', game).strip() + ' (USA)'


_trees = {}
def repo_names(sysd):
    """All box-art names of a repo (git tree, one request) for fuzzy matches on systems with few games."""
    if sysd not in _trees:
        try:
            with urllib.request.urlopen(f'https://api.github.com/repos/libretro-thumbnails/{REPOS[sysd]}/git/trees/master?recursive=1', timeout=60) as r:
                tree = json.load(r)['tree']
            _trees[sysd] = [t['path'][len('Named_Boxarts/'):-4] for t in tree if t['path'].startswith('Named_Boxarts/') and t['path'].endswith('.png')]
        except Exception:  # noqa: BLE001
            _trees[sysd] = []
    return _trees[sysd]


def fuzzy(sysd, game):
    base = re.sub(r'\s*\([^)]*\)', '', game).strip().lower()
    if len(base) < 4:
        return []
    names = repo_names(sysd)
    exact = [n for n in names if re.sub(r'\s*\([^)]*\)', '', n).strip().lower() == base]
    usa = [n for n in exact if '(USA)' in n] or [n for n in exact if 'Europe' in n]
    return (usa or exact)[:2]


def fetch(sysd, game, icon=None):
    dest = f'{MEDIA}/{sysd}/covers/{game}.png'
    if not os.path.exists(dest) and icon and os.path.exists(icon):
        if icon.lower().endswith('.iso'):
            # A PS3 disc image carries the game's icon inside: PS3_GAME/ICON0.PNG.
            import subprocess
            r = subprocess.run(['7z', 'e', '-so', icon, 'PS3_GAME/ICON0.PNG'], capture_output=True, timeout=120)
            data = r.stdout if r.stdout.startswith(b'\x89PNG') else b''  # 7z exits 2 on header warnings
        else:
            with open(icon, 'rb') as a:
                data = a.read()
        if data:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'wb') as b:
                b.write(data)
            return True
    key = f'{sysd}/{game}'
    if os.path.exists(dest) or misses.get(key, 0) > time.time() - 7 * 86400:
        return None
    for c in dict.fromkeys(candidates(game)):
        u = f'https://raw.githubusercontent.com/libretro-thumbnails/{REPOS[sysd]}/master/Named_Boxarts/{urllib.parse.quote(libretro_name(c))}.png'
        try:
            with urllib.request.urlopen(u, timeout=30) as r:
                data = r.read()
            # The thumbnail repos store duplicates as git symlinks: raw GitHub serves the link text
            # (another file name), not the image. Follow it once.
            if not data.startswith(b'\x89PNG') and len(data) < 400:
                target = data.decode('utf-8', 'replace').strip()
                with urllib.request.urlopen(u.rsplit('/', 1)[0] + '/' + urllib.parse.quote(target), timeout=30) as r:
                    data = r.read()
            if not data.startswith(b'\x89PNG'):
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'wb') as f:
                f.write(data)
            return True
        except Exception:  # noqa: BLE001
            continue
    for c in (fuzzy(sysd, game) if sysd in ('ps3', 'psp', 'ps2', 'psx', 'dreamcast', 'gamecube', 'wii', 'nds') else []):
        u = f'https://raw.githubusercontent.com/libretro-thumbnails/{REPOS[sysd]}/master/Named_Boxarts/{urllib.parse.quote(c)}.png'
        try:
            with urllib.request.urlopen(u, timeout=30) as r:
                data = r.read()
            if data.startswith(b'\x89PNG'):
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, 'wb') as f:
                    f.write(data)
                return True
        except Exception:  # noqa: BLE001
            continue
    misses[key] = time.time()
    return False


jobs = []
for sysd in REPOS:
    d = f'{ROMS}/{sysd}'
    if not os.path.isdir(d):
        continue
    for n in os.listdir(d):
        if n.endswith('.part') or n.startswith('.'):
            continue
        game = re.sub(r'\.(7z|zip|chd|iso|cue|m3u|bin|nes|sfc|smc|gba|gbc|gb|z64|n64|md|gg|sms|pce|pkg|cso|pbp|nds|gdi|cdi|gcz|rvz|wbfs|ps3dir)$', '', n, flags=re.I)
        # A PS3 game folder carries its own icon (ICON0.PNG): use it when libretro has no box art.
        icon = f'{d}/{n}/ICON0.PNG' if n.lower().endswith('.ps3dir') else (f'{d}/{n}' if sysd == 'ps3' and n.lower().endswith('.iso') else None)
        jobs.append((sysd, game, icon))
got = miss = 0
with cf.ThreadPoolExecutor(16) as ex:
    for r in ex.map(lambda j: fetch(*j), jobs):
        got += r is True
        miss += r is False
json.dump(misses, open(MISS, 'w'))
print(time.strftime('%H:%M:%S'), f'{len(jobs)} games, {got} new covers, {miss} not found', flush=True)
