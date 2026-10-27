root='/home/user/r11-b1-mut/apps/api/src/modules/commerce/'
def sub(path, old, new, count=1):
    p=root+path
    s=open(p).read()
    assert s.count(old)==count, (path, old, s.count(old))
    open(p,'w').write(s.replace(old,new))

repo='miniapp/infrastructure/drizzle-notification-centre.repository.ts'
svc='miniapp/application/notification-centre.service.ts'
lane='messaging/application/customer-notification.service.ts'
lrepo='messaging/infrastructure/drizzle-customer-notification.repository.ts'
# M1 customer
sub(repo,"      eq(customerNotifications.customerId, input.customerId),\n","")
# M2 bot
sub(repo,"      eq(customerNotifications.botInstanceId, input.botInstanceId),\n","")
# M3 tenant
sub(repo,"      eq(customerNotifications.tenantId, requireTenantId(scope)),\n","")
# M4 delivered-only
sub(repo,"      isNotNull(customerNotifications.renderedText),\n","")
# M6 unread filter in the count (before M5 so the context still matches)
sub(repo,"          this.owned(scope, input),\n          isNull(customerNotifications.customerReadAt),\n          gte(","          this.owned(scope, input),\n          gte(")
# M5 window, list and count
sub(repo,"          gte(customerNotifications.resolvedAt, input.since),\n","", count=2)
# M7 markRead conditional
sub(repo,"          eq(customerNotifications.id, input.id),\n          isNull(customerNotifications.customerReadAt),\n","          eq(customerNotifications.id, input.id),\n")
# M11 keyset predicate
sub(repo,"          at === null || input.after === null\n            ? undefined\n            : sql`(","          undefined && sql`(")
# M8 flag off
sub(svc,"""    if (!(await this.deps.features.isEnabled(scope, NOTIFICATION_CENTRE_FEATURE))) {
      throw this.unavailable();
    }
  }""","""  }""")
sub(svc,"""        if (!(await this.deps.features.isEnabled(scope, NOTIFICATION_CENTRE_FEATURE, tx))) {
          throw this.unavailable();
        }
""","")
# M9 scope activity
sub(svc,"""        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
""","")
# M10 idempotency
sub(svc,"""        await rememberOnce(
          this.deps.idempotency,
          scope,
          namespace,
          owner.idempotencyKey,
          requestHash,
          { marked: changed },
          tx,
        );
""","")
# M12 render for every outcome
sub(lane,"to === 'DELIVERED' ? await this.renderedTextFor(scope, row, content.values) : null;","await this.renderedTextFor(scope, row, content.values);")
# M13 record stamps text for any outcome
sub(lrepo,"...(to === 'DELIVERED' && stamps.renderedText != null","...(stamps.renderedText != null")
print('mutated')
