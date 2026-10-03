import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  criticalPermissionChanges,
  dependentsOf,
  holdsCriticalPermission,
  IDENTITY_ERROR_CODES,
  PERMISSION_DOMAINS,
  PERMISSIONS,
  prerequisiteOf,
  roleKeySchema,
  withPrerequisites,
  type EffectivePermissionsResponse,
  type PermissionKey,
  type RiskLevel,
  type RoleView,
} from '@nexa/contracts';
import {
  ApiError,
  createRole,
  deleteRole,
  fetchAdmins,
  fetchEffectivePermissions,
  fetchManagedRoles,
  updateRole,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { PERMISSION_DOMAIN_LABELS, PERMISSION_LABELS } from '../rbac-labels';
import { useSubmissionKey } from '../submission-key';
import { Badge, Banner, Card, Drawer, Field, Ltr, Modal, StateSwitch, useToast } from '../ui/kit';
import { useConfirmedClose } from '../ui/unsaved';
import { Icon } from '../ui/icons';

/**
 * System → Roles (Phase D3, program §18): the permission-management UI over the
 * EXISTING authorization model. Nothing here decides anything — the server checks who
 * may edit roles, keeps the owner role immutable, refuses an incoherent set or one the
 * actor could not grant, demands the typed key for a CRITICAL change, and refuses a
 * stale edit. This page makes those rules visible before the request, so an operator is
 * told why rather than refused.
 *
 * The matrix's dependency behaviour is the contract's (`PERMISSION_REQUIRES`): selecting
 * an action pulls in the read it needs; removing a read also removes the actions that
 * need it, and says so. The effective-permission preview is the SERVER's answer — the
 * same resolver the guard uses — never recomputed here.
 */

const RISK_TONE: Record<RiskLevel, 'neutral' | 'info' | 'warn' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warn',
  CRITICAL: 'danger',
};
const RISK_LABEL: Record<RiskLevel, WebKey> = {
  LOW: 'web.rbac_risk_low',
  MEDIUM: 'web.rbac_risk_medium',
  HIGH: 'web.rbac_risk_high',
  CRITICAL: 'web.rbac_risk_critical',
};

const RISK_OF = new Map<string, RiskLevel>(PERMISSIONS.map((one) => [one.key, one.riskLevel]));

function riskOf(key: string): RiskLevel {
  return RISK_OF.get(key) ?? 'LOW';
}

function labelOf(key: string): string {
  const label = (PERMISSION_LABELS as Record<string, WebKey | undefined>)[key];
  return label === undefined ? key : t(label);
}

function domainLabel(domain: string): string {
  const label = PERMISSION_DOMAIN_LABELS[domain];
  return label === undefined ? domain : t(label);
}

/** The server's refusal, in this page's words. */
/**
 * After any role write: the role list, the assignment picker's catalogue, every cached
 * effective-permission preview, and the shell's own session — whose permissions decide
 * what chrome this operator is drawn if the edit touched a role they hold
 * (Codex 4173474771).
 */
function afterRoleWrite(queries: ReturnType<typeof useQueryClient>): void {
  void queries.invalidateQueries({ queryKey: ['managed-roles'] });
  void queries.invalidateQueries({ queryKey: ['roles'] });
  void queries.invalidateQueries({ queryKey: ['effective-permissions'] });
  void queries.invalidateQueries({ queryKey: ['session'] });
}

function roleMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const known: Record<string, WebKey> = {
      [IDENTITY_ERROR_CODES.ROLE_KEY_TAKEN]: 'web.rbac_error_key_taken',
      [IDENTITY_ERROR_CODES.ROLE_IMMUTABLE]: 'web.rbac_error_immutable',
      [IDENTITY_ERROR_CODES.ROLE_IN_USE]: 'web.rbac_error_in_use',
      [IDENTITY_ERROR_CODES.ROLE_PERMISSIONS_INCOHERENT]: 'web.rbac_error_incoherent',
      [IDENTITY_ERROR_CODES.ROLE_UNKNOWN_PERMISSION]: 'web.rbac_error_unknown',
      [IDENTITY_ERROR_CODES.ROLE_VERSION_CONFLICT]: 'web.rbac_error_version',
      [IDENTITY_ERROR_CODES.ROLE_CONFIRMATION_REQUIRED]: 'web.rbac_error_confirmation',
      [IDENTITY_ERROR_CODES.ADMIN_PRIVILEGE_ESCALATION]: 'web.admin_privilege_escalation',
    };
    const key = known[error.code];
    return key === undefined ? error.message : t(key);
  }
  return t('web.error');
}

type Editing =
  | { readonly mode: 'create' }
  | { readonly mode: 'edit'; readonly role: RoleView }
  | { readonly mode: 'clone'; readonly role: RoleView };

