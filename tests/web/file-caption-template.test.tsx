import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import {
  FILE_CAPTION_PLACEHOLDERS,
  TELEGRAM_CAPTION_MAX_LENGTH,
  templateDefinition,
  templateViewSchema,
} from '@nexa/contracts';
import { ContentPage } from '../../apps/web/src/pages/content';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  PLACEHOLDER_LABEL_OVERRIDES_FA,
  TEMPLATE_COPY_FA,
} from '../../apps/web/src/i18n/templates.fa';
import { renderPage, stubApi } from './harness';

/**
 * UX Batch 01 item 4 — the connection file's caption on the template screen: the allowed
 * facts listed in Persian beside their tokens, the caption bound on the editor, and an
 * unknown placeholder refused in Persian with the token named.
 */
const KEY = 'bot.service.file_caption';
const definition = templateDefinition(KEY);
const view = () =>
  templateViewSchema.parse({
    key: KEY,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body: '{caption}',
    defaultBody: '{caption}',
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
  });
const name = TEMPLATE_COPY_FA[KEY]?.[0] ?? '';
const labels = PLACEHOLDER_LABEL_OVERRIDES_FA[KEY] ?? {};
const editor = () => document.getElementById(`body-${KEY}`) as HTMLTextAreaElement;

describe('the connection file caption on the template screen', () => {
  it('lists every allowed fact, in Persian, beside its token', async () => {
    stubApi([{ url: '/templates', body: { templates: [view()] } }]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name });

    for (const { token } of FILE_CAPTION_PLACEHOLDERS) {
      expect(screen.getAllByText(`{${token}}`).length).toBeGreaterThan(0);
      expect(labels[token]).toBeTruthy();
      expect(screen.getAllByText(labels[token] as string).length).toBeGreaterThan(0);
    }
    // The editor is bounded by Telegram's caption limit, not the message limit.
    expect(editor().maxLength).toBe(TELEGRAM_CAPTION_MAX_LENGTH);
  });

  it('says in Persian which placeholder is unknown when a save is refused', async () => {
    stubApi([
      { url: '/templates', body: { templates: [view()] } },
      {
        url: `/templates/${KEY}`,
        status: 400,
        body: {
          error: {
            kind: 'validation',
            code: 'control.template_invalid',
            message: `This body is not valid for ${KEY}.`,
            details: {
              key: KEY,
              issues: [
                {
                  kind: 'UNKNOWN_PLACEHOLDER',
                  token: 'password',
                  detail: `{password} is not declared for ${KEY}.`,
                },
              ],
            },
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name });

    fireEvent.change(editor(), { target: { value: '👤 {username}\n🔑 {password}' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));

    expect(await screen.findByText(t('web.template_invalid'))).toBeInTheDocument();
    const issue = screen.getByText(new RegExp(t('web.template_issue_unknown')));
    expect(issue.textContent).toContain('{password}');
    expect(screen.queryByText(/is not declared/)).toBeNull();
  });
});
