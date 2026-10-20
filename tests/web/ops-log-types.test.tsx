import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { OPS_LOG_TYPE_IDS, OPS_LOG_TYPES } from '@nexa/contracts';
import {
  OPS_LOG_TYPE_LABEL,
  OpsLogTypeSwitches,
  opsLogTypesByTopic,
} from '../../apps/web/src/pages/ops-log-types';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * R4 PR-D — «هر نوع گزارش کلید روشن/خاموش خودش را دارد»: one switch per log type, under its
 * topic, stored as the list of types switched OFF.
 *
 * MUTATION: writing the switched-ON list instead of the OFF one -> the save test; listing a
 * type under another topic -> the grouping test.
 */

const rows = (disabled: readonly string[] = [], extra: unknown[] = []) => [
  {
    url: '/settings',
    body: {
      settings: [
        setting({
          key: 'ops.log.disabled_types',
          value: disabled,
          version: disabled.length === 0 ? null : 2,
          source: disabled.length === 0 ? 'DEFAULT' : 'TENANT',
          configures: 'ops_notifications',
        }),
        setting({ key: 'ops.log.storm_rollup_enabled', value: false }),
        setting({ key: 'ops.log.storm_threshold', value: 20 }),
        setting({ key: 'ops.log.storm_window_minutes', value: 5 }),
        setting({ key: 'ops.log.nightly_report_time', value: '23:59' }),
        ...extra,
      ],
    },
  },
];

describe('the per-type switches of the operations log group', () => {
  it('draws one labelled switch for every log type, each under its own topic, with a Persian name', async () => {
    stubApi(rows());
    renderPage(<OpsLogTypeSwitches mayManage />);
    await screen.findByTestId('ops-log-types');
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(OPS_LOG_TYPE_IDS.length);
    for (const group of opsLogTypesByTopic()) {
      const section = screen.getByRole('region', {
        name: t(`web.opsgroup_topic_${group.topic.toLowerCase()}` as never),
      });
      for (const id of group.types) {
        expect(OPS_LOG_TYPES[id].topic).toBe(group.topic);
        const name = t(OPS_LOG_TYPE_LABEL[id]);
        expect(name, id).toMatch(/[؀-ۿ]/u);
        expect(within(section).getByRole('switch', { name }), id).toBeInTheDocument();
      }
    }
    // The two topics this round added are listed with their types.
    expect(opsLogTypesByTopic().map((group) => group.topic)).toEqual(
      expect.arrayContaining(['USERS', 'REPORTS']),
    );
  });

  it('shows a type switched off as off and every other as on', async () => {
    stubApi(rows(['USER_NEW', 'SOME_FUTURE_TYPE']));
    renderPage(<OpsLogTypeSwitches mayManage />);
    await screen.findByTestId('ops-log-types');
    expect(
      screen.getByRole('switch', { name: t(OPS_LOG_TYPE_LABEL.USER_NEW) }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByRole('switch', { name: t(OPS_LOG_TYPE_LABEL.PAYMENT_TOPUP) }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('switching a type off saves the list of OFF types — keeping a name this release does not know', async () => {
    const api = stubApi([
      ...rows(['SOME_FUTURE_TYPE']),
      {
        url: '/settings/ops.log.disabled_types',
        method: 'POST',
        body: { setting: setting({ key: 'ops.log.disabled_types', value: [] }), changed: true },
      },
    ]);
    renderPage(<OpsLogTypeSwitches mayManage />);
    await screen.findByTestId('ops-log-types');
    fireEvent.click(screen.getByRole('switch', { name: t(OPS_LOG_TYPE_LABEL.TICKET_NEW) }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const write = api.calls.find((call) => call.method === 'POST')!;
    expect(write.url).toContain('/settings/ops.log.disabled_types');
    expect(write.body).toMatchObject({
      value: ['SOME_FUTURE_TYPE', 'TICKET_NEW'],
      expectedVersion: 2,
    });
  });

  it('is read-only for an administrator without settings.edit', async () => {
    stubApi(rows());
    renderPage(<OpsLogTypeSwitches mayManage={false} />);
    await screen.findByTestId('ops-log-types');
    for (const control of screen.getAllByRole('switch')) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
