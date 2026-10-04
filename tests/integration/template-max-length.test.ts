import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TELEGRAM_CAPTION_MAX_LENGTH,
  TEMPLATE_BODY_MAX_LENGTH,
  TERMS_TEMPLATE_MAX_LENGTH,
  type ActorContext,
} from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * PR #185 review (P3): the template view tells the editor the ceiling the VALIDATOR will
 * apply — the key's own `maxLength` where it declares a tighter one — rather than the
 * generic 4,096 for every key. Otherwise the editor accepts typing the server then refuses.
 */
describe('the template view’s length ceiling', () => {
  let ctx: TestContext;
  let owner: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'tpl-max', roleKeys: ['owner'] }),
    );
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('reports the key’s own bound where it declares one, and the generic bound otherwise', async () => {
    const service = ctx.container.templatesService;
    expect((await service.get(tenantA, owner, 'bot.service.file_caption')).maxLength).toBe(
      TELEGRAM_CAPTION_MAX_LENGTH,
    );
    expect((await service.get(tenantA, owner, 'bot.terms.required')).maxLength).toBe(
      TERMS_TEMPLATE_MAX_LENGTH,
    );
    expect((await service.get(tenantA, owner, 'bot.ping.reply')).maxLength).toBe(
      TEMPLATE_BODY_MAX_LENGTH,
    );
    const listed = await service.list(tenantA, owner);
    expect(listed.find((view) => view.key === 'bot.service.file_caption')?.maxLength).toBe(
      TELEGRAM_CAPTION_MAX_LENGTH,
    );
  });
});
