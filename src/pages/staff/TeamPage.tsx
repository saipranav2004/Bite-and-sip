import { useCallback, useEffect, useId, useState } from 'react'
import { backend } from '../../backend'
import { PageBody, PageHeader, Panel, SkeletonRows, TableScroll } from '../../components/admin'
import { IconCheck, IconCopy, IconKey, IconPlus } from '../../components/icons'
import { Banner, Button, Dialog, Switch, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { ago, dateTime } from '../../lib/format'
import type { StaffMember, StaffRole } from '../../lib/types'
import { STAFF_LOGIN_DOMAIN, toLoginEmail } from '../../lib/validation'
import { useStaffSession } from '../../state/staffSession'

/** Shows "ravi" for ravi@bite.local, otherwise the full email. */
export function loginName(email: string | null) {
  if (!email) return '—'
  return email.endsWith(`@${STAFF_LOGIN_DOMAIN}`) ? email.slice(0, -STAFF_LOGIN_DOMAIN.length - 1) : email
}

/** A readable password: two words, a number and a symbol (e.g. "Masala.Tiger.47"). */
export function suggestPassword() {
  const words = ['Masala', 'Chai', 'Samosa', 'Tiger', 'Mango', 'Lemon', 'Pepper', 'Cocoa', 'Ginger', 'Biscuit', 'Paneer', 'Rocket', 'Monsoon', 'Cumin']
  const r = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n
  return `${words[r(words.length)]}.${words[r(words.length)]}.${10 + r(90)}`
}

const ROLES: { value: StaffRole; label: string; can: string; cannot: string }[] = [
  { value: 'kitchen', label: 'Kitchen', can: 'Run the orders board, confirm payments, mark items sold out, update stock counts.', cannot: 'Cannot see sales or profit, change prices, the UPI ID or staff.' },
  { value: 'owner', label: 'Owner', can: 'Everything, including prices, costs, profit & loss, expenses, the audit log, settings and staff.', cannot: 'Give this only to people you trust with money.' },
]

export function TeamPage() {
  const { profile } = useStaffSession()
  const toast = useToast()
  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [resetting, setResetting] = useState<StaffMember | null>(null)
  const [removing, setRemoving] = useState<StaffMember | null>(null)

  const load = useCallback(async () => {
    try {
      setStaff(await backend.listStaff())
      setError(null)
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function update(m: StaffMember, patch: Partial<Pick<StaffMember, 'role' | 'is_active'>>, msg: string) {
    setBusy(m.user_id)
    try {
      await backend.updateStaff(m.user_id, patch)
      await load()
      toast(msg, 'success')
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setBusy(null)
      setRemoving(null)
    }
  }

  const active = (staff ?? []).filter((m) => m.is_active)

  return (
    <PageBody>
      <PageHeader
        title="Team"
        subtitle="Who can sign in to the staff console, and what they can do."
        actions={<Button size="sm" onClick={() => setAdding(true)}><IconPlus size={16} /> Add team member</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title="Members" description={staff ? `${active.length} with access` : undefined} flush>
          {error && <div className="p-4"><Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Banner></div>}
          {!staff ? (
            !error && <SkeletonRows rows={3} label="Loading team" />
          ) : (
            <>
              <div className="hidden md:block">
                <TableScroll label="Team members">
                  <table className="dt">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Signs in as</th>
                        <th scope="col">Role</th>
                        <th scope="col">Last sign-in</th>
                        <th scope="col">Access</th>
                        <th scope="col"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {staff.map((m) => {
                        const self = m.user_id === profile?.user_id
                        return (
                          <tr key={m.user_id} className={m.is_active ? '' : 'text-muted'}>
                            <td className="font-semibold">{m.display_name}{self && <span className="ml-1.5 text-xs font-semibold text-muted">(you)</span>}</td>
                            <td className="font-mono text-[13px]">{loginName(m.email)}</td>
                            <td>
                              <select
                                aria-label={`Role for ${m.display_name}`}
                                className="field-input !min-h-9 !w-auto !rounded-md !py-1 text-sm"
                                value={m.role}
                                disabled={self || busy === m.user_id}
                                onChange={(e) => void update(m, { role: e.target.value as StaffRole }, `${m.display_name} is now ${e.target.value === 'owner' ? 'an owner' : 'kitchen staff'}`)}
                              >
                                <option value="kitchen">Kitchen</option>
                                <option value="owner">Owner</option>
                              </select>
                            </td>
                            <td className="whitespace-nowrap text-muted" title={m.last_sign_in_at ? dateTime(m.last_sign_in_at) : undefined}>
                              {m.last_sign_in_at ? ago(m.last_sign_in_at) : 'Never'}
                            </td>
                            <td>
                              <Switch
                                checked={m.is_active}
                                label={`${m.display_name} can sign in`}
                                disabled={self || busy === m.user_id}
                                onChange={(v) => (v ? void update(m, { is_active: true }, `Access restored for ${m.display_name}`) : setRemoving(m))}
                              />
                            </td>
                            <td>
                              <Button size="sm" variant="ghost" onClick={() => setResetting(m)} aria-label={`Reset password for ${m.display_name}`} title="Reset password">
                                <IconKey size={16} />
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </TableScroll>
              </div>
              <ul className="divide-y divide-line md:hidden">
                {staff.map((m) => {
                  const self = m.user_id === profile?.user_id
                  return (
                    <li key={m.user_id} className="space-y-2 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold">{m.display_name}{self && <span className="ml-1.5 text-xs text-muted">(you)</span>}</p>
                          <p className="truncate font-mono text-[13px] text-muted">{loginName(m.email)}</p>
                          <p className="text-xs text-muted">Last sign-in: {m.last_sign_in_at ? ago(m.last_sign_in_at) : 'never'}</p>
                        </div>
                        <Switch
                          checked={m.is_active}
                          label={`${m.display_name} can sign in`}
                          disabled={self || busy === m.user_id}
                          onChange={(v) => (v ? void update(m, { is_active: true }, `Access restored for ${m.display_name}`) : setRemoving(m))}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={`Role for ${m.display_name}`}
                          className="field-input !min-h-9 !w-auto !rounded-md !py-1 text-sm"
                          value={m.role}
                          disabled={self || busy === m.user_id}
                          onChange={(e) => void update(m, { role: e.target.value as StaffRole }, 'Role updated')}
                        >
                          <option value="kitchen">Kitchen</option>
                          <option value="owner">Owner</option>
                        </select>
                        <Button size="sm" variant="secondary" onClick={() => setResetting(m)}><IconKey size={15} /> Reset password</Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Roles">
            <dl className="space-y-4 text-sm">
              {ROLES.map((r) => (
                <div key={r.value}>
                  <dt className="font-bold">{r.label}</dt>
                  <dd className="mt-0.5 text-muted">{r.can}</dd>
                  <dd className="mt-0.5 text-muted">{r.cannot}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Banner tone="info" title="Running the counter yourself?">
            You don’t need any other logins — the owner account can do everything. Add a kitchen login only for helpers, so they never see profits or the UPI ID, and the audit log shows who did what.
          </Banner>
        </div>
      </div>

      {adding && <AddMemberDrawer onClose={() => setAdding(false)} onAdded={() => void load()} />}
      {resetting && <ResetPasswordDrawer member={resetting} onClose={() => setResetting(null)} />}

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove access for ${removing.display_name}?` : ''}
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setRemoving(null)}>Keep access</Button>
            <Button variant="danger" className="flex-1" loading={!!removing && busy === removing.user_id} onClick={() => removing && void update(removing, { is_active: false }, `Access removed for ${removing.display_name}`)}>
              Remove access
            </Button>
          </div>
        }
      >
        <p className="p-5 text-sm">They won’t be able to use the staff console any more. Their past actions stay in the audit log. You can restore access later.</p>
      </Dialog>
    </PageBody>
  )
}

function PasswordField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(true)
  return (
    <div>
      <div className="flex gap-2">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          className="field-input font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          minLength={8}
          maxLength={72}
        />
        <Button variant="secondary" onClick={() => setShow((s) => !s)} aria-pressed={!show}>{show ? 'Hide' : 'Show'}</Button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>At least 8 characters.</span>
        <button type="button" className="font-semibold text-ink underline" onClick={() => onChange(suggestPassword())}>Suggest a password</button>
      </div>
    </div>
  )
}

function Credentials({ login, password }: { login: string; password: string }) {
  const toast = useToast()
  const text = `Bite & Sip staff login\nSign in at: ${window.location.origin}/staff/login\nUsername: ${login}\nPassword: ${password}`
  return (
    <div className="space-y-3">
      <Banner tone="success" title="Done">Share these with them privately. The password isn’t shown again.</Banner>
      <dl className="rounded-lg border border-line bg-sunken p-4 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-muted">Username</dt><dd className="font-mono font-bold">{login}</dd></div>
        <div className="mt-2 flex justify-between gap-3"><dt className="text-muted">Password</dt><dd className="font-mono font-bold">{password}</dd></div>
      </dl>
      <Button
        variant="secondary"
        className="w-full"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => toast('Copied', 'success'), () => toast('Couldn’t copy. Select the text instead.', 'error'))
        }}
      >
        <IconCopy size={16} /> Copy login details
      </Button>
    </div>
  )
}

function AddMemberDrawer({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const ids = { name: useId(), login: useId(), password: useId() }
  const [name, setName] = useState('')
  const [login, setLogin] = useState('')
  const [role, setRole] = useState<StaffRole>('kitchen')
  const [password, setPassword] = useState(suggestPassword)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ login: string; password: string } | null>(null)

  async function save() {
    if (!name.trim()) return setError('Enter their name.')
    if (!/^[a-z0-9._-]{2,40}$/i.test(login.trim()) && !login.includes('@')) return setError('Usernames can use letters, numbers, dots, dashes and underscores (2–40 characters).')
    if (password.length < 8) return setError('Use a password of at least 8 characters.')
    setBusy(true)
    setError(null)
    try {
      await backend.createStaff({ login: login.trim(), display_name: name.trim(), role, password })
      setDone({ login: loginName(toLoginEmail(login)), password })
      onAdded()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={done ? 'Team member added' : 'Add team member'}
      footer={
        done ? (
          <Button className="w-full" onClick={onClose}><IconCheck size={16} /> Finish</Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button className="flex-[2]" loading={busy} onClick={() => void save()}>Create login</Button>
          </div>
        )
      }
    >
      <div className="space-y-5 p-5">
        {done ? (
          <Credentials {...done} />
        ) : (
          <>
            <div>
              <label htmlFor={ids.name} className="label">Name</label>
              <input id={ids.name} className="field-input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ravi" />
            </div>
            <div>
              <label htmlFor={ids.login} className="label">Username</label>
              <input
                id={ids.login}
                className="field-input font-mono"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={80}
                value={login}
                onChange={(e) => setLogin(e.target.value.toLowerCase().replace(/\s/g, ''))}
                placeholder="e.g. ravi"
              />
              <p className="mt-1.5 text-xs text-muted">They type this to sign in. An email address works too.</p>
            </div>
            <fieldset>
              <legend className="label">Role</legend>
              <div className="space-y-2">
                {ROLES.map((r) => (
                  <label key={r.value} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${role === r.value ? 'border-ink ring-1 ring-ink' : 'border-line-strong'}`}>
                    <input type="radio" name="new-role" className="mt-1 size-4 accent-ink" checked={role === r.value} onChange={() => setRole(r.value)} />
                    <span>
                      <span className="block text-sm font-bold">{r.label}</span>
                      <span className="block text-xs text-muted">{r.can}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label htmlFor={ids.password} className="label">Password</label>
              <PasswordField id={ids.password} value={password} onChange={setPassword} />
            </div>
            {error && <Banner tone="danger">{error}</Banner>}
          </>
        )}
      </div>
    </Dialog>
  )
}

function ResetPasswordDrawer({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const id = useId()
  const [password, setPassword] = useState(suggestPassword)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function save() {
    if (password.length < 8) return setError('Use a password of at least 8 characters.')
    setBusy(true)
    setError(null)
    try {
      await backend.resetStaffPassword(member.user_id, password)
      setDone(true)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={`Reset password for ${member.display_name}`}
      footer={
        done ? (
          <Button className="w-full" onClick={onClose}><IconCheck size={16} /> Finish</Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button className="flex-[2]" loading={busy} onClick={() => void save()}>Set new password</Button>
          </div>
        )
      }
    >
      <div className="space-y-5 p-5">
        {done ? (
          <Credentials login={loginName(member.email)} password={password} />
        ) : (
          <>
            <p className="text-sm text-muted">They’ll need the new password the next time they sign in. To lock someone out immediately, turn off their access instead. This is recorded in the audit log.</p>
            <div>
              <label htmlFor={id} className="label">New password</label>
              <PasswordField id={id} value={password} onChange={setPassword} />
            </div>
            {error && <Banner tone="danger">{error}</Banner>}
          </>
        )}
      </div>
    </Dialog>
  )
}
