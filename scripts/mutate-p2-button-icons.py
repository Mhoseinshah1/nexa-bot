"""Phase 2 UX wave, Items 1 and 3 (button layout, premium button icons) mutation driver.

Record: docs/phase2/button-icons-falsification.md.

Reverts one rule at a time, runs the named tests, and restores the file from the copy it read.
A mutant of `packages/contracts` rebuilds the package (tests import its `dist`) before the run
and again after the restore. Integration mutants need the database (`bash scripts/dev-services.sh`);
point TEST_DATABASE_URL and DATABASE_URL at a database of your own if another suite is running.
A mutant counts as KILLED only when the run executed tests and at least one FAILED.

Usage: python3 scripts/mutate-p2-button-icons.py [P2I-01 ...]
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages']).returncode != 0:
    sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

BMB = 'packages/contracts/src/bot-menu-builder.ts'
IB = 'packages/contracts/src/inline-buttons.ts'
MM = 'apps/api/src/modules/commerce/messaging/application/main-menu.ts'
AR = 'apps/api/src/modules/commerce/messaging/application/appearance-render.ts'
SM = 'apps/api/src/infrastructure/telegram/send-message.ts'
MS = 'apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts'
CT = 'apps/api/src/container.ts'
WIB = 'apps/web/src/pages/bot-buttons/inline-buttons.tsx'
WMD = 'apps/web/src/pages/bot-buttons/model.ts'
WCV = 'apps/web/src/pages/bot-buttons/canvas.tsx'
WIN = 'apps/web/src/pages/bot-buttons/inspector.tsx'

U_ICONS = ('unit', 'tests/unit/telegram-inline-button-icons.test.ts')
U_BMB = ('unit', 'tests/unit/bot-menu-builder-contracts.test.ts')
U_IBC = ('unit', 'tests/unit/inline-buttons-contract.test.ts')
U_MML = ('unit', 'tests/unit/main-menu-layout.test.ts')
I_RK = ('integration', 'tests/integration/telegram-reply-keyboard.test.ts')
I_BMB = ('integration', 'tests/integration/bot-menu-builder.test.ts')
W_IB = ('web', 'tests/web/inline-buttons.test.tsx')
W_BB = ('web', 'tests/web/bot-buttons-builder.test.tsx')

M = [
    # --- Item 3, main menu: the retirement lifted ------------------------------------------
    ('P2I-01', [(BMB, '        iconSlot: config.iconSlot,\n        appearanceSlot:',
                 '        iconSlot: null,\n        appearanceSlot:')],
     U_BMB, 'keeps every icon through normalisation|an icon alone IS a change'),
    ('P2I-02', [(BMB, 'drawn.push({ button: id, style: config.style, iconSlot: config.iconSlot });',
                 'drawn.push({ button: id, style: config.style, iconSlot: null });')],
     U_BMB, 'draws the icon slot beside the style'),
    ('P2I-03', [(MM, '              iconSlot: one.iconSlot,', '              iconSlot: null,')],
     U_MML, 'icon slot \\(restored|Item 1'),
    ('P2I-04', [(MM, '              iconSlot: one.iconSlot,', '              iconSlot: null,')],
     I_RK, 'icon only from the bot that proved eligibility|R-4'),
    # --- Item 1: the saved order is the drawn order ---------------------------------------
    ('P2I-05', [(BMB, '  for (const row of layout.rows) {\n    const drawn: CustomerMainMenuButton[] = [];',
                 '  for (const row of [...layout.rows].reverse()) {\n    const drawn: CustomerMainMenuButton[] = [];')],
     U_MML, 'Item 1'),
    ('P2I-06', [(BMB, '    if (drawn.length > 0) rows.push(drawn);', '    rows.push(drawn);')],
     U_MML, 'Item 1'),
    # --- Item 3, inline: the transport -----------------------------------------------------
    ('P2I-07', [(SM, '      cell.icon_custom_emoji_id = button.iconCustomEmojiId;\n    }\n    const existing',
                 '    }\n    const existing')],
     U_ICONS, 'writes icon_custom_emoji_id'),
    ('P2I-08', [(SM, "    if (button.iconCustomEmojiId !== undefined && button.iconCustomEmojiId !== '') {\n      cell.icon_custom_emoji_id",
                 "    if (button.iconCustomEmojiId !== undefined) {\n      cell.icon_custom_emoji_id")],
     U_ICONS, 'never sends an empty icon'),
    ('P2I-09', [(SM, '    if (button.iconCustomEmojiId === undefined) return button;',
                 '    return button;')],
     U_ICONS, 'withoutButtonIcons drops|a custom-emoji DENIAL'),
    # --- Item 3, inline: eligibility -------------------------------------------------------
    ('P2I-10', [(MS, '      namesRegistryButton &&\n      mayCarryCustomEmoji(decoration)',
                 '      namesRegistryButton')],
     U_ICONS, 'never tested'),
    ('P2I-11', [(MS, '      namesRegistryButton &&\n      mayCarryCustomEmoji(decoration)',
                 '      namesRegistryButton')],
     I_RK, 'eligible bot only'),
    ('P2I-12', [(AR, '  return decoration.eligible ?? decoration.customEmoji.size > 0;',
                 '  return true;')],
     U_ICONS, 'reads eligibility from the decoration|never tested'),
    # --- Item 3, inline: the one icon-less retry -------------------------------------------
    ('P2I-13', [(MS, '      const iconed = last && (keyboardHasIcon || inlineHasIcon) && !decorationRefused;',
                 '      const iconed = last && keyboardHasIcon && !decorationRefused;')],
     U_ICONS, 'a custom-emoji DENIAL|a GENERIC 400'),
    ('P2I-14', [(MS, '                  buttons: plain || decorationRefused ? plainButtons : buttons,',
                 '                  buttons,')],
     U_ICONS, 'a custom-emoji DENIAL|a GENERIC 400'),
    ('P2I-15', [(MS, '    const iconed = buttonsHaveIcons(buttons);\n    const plainText',
                 '    const iconed = false && buttonsHaveIcons(buttons);\n    const plainText')],
     U_ICONS, 'an EDIT in place'),
    ('P2I-16', [(MS, '    const iconed = buttonsHaveIcons(buttons);\n    const plainCaption',
                 '    const iconed = false && buttonsHaveIcons(buttons);\n    const plainCaption')],
     U_ICONS, 'a caption EDIT'),
    ('P2I-17', [(MS, '    const iconed = buttonsHaveIcons(buttons);\n\n    const method =',
                 '    const iconed = false && buttonsHaveIcons(buttons);\n\n    const method =')],
     U_ICONS, 'a FILE sent by file_id'),
    ('P2I-18', [(MS, '        buttons: plain ? withoutButtonIcons(buttons) : buttons,\n      };\n    };',
                 '        buttons,\n      };\n    };')],
     U_ICONS, 'a FILE sent by file_id'),
    ('P2I-19', [(MS, '    const denied = !iconed || isCustomEmojiDenial(first.errorMessage);',
                 '    const denied = true;')],
     U_ICONS, 'a GENERIC 400'),
    # --- Item 3, inline: the setting --------------------------------------------------------
    ('P2I-20', [(CT, '      iconsFor: (scope) =>', '      iconsForRetired: (scope) =>')],
     I_RK, 'eligible bot only|a removed icon|custom-emoji denial of an iconed inline'),
    ('P2I-21', [(IB, '  z.enum(INLINE_BUTTON_KEYS),\n  customEmojiIdSchema,\n);',
                 '  z.enum(INLINE_BUTTON_KEYS),\n  z.string(),\n);')],
     U_IBC, 'refuses an unknown button and anything'),
    ('P2I-22', [(IB, '  z.enum(INLINE_BUTTON_KEYS),\n  customEmojiIdSchema,\n);',
                 '  z.enum(INLINE_BUTTON_KEYS),\n  z.string(),\n);')],
     I_RK, 'refuses an id that is not digits'),
    ('P2I-23', [(IB, "  return icon === undefined || icon === '' ? null : icon;", '  return null;')],
     U_IBC, 'resolves an icon'),
    # --- Web ---------------------------------------------------------------------------------
    ('P2I-24', [(WIB, "    .filter(([, icon]) => !CUSTOM_EMOJI_ID_PATTERN.test(icon))",
                 "    .filter(([, icon]) => icon === '\\u0000')")],
     W_IB, 'refuses to save an id that is not digits|canonicalIcons'),
    ('P2I-25', [(WIB, '                    stylesUnsaved || invalid\n',
                 '                    true\n')],
     W_IB, 'no style write'),
    ('P2I-26', [(WIB, '                            draft === null ? iconsBasisVersion : draft.iconsBasisVersion,',
                 '                            draft === null ? basisVersion : draft.basisVersion,')],
     W_IB, 'ITS version|removes an icon'),
    ('P2I-27', [(WIB, "        idempotencyKey: `${command.idempotencyKey}-icons`,",
                 "        idempotencyKey: `${command.idempotencyKey}-styles`,")],
     W_IB, 'two writes, each with its own version and key'),
    ('P2I-28', [(WMD, '  return withConfig(layout, id, { iconSlot });', '  return layout;')],
     W_BB, 'chooses an icon slot'),
    ('P2I-29', [(WCV, '              {one.iconSlot !== null && <IconMark slot={one.iconSlot} />}',
                 '              {false && <IconMark slot={one.iconSlot as never} />}')],
     W_BB, 'live keyboard with the published|chooses an icon slot'),
    ('P2I-30', [(WMD, "    if (ca.iconSlot !== cb.iconSlot) changes.push('icon');", '')],
     W_BB, 'icon-only change'),
    ('P2I-31', [(WIN, "        {config.iconSlot !== null && startsWithEmoji(label) && (",
                 "        {false && startsWithEmoji(label) && (")],
     W_BB, '#8 warns'),
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
