import { t, type WebKey } from '../i18n/web.fa';
import { Icon } from './icons';

/** The protocol documents of the two custom kinds, on the repository's main branch. */
export const PROTOCOL_DOC_URLS = {
  panel: 'https://github.com/Mhoseinshah1/nexa-bot/blob/main/docs/protocols/custom-panel.md',
  gateway: 'https://github.com/Mhoseinshah1/nexa-bot/blob/main/docs/protocols/custom-gateway.md',
} as const;

const COPY: Record<keyof typeof PROTOCOL_DOC_URLS, { title: WebKey; hint: WebKey }> = {
  panel: { title: 'web.protocol_doc_panel_title', hint: 'web.protocol_doc_panel_hint' },
  gateway: { title: 'web.protocol_doc_gateway_title', hint: 'web.protocol_doc_gateway_hint' },
};

/**
 * A framed box on a custom form: the title, one muted line, and a button that opens the
 * protocol document in a new tab. A link and nothing else; it reads and writes no data.
 */
export function ProtocolDocBox({ kind }: { kind: keyof typeof PROTOCOL_DOC_URLS }) {
  const copy = COPY[kind];
  return (
    <div className="doc-box" data-testid={`protocol-doc-${kind}`}>
      <div className="doc-box-text">
        <strong>{t(copy.title)}</strong>
        <p className="muted small">{t(copy.hint)}</p>
      </div>
      <a
        className="btn sm"
        href={PROTOCOL_DOC_URLS[kind]}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Icon name="external" />
        {t('web.protocol_doc_open')}
      </a>
    </div>
  );
}
