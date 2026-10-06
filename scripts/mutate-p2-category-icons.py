"""Phase 2 UX wave, Item 2 (category premium icon before, ordinary emoji after) mutation driver.

Record: docs/phase2/category-icons-falsification.md.

Reverts one rule at a time, runs the named tests, and restores the file from the copy it read.
A mutant of `packages/contracts` rebuilds the package (tests import its `dist`) before the run
and again after the restore. Integration mutants need the database (`bash scripts/dev-services.sh`);
point TEST_DATABASE_URL and DATABASE_URL at a database of your own if another suite is running.
A mutant counts as KILLED only when the run executed tests and at least one FAILED.

Usage: python3 scripts/mutate-p2-category-icons.py [P2C-01 ...]
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages']).returncode != 0:
    sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

IB = 'packages/contracts/src/inline-buttons.ts'
MS = 'apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts'
CT = 'apps/api/src/container.ts'
WCI = 'apps/web/src/pages/category-icons.tsx'
WPC = 'apps/web/src/pages/product-categories.tsx'

U_CIC = ('unit', 'tests/unit/category-icons-contract.test.ts')
U_TCI = ('unit', 'tests/unit/telegram-category-icons.test.ts')
I_CI = ('integration', 'tests/integration/category-icons.test.ts')
I_OF = ('integration', 'tests/integration/telegram-order-flow.test.ts')
W_CI = ('web', 'tests/web/category-icons.test.tsx')

M = [
    # --- the contract: what may be stored ----------------------------------------------------
    ('P2C-01', [(IB, '    before: customEmojiIdSchema.optional(),', '    before: z.string().optional(),')],
     U_CIC, 'refuses an id that is not a custom emoji id'),
    ('P2C-02', [(IB, '    before: customEmojiIdSchema.optional(),', '    before: z.string().optional(),')],
     I_CI, 'refuses an invalid id and an invalid after'),
    ('P2C-03', [(IB, "  String.raw`^(?:${KEYCAP}|${TAG_FLAG}|${FLAG}|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*)+$`,",
                 "  String.raw`^[^<>&\\s]+$`,")],
     U_CIC, 'refuses an after that is markup'),
    ('P2C-04', [(IB, "  String.raw`^(?:${KEYCAP}|${TAG_FLAG}|${FLAG}|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*)+$`,",
                 "  String.raw`^[^<>&\\s]+$`,")],
     I_CI, 'refuses an invalid id and an invalid after'),
    ('P2C-05', [(IB, '  if (points.length === 0 || points.length > CATEGORY_AFTER_EMOJI_MAX_CODE_POINTS) return false;',
                 '  if (points.length === 0) return false;')],
     U_CIC, 'refuses an after that is markup'),
    ('P2C-06', [(IB, "const KEYCAP = String.raw`[#*0-9]\\uFE0F?\\u20E3`;",
                 "const KEYCAP = String.raw`[#*0-9]\\uFE0F?\\u20E3?`;")],
     U_CIC, 'only where it belongs'),
    ('P2C-07', [(IB, '  .refine((value) => value.before !== undefined || value.after !== undefined, {',
                 '  .refine(() => true, {')],
     U_CIC, 'refuses an entry with neither'),
    ('P2C-08', [(IB, '  })\n  .strict()\n  .refine(', '  })\n  .refine(')],
     U_CIC, 'refuses an entry with neither'),
    ('P2C-09', [(IB, "    categoryIconOf(categoryId, icons).before ?? inlineButtonIconOf('catalog.category', inlineIcons)",
                 "    inlineButtonIconOf('catalog.category', inlineIcons) ?? categoryIconOf(categoryId, icons).before")],
     U_CIC, 'the premium icon is'),
    ('P2C-10', [(IB, "    categoryIconOf(categoryId, icons).before ?? inlineButtonIconOf('catalog.category', inlineIcons)",
                 "    inlineButtonIconOf('catalog.category', inlineIcons) ?? categoryIconOf(categoryId, icons).before")],
     U_TCI, 'own icon wins over the generic'),
    ('P2C-11', [(IB, '  return after === null ? label : `${label} ${after}`;', '  return label;')],
     U_CIC, 'the text gains'),
    ('P2C-12', [(IB, '): { readonly before: string | null; readonly after: string | null } {\n  const id = categoryId.toLowerCase();',
                 '): { readonly before: string | null; readonly after: string | null } {\n  const id = categoryId;')],
     U_CIC, 'reads an id however it is cased'),
    # --- the messenger: what reaches the wire -----------------------------------------------
    ('P2C-13', [(MS, '            ? iconsAllowed\n', '            ? true\n')],
     U_TCI, 'an INELIGIBLE bot'),
    ('P2C-14', [(MS, '            ? iconsAllowed\n', '            ? true\n')],
     I_OF, 'an INELIGIBLE bot draws no premium icon'),
    ('P2C-15', [(MS, '          : categoryButtonText(label, categoryIconOf(category, categoryIcons).after);',
                 '          : label;')],
     U_TCI, 'AFTER only|BOTH'),
    ('P2C-16', [(MS, '          : categoryButtonText(label, categoryIconOf(category, categoryIcons).after);',
                 '          : label;')],
     I_OF, 'draws the premium icon before and the emoji after|an INELIGIBLE bot'),
    ('P2C-17', [(MS, '              ? categoryButtonIconOf(category, categoryIcons, icons)',
                 '              ? inlineButtonIconOf(button.inline, icons)')],
     U_TCI, 'BEFORE only|BOTH|own icon wins'),
    ('P2C-18', [(MS, '    const categoryIcons: CategoryIcons =\n      this.inlineStyles?.categoryIconsFor !== undefined &&\n      buttons.some((button) => categoryOf(button) !== undefined)',
                 '    const categoryIcons: CategoryIcons =\n      this.inlineStyles?.categoryIconsFor !== undefined')],
     U_TCI, 'never reads the decorations'),
    ('P2C-19', [(CT, '      categoryIconsFor: (scope) =>', '      categoryIconsForRetired: (scope) =>')],
     I_OF, 'draws the premium icon before and the emoji after|a refused icon is sent once more'),
    # --- the Web Admin -----------------------------------------------------------------------
    ('P2C-20', [(WCI, '    if (icon.before !== undefined && !CUSTOM_EMOJI_ID_PATTERN.test(icon.before)) {',
                 '    if (icon.before === "\\u0000") {')],
     W_CI, 'refuses an invalid id before saving|names each invalid field'),
    ('P2C-21', [(WCI, '    if (icon.after !== undefined && !isValidCategoryAfterEmoji(icon.after)) {',
                 '    if (icon.after === "\\u0000") {')],
     W_CI, 'refuses markup|names each invalid field'),
    ('P2C-22', [(WCI, '                !(unsaved || invalid) || bad.length > 0 || save.isPending || setting === undefined',
                 '                !(unsaved || invalid) || save.isPending || setting === undefined')],
     W_CI, 'refuses an invalid id before saving|refuses markup'),
    ('P2C-23', [(WCI, '                        {icon !== null && (\n', '                        {false && (\n')],
     W_CI, 'shows stored before/after|adds both'),
    ('P2C-24', [(WCI, '                  categoryIconOf(category.id, shownIcons).after,', '                  null,')],
     W_CI, 'shows stored before/after|adds both'),
    ('P2C-25', [(WCI, "                  ...(own?.after === undefined || isBad(category.id, 'after')",
                 "                  ...(own?.after === undefined")],
     W_CI, 'never previews it'),
    ('P2C-26', [(WCI, '                  expectedVersion: draft === null ? basisVersion : draft.basisVersion,',
                 '                  expectedVersion: null,')],
     W_CI, 'adds both|repairs an unreadable'),
    ('P2C-27', [(WCI, "            onClick={() => edit(category.id, which, '')}", '            onClick={() => undefined}')],
     W_CI, 'adds both'),
    ('P2C-28', [(WCI, "    if (before === '' && after === '') continue;\n", '')],
     W_CI, 'canonicalises'),
    ('P2C-29', [(WCI, '          disabled={!mayEdit || save.isPending}', '          disabled={save.isPending}')],
     W_CI, 'offers no change without settings.edit'),
    ('P2C-30', [(WPC, '            {maySettingsView && (', '            {true && (')],
     W_CI, 'offers no change without settings.edit'),
    # --- review of #217: each combining code point only where it belongs ---------------------
    ('P2C-31', [(IB, "const TAG_FLAG = String.raw`\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F}`;",
                 "const TAG_FLAG = String.raw`\\p{Extended_Pictographic}[\\u{E0020}-\\u{E007F}]+`;")],
     U_CIC, 'only where it belongs'),
    ('P2C-32', [(IB, "const KEYCAP = String.raw`[#*0-9]\\uFE0F?\\u20E3`;",
                 "const KEYCAP = String.raw`[#*0-9]?\\uFE0F?\\u20E3`;")],
     U_CIC, 'only where it belongs'),
    ('P2C-33', [(IB, "const PICTOGRAPH = String.raw`\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?`;",
                 "const PICTOGRAPH = String.raw`\\p{Extended_Pictographic}?\\uFE0F?\\p{Emoji_Modifier}?`;")],
     U_CIC, 'only where it belongs|refuses bidi'),
    ('P2C-34', [(IB, "const FLAG = String.raw`\\p{Regional_Indicator}{2}`;",
                 "const FLAG = String.raw`\\p{Regional_Indicator}{1,2}`;")],
     U_CIC, 'only where it belongs'),
    ('P2C-35', [(IB, "  String.raw`^(?:${KEYCAP}|${TAG_FLAG}|${FLAG}|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*)+$`,",
                 "  String.raw`^(?:${KEYCAP}|${TAG_FLAG}|${FLAG}|[\\u200C\\u200E\\u202E\\u2066]|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*)+$`,")],
     U_CIC, 'refuses bidi'),
    # --- review of #217: the value's bound and key ---------------------------------------------
    ('P2C-36', [(IB, "  .refine((value) => Object.keys(value).length <= CATEGORY_COLORS_MAX, {\n    message: `at most ${String(CATEGORY_COLORS_MAX)} categories carry their own icons`,",
                 "  .refine(() => true, {\n    message: `at most ${String(CATEGORY_COLORS_MAX)} categories carry their own icons`,")],
     U_CIC, 'is bounded'),
    ('P2C-37', [(IB, "    z.string().regex(CATEGORY_COLOR_KEY_PATTERN, { message: 'a category id in lower case' }),\n    categoryIconSchema,",
                 "    z.string(),\n    categoryIconSchema,")],
     U_CIC, 'refuses an entry with neither, an unknown field, a name or an upper-case id'),
    # --- review of #217: a refused category icon names its categories ----------------------------
    ('P2C-38', [(MS, '        ownIconCategories.push(category);\n', '')],
     U_TCI, 'a custom-emoji DENIAL'),
    ('P2C-39', [(MS, '        category !== undefined &&\n        categoryIconOf(category, categoryIcons).before !== null\n',
                 '        category !== undefined\n')],
     U_TCI, 'GENERIC category icon names no category'),
    ('P2C-40', [(MS, "              ? ' Product categories\\u2019 own icons (bot.category_icons) were among them.'",
                 "              ? ''")],
     U_TCI, 'a custom-emoji DENIAL'),
]


def build_contracts() -> None:
    subprocess.run(['pnpm', '--filter', '@nexa/contracts', 'build'], capture_output=True, check=True)


only = sys.argv[1:]
killed = 0
ran = 0
kills = 0
survivors = []
for mid, edits, (project, test), filt in M:
    if only and mid not in only:
        continue
    originals = {}
    ok = True
    contracts = any(f.startswith('packages/contracts/') for f, _, _ in edits)
    try:
        # Write -> run -> restore: the restore is in `finally`, so an interrupted run or a
        # failing subprocess never leaves a mutant in the tree.
        for f, a, b in edits:
            cur = open(f, encoding='utf-8').read()
            originals.setdefault(f, cur)
            if cur.count(a) != 1:
                print(mid, 'ANCHOR MISSING in', f, cur.count(a), flush=True)
                ok = False
                break
            open(f, 'w', encoding='utf-8').write(cur.replace(a, b))
        if ok:
            if contracts:
                build_contracts()
            ran += 1
            r = subprocess.run(
                ['pnpm', 'exec', 'vitest', 'run', '--project', project, test, '-t', filt],
                capture_output=True, text=True,
            )
            out = r.stdout + r.stderr
            failed = [line.strip() for line in out.splitlines() if '×' in line]
            summ = [line.strip() for line in out.splitlines() if 'Tests ' in line]
            ran_any = any('passed' in line or 'failed' in line for line in summ)
            dead = r.returncode != 0 and ran_any and len(failed) > 0
            if dead:
                killed += 1
                kills += len(failed)
            else:
                survivors.append(mid)
            print(mid, 'KILLED' if dead else 'SURVIVED', summ, failed, flush=True)
    finally:
        for f, s in originals.items():
            open(f, 'w', encoding='utf-8').write(s)
        if contracts and originals:
            build_contracts()
print(f'{killed} of {ran} mutants killed ({kills} failing tests in all); survivors: {survivors}',
      flush=True)
