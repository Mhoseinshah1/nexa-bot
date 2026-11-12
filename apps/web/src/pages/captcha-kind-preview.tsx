import { useState } from 'react';
import { API_PREFIX, START_CAPTCHA_KINDS, type StartCaptchaKind } from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';

/** Where the freshly generated sample picture of the `IMAGE_NUMBER` question comes from. */
export const CAPTCHA_PREVIEW_IMAGE_PATH = `${API_PREFIX}/settings/captcha-preview/image`;

const LABELS: Readonly<Record<StartCaptchaKind, WebKey>> = {
  MATH: 'web.captcha_kind_math',
  IMAGE_NUMBER: 'web.captcha_kind_image_number',
  EMOJI: 'web.captcha_kind_emoji',
  WORD_NUMBER: 'web.captcha_kind_word_number',
  RANDOM: 'web.captcha_kind_random',
};

/** The buttons a question shows, as the customer sees them. Fixed samples, not data. */
const SAMPLE_BUTTONS: Readonly<Partial<Record<StartCaptchaKind, readonly string[]>>> = {
  MATH: ['9', '11', '14', '3'],
  EMOJI: ['🍎', '🍌', '🐱', '🍇'],
  WORD_NUMBER: ['37', '73', '27', '47'],
};

const SAMPLE_TEXT: Readonly<Partial<Record<StartCaptchaKind, WebKey>>> = {
  MATH: 'web.captcha_preview_math',
  EMOJI: 'web.captcha_preview_emoji',
  WORD_NUMBER: 'web.captcha_preview_word_number',
  RANDOM: 'web.captcha_preview_random',
};

function SamplePicture() {
  // A new number on every press: the address differs, and the server never lets it be cached.
  const [sample, setSample] = useState(0);
  const [failed, setFailed] = useState(false);
  return (
    <div className="captcha-sample-picture">
      {failed ? (
        <p className="muted small">{t('web.captcha_preview_image_unavailable')}</p>
      ) : (
        <img
          key={sample}
          src={`${CAPTCHA_PREVIEW_IMAGE_PATH}?sample=${String(sample)}`}
          width={320}
          height={120}
          alt={t('web.captcha_preview_image_alt')}
          onError={() => setFailed(true)}
        />
      )}
      <div className="captcha-sample-buttons" aria-hidden="true">
        <span className="captcha-chip">{t('web.captcha_preview_refresh')}</span>
      </div>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          setFailed(false);
          setSample((current) => current + 1);
        }}
      >
        {t('web.captcha_preview_new_sample')}
      </button>
    </div>
  );
}

/**
 * Under the «نوع سؤال» select: what each kind looks like to a new customer. The text and the
 * buttons are fixed samples; the picture is generated fresh by the server on every load.
 * The kind currently chosen in the select is marked. Purely a preview: it changes nothing.
 */
export function CaptchaKindPreview({ selected }: { selected: unknown }) {
  return (
    <section className="captcha-preview" aria-label={t('web.captcha_preview_title')}>
      <h4 className="small">{t('web.captcha_preview_title')}</h4>
      <div className="captcha-preview-grid">
        {START_CAPTCHA_KINDS.map((kind) => (
          <div
            key={kind}
            className="captcha-preview-card"
            data-selected={selected === kind ? 'true' : 'false'}
          >
            <strong className="small">{t(LABELS[kind])}</strong>
            {kind === 'IMAGE_NUMBER' ? (
              <SamplePicture />
            ) : (
              <>
                <p className="small">{t(SAMPLE_TEXT[kind] as WebKey)}</p>
                {SAMPLE_BUTTONS[kind] !== undefined && (
                  <div className="captcha-sample-buttons" aria-hidden="true">
                    {(SAMPLE_BUTTONS[kind] as readonly string[]).map((label) => (
                      <span key={label} className="captcha-chip">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
