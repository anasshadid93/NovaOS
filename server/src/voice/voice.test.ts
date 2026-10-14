import { describe, expect, it } from 'vitest';
import { readOnlyCommand, spokenDecision } from './voice.js';

describe('spoken yes/no', () => {
  it('hears yes in Levantine, standard Arabic and English', () => {
    for (const s of ['اه موافق اعملها', 'موفّق', 'أيوا', 'آه', 'تمام، كمل', 'ماشي', 'نعم', 'اكيد يلا', 'Yes, do it', 'okay']) expect(spokenDecision(s), s).toBe('yes');
  });
  it('hears no, and no wins over yes', () => {
    for (const s of ['لا', 'لأ، استنى', 'لا مش موافق', 'بلاش هلأ', 'ما بدي', 'no', 'wait, cancel that', 'اه لا وقف']) expect(spokenDecision(s), s).toBe('no');
  });
  it('anything else is not an answer', () => {
    for (const s of ['شو يعني هاد الأمر؟', 'كم الساعة', '', 'لاعب كرة']) expect(spokenDecision(s), s).toBe(null);
  });
});

describe('look-only commands', () => {
  it('runs plain checks without asking', () => {
    for (const c of ["/bin/bash -lc 'ls -ld /home/anas/tmp'", 'df -h', "bash -lc 'docker ps --format {{.Names}}'", 'systemctl status manar', 'journalctl -u manar -n 50', 'ps aux | grep node | head -5', "find /srv -name '*.log'", 'free -m', "/bin/bash -lc \"find /home/anas -maxdepth 3 -type d \\\\( -iname 'tmp' \\\\) 2>/dev/null\"", 'journalctl -u x 2>&1 | tail -5'])
      expect(readOnlyCommand(c), c).toBe(true);
  });
  it('asks for anything that changes something or hides it', () => {
    for (const c of ["/bin/bash -lc 'mkdir -p -- /tmp/x'", 'rm -rf /tmp/x', 'ls > /tmp/out', 'ls; rm x', 'echo $(id)', 'sudo ls', 'find / -delete', 'find . -exec rm {} +', 'systemctl restart manar', 'docker rm x', "sed -i 's/a/b/' f", 'ls && reboot', 'journalctl --vacuum-size=1M', 'git push', 'python3 -c 1', 'ls 2>/tmp/e', 'cat x 2>&1 > y'])
      expect(readOnlyCommand(c), c).toBe(false);
  });
});