export function RolesSection({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const roles = useQuery({
    queryKey: ['managed-roles'],
    queryFn: fetchManagedRoles,
    enabled: !denied,
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<RoleView | null>(null);
  const list = roles.data?.roles ?? [];

  return (
    <div className="stack rbac">
      <Card
        title={t('web.rbac_roles_title')}
        hint={t('web.rbac_roles_hint')}
        actions={
          mayEdit && !denied ? (
            <button
              type="button"
              className="btn primary sm"
              onClick={() => setEditing({ mode: 'create' })}
            >
              <Icon name="plus" />
              {t('web.rbac_new_role')}
            </button>
          ) : undefined
        }
      >
        <StateSwitch query={roles} denied={denied} isEmpty={list.length === 0}>
          <ul className="rbac-roles">
            {list.map((role) => (
              <RoleRow
                key={role.key}
                role={role}
                mayEdit={mayEdit}
                onEdit={() => setEditing({ mode: 'edit', role })}
                onClone={() => setEditing({ mode: 'clone', role })}
                onDelete={() => setDeleting(role)}
              />
            ))}
          </ul>
        </StateSwitch>
      </Card>

      {!denied && <EffectivePreview />}

      {editing !== null && (
        <RoleEditor editing={editing} existing={list} onClose={() => setEditing(null)} />
      )}
      {deleting !== null && <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function RoleRow({
  role,
  mayEdit,
  onEdit,
  onClone,
  onDelete,
}: {
  role: RoleView;
  mayEdit: boolean;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
}) {
  const critical = role.permissions.filter((key) => riskOf(key) === 'CRITICAL').length;
  return (
    <li className="rbac-role">
      <div className="row-inline">
        <strong>{role.name}</strong>
        <Ltr>{role.key}</Ltr>
        {role.immutable ? (
          <Badge tone="violet">{t('web.rbac_immutable')}</Badge>
        ) : role.isSystem ? (
          <Badge tone="info">{t('web.rbac_system')}</Badge>
        ) : (
          <Badge tone="neutral">{t('web.rbac_custom')}</Badge>
        )}
      </div>
      <div className="muted small">
        {t('web.rbac_permission_count').replace('{count}', String(role.permissions.length))}
        {critical > 0 && (
          <>
            {' · '}
            <span className="danger">
              {t('web.rbac_critical_count').replace('{count}', String(critical))}
            </span>
          </>
        )}
      </div>
      <div className="muted small">
        {t('web.rbac_holders')}:{' '}
        {role.assignedAdmins.length === 0
          ? t('web.rbac_no_holders')
          : role.assignedAdmins.map((admin) => admin.displayName).join(t('web.list_separator'))}
      </div>
      {mayEdit && (
        <div className="btn-group">
          {!role.immutable && (
            <button type="button" className="btn sm" onClick={onEdit}>
              <Icon name="edit" />
              {t('web.rbac_edit')}
            </button>
          )}
          <button type="button" className="btn ghost sm" onClick={onClone}>
            <Icon name="copy" />
            {t('web.rbac_clone')}
          </button>
          {!role.isSystem && (
            <button
              type="button"
              className="btn danger sm"
              disabled={role.assignedAdmins.length > 0}
              title={role.assignedAdmins.length > 0 ? t('web.rbac_error_in_use') : undefined}
              onClick={onDelete}
            >
              <Icon name="trash" />
              {t('web.rbac_delete')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The permission matrix: one group per domain, searchable, every risk visible. Selecting
 * an action adds the read it needs; removing a read removes the actions that need it,
 * and the editor says which.
 */
function PermissionMatrix({
  selected,
  onChange,
  onNotice,
}: {
  selected: readonly PermissionKey[];
  onChange: (next: PermissionKey[]) => void;
  onNotice: (notice: string | null) => void;
}) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const visible = PERMISSIONS.filter(
    (one) =>
      needle === '' ||
      one.key.toLowerCase().includes(needle) ||
      labelOf(one.key).toLowerCase().includes(needle) ||
      domainLabel(one.resource).toLowerCase().includes(needle),
  );

  const toggle = (key: PermissionKey, on: boolean) => {
    if (on) {
      const next = withPrerequisites([...selected, key]);
      const pulled = next.filter((one) => !selected.includes(one) && one !== key);
      onNotice(
        pulled.length === 0
          ? null
          : t('web.rbac_pulled_prerequisite')
              .replace('{permission}', labelOf(key))
              .replace('{requires}', pulled.map(labelOf).join(t('web.list_separator'))),
      );
      onChange(next);
      return;
    }
    const dependents = dependentsOf(key).filter((one) => selected.includes(one));
    onNotice(
      dependents.length === 0
        ? null
        : t('web.rbac_removed_dependents')
            .replace('{permission}', labelOf(key))
            .replace('{dependents}', dependents.map(labelOf).join(t('web.list_separator'))),
    );
    onChange(selected.filter((one) => one !== key && !dependents.includes(one)));
  };

  return (
    <div className="stack">
      <Field label={t('web.rbac_search')} htmlFor="rbac-search">
        <input
          id="rbac-search"
          className="input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Field>
      {PERMISSION_DOMAINS.map((domain) => {
        const rows = visible.filter((one) => one.resource === domain);
        if (rows.length === 0) return null;
        const held = rows.filter((one) => selected.includes(one.key as PermissionKey)).length;
        return (
          <fieldset key={domain} className="rbac-domain">
            <legend>
              {domainLabel(domain)}{' '}
              <span className="faint small">
                {held}/{rows.length}
              </span>
            </legend>
            {rows.map((one) => {
              const key = one.key as PermissionKey;
              const id = `rbac-perm-${key.replace(/\./g, '-')}`;
              const requires = prerequisiteOf(key);
              return (
                <label
                  key={key}
                  htmlFor={id}
                  className={`checkbox rbac-perm risk-${one.riskLevel.toLowerCase()}`}
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={selected.includes(key)}
                    onChange={(event) => toggle(key, event.target.checked)}
                  />
                  <span className="rbac-perm-text">
                    <span>{labelOf(key)}</span>
                    <Ltr>{key}</Ltr>
                    {requires !== null && (
                      <span className="faint small">
                        {t('web.rbac_requires').replace('{requires}', labelOf(requires))}
                      </span>
                    )}
                  </span>
                  {one.riskLevel !== 'LOW' && (
                    <Badge tone={RISK_TONE[one.riskLevel]}>{t(RISK_LABEL[one.riskLevel])}</Badge>
                  )}
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}

function RoleEditor({
  editing,
  existing,
  onClose,
}: {
  editing: Editing;
  existing: readonly RoleView[];
  onClose: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const source = editing.mode === 'create' ? null : editing.role;
  const [key, setKey] = useState(
    editing.mode === 'edit'
      ? editing.role.key
      : editing.mode === 'clone'
        ? `${editing.role.key}_copy`
        : '',
  );
  const [name, setName] = useState(
    editing.mode === 'edit'
      ? editing.role.name
      : editing.mode === 'clone'
        ? `${editing.role.name} ${t('web.rbac_copy_suffix')}`
        : '',
  );
  const [permissions, setPermissions] = useState<PermissionKey[]>(
    source === null ? [] : (source.permissions as PermissionKey[]),
  );
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const before = editing.mode === 'edit' ? editing.role.permissions : [];
  const critical = useMemo(
    () => criticalPermissionChanges(before, permissions),
    [before, permissions],
  );
  const keyValid = editing.mode === 'edit' || roleKeySchema.safeParse(key).success;
  const keyTaken = editing.mode !== 'edit' && existing.some((role) => role.key === key);
  const confirmed = critical.length === 0 || confirmation.trim() === key;
  const dirty =
    editing.mode !== 'edit' ||
    name !== editing.role.name ||
    permissions.join(',') !== [...editing.role.permissions].sort().join(',');

  const save = useMutation({
    retry: false,
    mutationFn: () => {
      const body = {
        name: name.trim(),
        permissions: [...permissions].sort(),
        reason: reason.trim(),
        ...(critical.length > 0 ? { confirmation: confirmation.trim() } : {}),
      };
      if (editing.mode === 'edit') {
        // The version the edit was MADE FROM, never re-read: a stale edit is refused.
        const payload = { ...body, key, expectedVersion: editing.role.version };
        return updateRole({ ...payload, idempotencyKey: submission.current(payload) });
      }
      const payload = {
        ...body,
        key,
        ...(editing.mode === 'clone' ? { clonedFrom: editing.role.key } : {}),
      };
      return createRole({ ...payload, idempotencyKey: submission.current(payload) });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.rbac_saved') });
      afterRoleWrite(queries);
      onClose();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      // A stale version (Codex 4173474772): the open copy is out of date, so the list is
      // re-read — the operator re-opens the CURRENT role instead of retrying the old one.
      if (error instanceof ApiError && error.code === IDENTITY_ERROR_CODES.ROLE_VERSION_CONFLICT) {
        void queries.invalidateQueries({ queryKey: ['managed-roles'] });
      }
    },
  });

  const { requestClose, dialog } = useConfirmedClose(dirty && !save.isSuccess, onClose);
  const title =
    editing.mode === 'create'
      ? t('web.rbac_new_role')
      : editing.mode === 'clone'
        ? t('web.rbac_clone_title').replace('{role}', editing.role.name)
        : t('web.rbac_edit_title').replace('{role}', editing.role.name);

  return (
    <>
      <Drawer open onClose={requestClose} wide title={title}>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {editing.mode === 'edit' && editing.role.isSystem && (
            <Banner tone="info">{t('web.rbac_system_edit_hint')}</Banner>
          )}
          <Field
            label={t('web.rbac_key')}
            hint={t('web.rbac_key_hint')}
            htmlFor="rbac-key"
            {...(keyTaken ? { error: t('web.rbac_error_key_taken') } : {})}
          >
            <input
              id="rbac-key"
              className="input"
              dir="ltr"
              value={key}
              disabled={editing.mode === 'edit'}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <Field label={t('web.rbac_name')} htmlFor="rbac-name">
            <input
              id="rbac-name"
              className="input"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <PermissionMatrix selected={permissions} onChange={setPermissions} onNotice={setNotice} />
          {notice !== null && <Banner tone="warn">{notice}</Banner>}

          {critical.length > 0 && (
            <div className="inset danger-zone stack">
              <strong>{t('web.rbac_critical_title')}</strong>
              <ul className="small">
                {critical.map((one) => (
                  <li key={one}>
                    {labelOf(one)} <Ltr>{one}</Ltr>
                  </li>
                ))}
              </ul>
              <Field
                label={t('web.rbac_confirm_label').replace('{key}', key)}
                htmlFor="rbac-confirm"
              >
                <input
                  id="rbac-confirm"
                  className="input"
                  dir="ltr"
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
            </div>
          )}

          <Field
            label={t('web.admin_reason_label')}
            hint={t('web.admin_reason_hint')}
            htmlFor="rbac-reason"
          >
            <input
              id="rbac-reason"
              className="input"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {save.isError && <Banner tone="danger">{roleMessage(save.error)}</Banner>}
          <div className="btn-group">
            <button
              type="submit"
              className="btn primary"
              disabled={
                save.isPending ||
                !keyValid ||
                keyTaken ||
                name.trim() === '' ||
                reason.trim() === '' ||
                !confirmed ||
                !dirty
              }
            >
              {t('web.rbac_save')}
            </button>
            <button type="button" className="btn ghost" onClick={requestClose}>
              {t('web.account_cancel')}
            </button>
          </div>
        </form>
      </Drawer>
      {dialog}
    </>
  );
}

function DeleteRoleDialog({ role, onClose }: { role: RoleView; onClose: () => void }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const critical = holdsCriticalPermission(role.permissions);
  const remove = useMutation({
    retry: false,
    mutationFn: () => {
      const payload = {
        key: role.key,
        expectedVersion: role.version,
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      };
      return deleteRole({ ...payload, idempotencyKey: submission.current(payload) });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.rbac_deleted') });
      afterRoleWrite(queries);
      onClose();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      // A stale version (Codex 4173474772): the open copy is out of date, so the list is
      // re-read — the operator re-opens the CURRENT role instead of retrying the old one.
      if (error instanceof ApiError && error.code === IDENTITY_ERROR_CODES.ROLE_VERSION_CONFLICT) {
        void queries.invalidateQueries({ queryKey: ['managed-roles'] });
      }
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      danger
      title={t('web.rbac_delete_title').replace('{role}', role.name)}
    >
      <div className="stack">
        <p>{t('web.rbac_delete_question')}</p>
        {critical && <Banner tone="warn">{t('web.rbac_delete_critical')}</Banner>}
        <Field
          label={t('web.rbac_confirm_label').replace('{key}', role.key)}
          htmlFor="rbac-delete-confirm"
        >
          <input
            id="rbac-delete-confirm"
            className="input"
            dir="ltr"
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </Field>
        <Field label={t('web.admin_reason_label')} htmlFor="rbac-delete-reason">
          <input
            id="rbac-delete-reason"
            className="input"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {remove.isError && <Banner tone="danger">{roleMessage(remove.error)}</Banner>}
        <div className="btn-group">
          <button
            type="button"
            className="btn danger"
            disabled={remove.isPending || reason.trim() === '' || confirmation.trim() !== role.key}
            onClick={() => remove.mutate()}
          >
            {t('web.rbac_delete')}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('web.account_cancel')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * One administrator's effective permissions, as the SERVER resolves them — and why a
 * permission their roles grant is missing: a DENY override, a read the action needs, or
 * an account that is disabled.
 */
function EffectivePreview() {
  const admins = useQuery({ queryKey: ['admins'], queryFn: fetchAdmins });
  const [adminId, setAdminId] = useState('');
  const preview = useQuery({
    queryKey: ['effective-permissions', adminId],
    queryFn: () => fetchEffectivePermissions(adminId),
    enabled: adminId !== '',
  });
  return (
    <Card title={t('web.rbac_preview_title')} hint={t('web.rbac_preview_hint')}>
      <Field label={t('web.rbac_preview_admin')} htmlFor="rbac-preview-admin">
        <select
          id="rbac-preview-admin"
          className="input"
          value={adminId}
          onChange={(event) => setAdminId(event.target.value)}
        >
          <option value="">{t('web.rbac_preview_choose')}</option>
          {(admins.data?.admins ?? []).map((admin) => (
            <option key={admin.id} value={admin.id}>
              {admin.displayName} ({admin.username})
            </option>
          ))}
        </select>
      </Field>
      {adminId !== '' && (
        <StateSwitch query={preview}>
          {preview.data !== undefined && <EffectiveList data={preview.data} />}
        </StateSwitch>
      )}
    </Card>
  );
}

function EffectiveList({ data }: { data: EffectivePermissionsResponse }) {
  const effective = new Set(data.effective);
  const denied = new Set(
    data.overrides
      .filter((one) => one.active && one.effect === 'DENY')
      .map((one) => one.permissionKey),
  );
  const granted = new Set(
    data.overrides
      .filter((one) => one.active && one.effect === 'GRANT')
      .map((one) => one.permissionKey),
  );
  const candidates = [...new Set([...data.rolePermissions, ...granted])].sort();
  const missing = candidates.filter((key) => !effective.has(key));
  const why = (key: string): string => {
    if (!data.active) return t('web.rbac_why_disabled');
    if (denied.has(key)) return t('web.rbac_why_denied');
    const requires = prerequisiteOf(key);
    if (requires !== null && !effective.has(requires)) {
      return t('web.rbac_why_requires').replace('{requires}', labelOf(requires));
    }
    return t('web.rbac_why_other');
  };
  return (
    <div className="stack">
      {!data.active && <Banner tone="warn">{t('web.rbac_preview_disabled')}</Banner>}
      <div className="muted small">
        {t('web.rbac_preview_roles')}:{' '}
        {data.roles.map((role) => role.name).join(t('web.list_separator')) || '—'}
        {' · '}
        {t('web.rbac_permission_count').replace('{count}', String(data.effective.length))}
      </div>
      {PERMISSION_DOMAINS.map((domain) => {
        const rows = data.effective.filter((key) => key.split('.')[0] === domain);
        if (rows.length === 0) return null;
        return (
          <div key={domain} className="rbac-effective-domain">
            <strong>{domainLabel(domain)}</strong>
            <ul className="small">
              {rows.map((key) => (
                <li key={key}>
                  {labelOf(key)}
                  {granted.has(key) && !data.rolePermissions.includes(key) && (
                    <Badge tone="teal">{t('web.rbac_via_grant')}</Badge>
                  )}
                  {riskOf(key) === 'CRITICAL' && (
                    <Badge tone="danger">{t('web.rbac_risk_critical')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {data.overrides.length > 0 && (
        <div className="inset stack">
          {/* Every override the server returned, as returned (Codex 4173474768): an
              expired one, and a DENY on a permission no role grants, are still facts. */}
          <strong>{t('web.rbac_overrides_title')}</strong>
          <ul className="small rbac-overrides">
            {data.overrides.map((one) => (
              <li key={`${one.effect}:${one.permissionKey}`}>
                <Badge tone={one.effect === 'DENY' ? 'danger' : 'teal'}>
                  {one.effect === 'DENY'
                    ? t('web.rbac_override_deny')
                    : t('web.rbac_override_grant')}
                </Badge>{' '}
                {labelOf(one.permissionKey)} <Ltr>{one.permissionKey}</Ltr>
                {!one.active && <Badge tone="neutral">{t('web.rbac_override_expired')}</Badge>}
                <div className="muted">
                  {t('web.rbac_override_reason')}: {one.reason}
                  {' · '}
                  {one.expiresAt === null
                    ? t('web.rbac_override_no_expiry')
                    : `${t('web.rbac_override_expires')}: ${formatTimestamp(one.expiresAt)}`}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <div className="inset stack">
          <strong>{t('web.rbac_preview_missing')}</strong>
          <ul className="small">
            {missing.map((key) => (
              <li key={key}>
                {labelOf(key)} — <span className="muted">{why(key)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
