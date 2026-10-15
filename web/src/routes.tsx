import { lazy } from 'react';
import { Route, Switch } from 'wouter';
import { Home } from './pages/Home';

// Everything except the first screen is split into its own chunk.
type Mod = Record<string, unknown>;
const page = (load: () => Promise<Mod>, name: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lazy(() => load().then((m) => ({ default: m[name] as React.ComponentType<any> })));

const Settings = page(() => import('./pages/Settings'), 'Settings');
const Passkeys = page(() => import('./pages/Passkeys'), 'Passkeys');
const Sessions = page(() => import('./pages/Sessions'), 'Sessions');
const About = page(() => import('./pages/misc'), 'About');
const Monitor = page(() => import('./pages/Monitor'), 'Monitor'); // uPlot lives only here
const Processes = page(() => import('./pages/Processes'), 'Processes');
const ProcessDetail = page(() => import('./pages/ProcessDetail'), 'ProcessDetail');
const Docker = page(() => import('./pages/Docker'), 'Docker');
const ContainerDetail = page(() => import('./pages/ContainerDetail'), 'ContainerDetail');
const Store = page(() => import('./pages/Store'), 'Store');
const StoreApp = page(() => import('./pages/Store'), 'StoreApp');
const Apps = page(() => import('./pages/Apps'), 'Apps');
const Tasks = page(() => import('./pages/Tasks'), 'Tasks');
const TaskDetail = page(() => import('./pages/Tasks'), 'TaskDetail');
const Launcher = page(() => import('./pages/Launcher'), 'Launcher');
const FileManager = page(() => import('./pages/FileManager'), 'FileManager');
const FileCategoryView = page(() => import('./pages/FileViews'), 'FileCategoryView');
const FileSearch = page(() => import('./pages/FileViews'), 'FileSearch');
const RecycleBin = page(() => import('./pages/FileViews'), 'RecycleBin');
const Gallery = page(() => import('./pages/Gallery'), 'Gallery');
const Viewer = page(() => import('./pages/Viewer'), 'Viewer');
const Editor = page(() => import('./pages/Editor'), 'Editor');
const WallpaperPicker = page(() => import('./pages/WallpaperPicker'), 'WallpaperPicker');
const Terminal = page(() => import('./pages/Terminal'), 'Terminal');
const Display = page(() => import('./pages/Display'), 'Display');
const Shares = page(() => import('./pages/Shares'), 'Shares');
const Music = page(() => import('./pages/Music'), 'Music');
const Voice = page(() => import('./pages/Voice'), 'Voice');
const Updates = page(() => import('./pages/Updates'), 'Updates');
const Disks = page(() => import('./pages/Disks'), 'Disks');
const Downloads = page(() => import('./pages/Downloads'), 'Downloads');
const Network = page(() => import('./pages/Network'), 'Network');
const Health = page(() => import('./pages/Health'), 'Health');
const Watch = page(() => import('./pages/Watch'), 'Watch');
const Games = page(() => import('./pages/Games'), 'Games');
const Backup = page(() => import('./pages/Backup'), 'Backup');
const SystemInfo = page(() => import('./pages/SettingsPages'), 'SystemInfo');
const AppPasswords = page(() => import('./pages/AppPasswords'), 'AppPasswords');
const NetworkInfo = page(() => import('./pages/SettingsPages'), 'NetworkInfo');
const TailscaleInfo = page(() => import('./pages/SettingsPages'), 'TailscaleInfo');
const FirewallInfo = page(() => import('./pages/SettingsPages'), 'FirewallInfo');
const Integrations = page(() => import('./pages/Integrations'), 'Integrations');
const AndroidApp = page(() => import('./pages/AndroidApp'), 'AndroidApp');
const Prices = page(() => import('./pages/Prices'), 'Prices');
const News = page(() => import('./pages/News'), 'News');
const PowerSettings = page(() => import('./pages/SettingsPages'), 'PowerSettings');
const NotificationSettings = page(() => import('./pages/SettingsPages'), 'NotificationSettings');


/** Every screen. Used full-screen on phones and inside each window on the desktop. */
export function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/settings" component={Settings} />
      <Route path="/settings/passkeys" component={Passkeys} />
      <Route path="/settings/sessions" component={Sessions} />
      <Route path="/settings/about" component={About} />
      <Route path="/monitor" component={Monitor} />
      <Route path="/processes" component={Processes} />
      <Route path="/processes/:pid" component={ProcessDetail} />
      <Route path="/docker" component={Docker} />
      <Route path="/docker/:id" component={ContainerDetail} />
      <Route path="/store" component={Store} />
      <Route path="/store/:id" component={StoreApp} />
      <Route path="/apps" component={Apps} />
      <Route path="/files" component={FileManager} />
      <Route path="/files/c/:cat" component={FileCategoryView} />
      <Route path="/files/search" component={FileSearch} />
      <Route path="/files/bin" component={RecycleBin} />
      <Route path="/gallery" component={Gallery} />
      <Route path="/disks" component={Disks} />
      <Route path="/downloads" component={Downloads} />
      <Route path="/network" component={Network} />
      <Route path="/health" component={Health} />
      <Route path="/watch" component={Watch} />
      <Route path="/games" component={Games} />
      <Route path="/backup" component={Backup} />
      <Route path="/view" component={Viewer} />
      <Route path="/edit" component={Editor} />
      <Route path="/wallpaper" component={WallpaperPicker} />
      <Route path="/terminal" component={Terminal} />
      <Route path="/display" component={Display} />
      <Route path="/updates" component={Updates} />
      <Route path="/music" component={Music} />
      <Route path="/voice" component={Voice} />
      <Route path="/settings/shares" component={Shares} />
      <Route path="/launcher" component={Launcher} />
      <Route path="/settings/system" component={SystemInfo} />
      <Route path="/settings/network" component={NetworkInfo} />
      <Route path="/settings/passwords" component={AppPasswords} />
      <Route path="/settings/tailscale" component={TailscaleInfo} />
      <Route path="/settings/firewall" component={FirewallInfo} />
      <Route path="/settings/integrations" component={Integrations} />
      <Route path="/settings/android" component={AndroidApp} />
      <Route path="/prices" component={Prices} />
      <Route path="/news" component={News} />
      <Route path="/settings/power" component={PowerSettings} />
      <Route path="/settings/notifications" component={NotificationSettings} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/tasks/:id" component={TaskDetail} />
      <Route>{() => <Home />}</Route>
    </Switch>
  );
}
