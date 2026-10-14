import {
  Alert24Filled,
  ClipboardTaskListLtr24Filled,
  Server24Filled,
  ArrowSync24Filled,
  DarkTheme24Filled,
  Desktop24Filled,
  Globe24Filled,
  Info24Filled,
  Key24Filled,
  LocalLanguage24Filled,
  Phone24Filled,
  PlugConnected24Filled,
  PlugDisconnected24Filled,
  Power24Filled,
  ShieldLock24Filled,
  SignOut24Regular,
  Link24Filled,
  ArrowDownload24Filled,
  History24Filled,
  Games24Filled,
  MoviesAndTv24Filled,
  HeartPulse24Filled,
  Wifi124Filled,
} from '@fluentui/react-icons';
import { useAuth } from '../lib/auth';
import { setThemePref, useThemePref, type ThemePref } from '../lib/theme';
import { setDesktopPref, useDesktopPref, type DesktopPref } from '../desktop/mode';
import { LOCALES, useI18n, type Locale } from '../i18n';
import { ListGroup, ListRow, PageHeader } from '../components/ui';
import { inApp, openAppSettings } from '../lib/install';

export function Settings() {
  const { t, locale, setLocale } = useI18n();
  const { logout } = useAuth();
  const theme = useThemePref();
  const desktopPref = useDesktopPref();

  return (
    <>
      <PageHeader title={t('settings.title')} back="/" />
      <main className="safe-bottom mx-auto max-w-md space-y-5 px-3">
        <ListGroup caption={t('settings.group.account')}>
          <ListRow icon={Key24Filled} label={t('settings.passkeys')} href="/settings/passkeys" />
          <ListRow icon={Key24Filled} color="orange" label={t('pw.title')} href="/settings/passwords" />
          <ListRow icon={Phone24Filled} color="teal" label={t('settings.sessions')} href="/settings/sessions" />
          <ListRow icon={Link24Filled} color="orange" label={t('share.links')} href="/settings/shares" />
        </ListGroup>

        <ListGroup caption={t('settings.group.personalization')}>
          <ListRow
            icon={LocalLanguage24Filled}
            color="purple"
            label={t('settings.language')}
            trailing={
              <select
                aria-label={t('settings.language')}
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="rounded-lg bg-primary-soft px-2 py-1 text-sm text-primary-ink"
              >
                {Object.entries(LOCALES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            }
          />
          <ListRow
            icon={DarkTheme24Filled}
            color="slate"
            label={t('settings.appearance')}
            trailing={
              <select
                aria-label={t('settings.appearance')}
                value={theme}
                onChange={(e) => setThemePref(e.target.value as ThemePref)}
                className="rounded-lg bg-primary-soft px-2 py-1 text-sm text-primary-ink"
              >
                <option value="system">{t('appearance.system')}</option>
                <option value="light">{t('appearance.light')}</option>
                <option value="dark">{t('appearance.dark')}</option>
              </select>
            }
          />
          <ListRow
            icon={Desktop24Filled}
            color="blue"
            label={t('settings.desktopMode')}
            trailing={
              <select
                aria-label={t('settings.desktopMode')}
                value={desktopPref}
                onChange={(e) => setDesktopPref(e.target.value as DesktopPref)}
                className="rounded-lg bg-primary-soft px-2 py-1 text-sm text-primary-ink"
              >
                <option value="auto">{t('desktopMode.auto')}</option>
                <option value="desktop">{t('desktopMode.desktop')}</option>
                <option value="mobile">{t('desktopMode.mobile')}</option>
              </select>
            }
          />
        </ListGroup>

        <ListGroup caption={t('settings.group.system')}>
          <ListRow icon={Server24Filled} color="slate" label={t('settings.system')} href="/settings/system" />
          <ListRow icon={ArrowSync24Filled} color="green" label={t('upd.title')} href="/updates" />
          <ListRow icon={Globe24Filled} color="sky" label={t('settings.network')} href="/settings/network" />
          <ListRow icon={PlugConnected24Filled} color="blue" label={t('settings.tailscale')} href="/settings/tailscale" />
          <ListRow icon={ShieldLock24Filled} color="green" label={t('settings.firewall')} href="/settings/firewall" />
          <ListRow icon={PlugDisconnected24Filled} color="purple" label={t('settings.integrations')} href="/settings/integrations" />
        </ListGroup>

        <ListGroup caption={t('settings.group.power')}>
          <ListRow icon={Power24Filled} color="red" label={t('settings.power')} href="/settings/power" />
        </ListGroup>

        <ListGroup caption={t('settings.group.others')}>
          {inApp() && <ListRow icon={Phone24Filled} color="blue" label={t('settings.appSettings')} onClick={openAppSettings} />}
          {!inApp() && <ListRow icon={Phone24Filled} color="blue" label={t('settings.android')} href="/settings/android" />}
          <ListRow icon={Alert24Filled} color="orange" label={t('settings.notifications')} href="/settings/notifications" />
          <ListRow icon={ArrowDownload24Filled} color="blue" label={t('section.downloads')} href="/downloads" />
          <ListRow icon={History24Filled} color="green" label={t('section.backup')} href="/backup" />
          <ListRow icon={Games24Filled} color="purple" label={t('section.games')} href="/games" />
          <ListRow icon={MoviesAndTv24Filled} color="red" label={t('section.watch')} href="/watch" />
          <ListRow icon={HeartPulse24Filled} color="red" label={t('section.health')} href="/health" />
          <ListRow icon={Wifi124Filled} color="teal" label={t('section.network')} href="/network" />
          <ListRow icon={ClipboardTaskListLtr24Filled} color="purple" label={t('section.tasks')} href="/tasks" />
          <ListRow icon={Info24Filled} color="slate" label={t('settings.about')} href="/settings/about" />
        </ListGroup>

        <ListGroup>
          <ListRow icon={SignOut24Regular} color="red" label={t('settings.signOut')} onClick={() => void logout()} danger />
        </ListGroup>
      </main>
    </>
  );
}
