import { useI18n } from '../i18n';

export function Brand({ subtitle }: { subtitle?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <img src="/icons/icon.svg" alt="" className="size-16 rounded-2xl shadow-card" width={64} height={64} />
      <div>
        <p className="text-2xl font-bold text-heading">{t('app.name')}</p>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
