import sys, subprocess, shutil, os, re
root='/home/user/r11-a11'
os.chdir(root)
M = {
 'M1': ('apps/api/src/modules/commerce/payments/application/payment-expiry.service.ts',
        "        if (payment.orderId === null) {\n          await this.deps.notifier.notify(",
        "        if (true) {\n          await this.deps.notifier.notify("),
 'M2': ('apps/api/src/modules/commerce/messaging/application/customer-notification.service.ts',
        "        closesOrder: row.subjectId,\n        answerSteps: ORDER_END_ANSWER_STEPS,",
        "        answerSteps: ORDER_END_ANSWER_STEPS,"),
 'M3': ('apps/api/src/modules/commerce/messaging/application/customer-notification.service.ts',
        "if (ended === null || ended.state !== ORDER_END_STATES[row.kind]) return null;",
        "if (ended === null || ORDER_END_STATES[row.kind] === undefined) return null;"),
 'M4': ('apps/api/src/modules/commerce/messaging/application/customer-notification.service.ts',
        "        closesOrder: row.subjectId,\n        answerSteps: ORDER_END_ANSWER_STEPS,",
        "        closesOrder: row.subjectId,"),
 'M5': ('apps/api/src/surfaces/telegram/runtime/keyboards.ts',
        "    { ...inlineLabel('order.reorder'), data, row: 0 },\n",
        ""),
 'M6': ('apps/api/src/surfaces/telegram/runtime/purchase-flow.ts',
        "  return cancelledOrderReply(rt, scope, actor, customer, orderId, tapped);",
        "  void cancelledOrderReply;\n  return { key: 'bot.order.cancelled', values: {}, buttons: [], orderId: null, fallback: { kind: 'ORDER_CANCELLED', subjectId: orderId } };"),
 'M7': ('apps/api/src/surfaces/telegram/runtime/order-end-flow.ts',
        "): Promise<PendingReply | null> {\n  if (\n    !isNexaError(error) ||",
        "): Promise<PendingReply | null> {\n  if (true) return null;\n  if (\n    !isNexaError(error) ||"),
 'M8': ('apps/api/src/surfaces/telegram/runtime/intent-of.ts',
        "      return { intent: 'REORDER_CATEGORY', targetId: category.data, callbackQueryId: id };",
        "      return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };"),
}
test='tests/integration/r11-order-end-edit-in-place.test.ts'
env=dict(os.environ, TEST_DATABASE_URL='postgres://nexa:nexa@127.0.0.1:5432/nexa_test_r11a11', DATABASE_URL='postgres://nexa:nexa@127.0.0.1:5432/nexa_test_r11a11')
for name in sys.argv[1:]:
    path, old, new = M[name]
    src=open(path,encoding='utf8').read()
    assert src.count(old)==1, (name, src.count(old))
    open(path,'w',encoding='utf8').write(src.replace(old,new))
    try:
        out=subprocess.run(['pnpm','exec','vitest','run','--project','integration',test],capture_output=True,text=True,env=env).stdout
    finally:
        open(path,'w',encoding='utf8').write(src)
    failed=sorted(set(l.strip() for l in out.splitlines() if l.strip().startswith('×')))
    summary=[l for l in out.splitlines() if 'Tests ' in l]
    print(name, summary, flush=True)
    for f in failed: print('   red:', f[:150], flush=True)
