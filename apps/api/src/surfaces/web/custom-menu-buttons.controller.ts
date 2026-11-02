import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  CUSTOM_MENU_BUTTON_ROUTES,
  type CustomMenuButtonListResponse,
  type CustomMenuButtonMutationResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';

/**
 * R10 D2 — the owner's custom main-menu buttons at `/bot-menu/custom-buttons`: the list, create,
 * update, replace the file, archive. They are PLACED through the button builder
 * (`/bot-menu/builder`); this is where they are defined.
 *
 * Authentication happens here; AUTHORIZATION, validation and the scope's activity do not —
 * `CustomMenuButtonService` charges `settings.view` / `settings.edit` itself, inside the
 * write's transaction, as the builder does.
 */
@Controller(`${API_PREFIX}`)
export class CustomMenuButtonsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(CUSTOM_MENU_BUTTON_ROUTES.list)
  async list(@Req() request: FastifyRequest): Promise<CustomMenuButtonListResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.customMenuButtons.list(scope, actor);
  }

  @Post(CUSTOM_MENU_BUTTON_ROUTES.create)
  async create(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.customMenuButtons.create(scope, actor, body);
  }

  @Put(CUSTOM_MENU_BUTTON_ROUTES.updatePattern)
  async update(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.customMenuButtons.update(scope, actor, id, body);
  }

  @Post(CUSTOM_MENU_BUTTON_ROUTES.archivePattern)
  async archive(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.customMenuButtons.archive(scope, actor, id, body);
  }

  @Put(CUSTOM_MENU_BUTTON_ROUTES.mediaPattern)
  async setMedia(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomMenuButtonMutationResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return this.container.customMenuButtons.setMedia(scope, actor, id, body);
  }
}
