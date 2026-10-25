import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppGuidePlatformResponseSchema,
  miniAppGuideResponseSchema,
  type ClientAppPlatform,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { openExternal } from '../telegram.js';
import { Button, Card, Loading, useLoad } from '../ui.js';

/**
 * آموزش اتصال: the platforms the customer's services can be used on, and for each the apps
 * the operator configured (the Web Admin's client-apps setting, filtered by the customer's
 * services) with their download links and their own written guide — or, where no app is
 * configured, the tenant's guide text for that platform, exactly what the bot shows then.
 *
 * Not drawn: «افزودن خودکار به برنامه» (client apps carry no import link), the tutorial
 * video (a Telegram file scoped to the bot), the design's "recommended" subtitle (the app's
 * own description is shown) and its four numbered steps (the guide is the operator's text,
 * shown whole; the mock's steps were generic).
 */
export function Apps() {
  const { api, navigate } = useApp();
  const guide = useLoad(() => api.get(MINIAPP_ROUTES.guide, {}, miniAppGuideResponseSchema), [api]);
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.apps_title')}</h1>
      <Loading loaded={guide.loaded} reload={guide.reload}>
        {(result) =>
          result.platforms.length === 0 ? (
            <p className="muted">{t('miniapp.apps_none')}</p>
          ) : (
            <Platforms platforms={result.platforms} />
          )
        }
      </Loading>
      <Button onClick={() => navigate({ name: 'support' })}>{t('miniapp.service_support')}</Button>
    </main>
  );
}

function Platforms({ platforms }: { platforms: readonly ClientAppPlatform[] }) {
  const [chosen, setChosen] = useState<ClientAppPlatform>(platforms[0] ?? 'ANDROID');
  return (
    <>
      <div className="chips" role="tablist">
        {platforms.map((platform) => (
          <button
            key={platform}
            type="button"
            role="tab"
            aria-selected={platform === chosen}
            className={platform === chosen ? 'chip chip-on' : 'chip'}
            onClick={() => setChosen(platform)}
          >
            {t(`miniapp.platform_${platform}`)}
          </button>
        ))}
      </div>
      <Platform key={chosen} platform={chosen} />
    </>
  );
}

function Platform({ platform }: { platform: ClientAppPlatform }) {
  const { api } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.guidePlatform, { platform }, miniAppGuidePlatformResponseSchema),
    [api, platform],
  );
  return (
    <Loading loaded={loaded} reload={reload}>
      {(result) => {
        const guides = result.apps.filter((app) => app.guide !== null);
        if (result.apps.length === 0 && result.fallbackGuide === null) {
          return <p className="muted">{t('miniapp.apps_platform_none')}</p>;
        }
        return (
          <>
            {result.apps.length > 0 && (
              <Card>
                <h2>{t('miniapp.apps_section_apps')}</h2>
                {result.apps.map((app) => (
                  <div key={app.id} className="app-row">
                    <strong>{app.name}</strong>
                    {app.description !== null && <p className="muted">{app.description}</p>}
                    <div className="app-actions">
                      {app.officialUrl !== null && (
                        <Button primary onClick={() => openExternal(app.officialUrl as string)}>
                          {t('miniapp.apps_download')}
                        </Button>
                      )}
                      {app.alternativeUrl !== null && (
                        <Button onClick={() => openExternal(app.alternativeUrl as string)}>
                          {t('miniapp.apps_download_alt')}
                        </Button>
                      )}
                      {app.helpUrl !== null && (
                        <Button onClick={() => openExternal(app.helpUrl as string)}>
                          {t('miniapp.apps_help')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            )}
            {(guides.length > 0 || result.fallbackGuide !== null) && (
              <Card>
                <h2>{t('miniapp.apps_section_steps')}</h2>
                {guides.map((app) => (
                  <div key={app.id} className="app-row">
                    {result.apps.length > 1 && <strong>{app.name}</strong>}
                    <p className="guide-text">{app.guide}</p>
                  </div>
                ))}
                {result.fallbackGuide !== null && (
                  <p className="guide-text">{result.fallbackGuide}</p>
                )}
              </Card>
            )}
          </>
        );
      }}
    </Loading>
  );
}
