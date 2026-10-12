import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { backend } from '../../backend'
import type { MenuItemInput } from '../../backend/types'
import { PageBody, PageHeader } from '../../components/admin'
import { FoodImage } from '../../components/FoodArt'
import { IconEdit, IconImage, IconPlus, IconSearch, IconTrash } from '../../components/icons'
import { Banner, Button, Dialog, EmptyState, Spinner, Switch, useToast, VegMark } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { money, percent } from '../../lib/format'
import { prepareMenuPhoto } from '../../lib/image'
import { isRemovableImage } from '../../lib/images'
import type { Category, Costs, Ingredient, MenuItem, Recipes } from '../../lib/types'
import { toBase, UNITS, unitsFor, type Unit } from '../../lib/units'
import { cleanText } from '../../lib/validation'
import { usePublicData } from '../../state/publicData'
import { useStaffSession } from '../../state/staffSession'

export function MenuManager() {
  const { data, refresh } = usePublicData()
  const { profile } = useStaffSession()
  const toast = useToast()
  const isOwner = profile?.role === 'owner'
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null)
  const [catsOpen, setCatsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [costs, setCosts] = useState<Costs | null>(null)
  const [ingredients, setIngredients] = useState<Ingredient[] | null>(null)
  const [recipes, setRecipes] = useState<Recipes | null>(null)
  const [missingOnly, setMissingOnly] = useState(false)

  const loadCosts = useCallback(async () => {
    if (!isOwner) return
    const [c, i, r] = await Promise.allSettled([backend.getCosts(), backend.listIngredients(), backend.getRecipes()])
    setCosts(c.status === 'fulfilled' ? c.value : null)
    // Recipes are only editable when both lists loaded, so a failed load can never wipe a recipe.
    const ok = i.status === 'fulfilled' && r.status === 'fulfilled'
    setIngredients(ok ? i.value : null)
    setRecipes(ok ? r.value : null)
  }, [isOwner])
  useEffect(() => {
    void loadCosts()
  }, [loadCosts])

  const categories = useMemo(() => (data ? [...data.menu.categories].sort((a, b) => a.sort_order - b.sort_order) : []), [data])
  if (!data) return <div className="grid place-items-center py-24"><Spinner label="Loading menu" /></div>

  const q = query.trim().toLowerCase()
  const missing = costs ? data.menu.items.filter((i) => costs.items[i.id] === undefined) : []
  const items = data.menu.items.filter((i) => (!q || i.name.toLowerCase().includes(q)) && (!missingOnly || missing.includes(i)))
  const soldOut = data.menu.items.filter((i) => !i.is_available).length
  const stockOf = (id: string) => data.stock.find((s) => s.menu_item_id === id)

  async function toggle(key: string, fn: () => Promise<void>, msg: string) {
    setPending((p) => new Set(p).add(key))
    try {
      await fn()
      await refresh()
      toast(msg, 'success')
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setPending((p) => {
        const n = new Set(p)
        n.delete(key)
        return n
      })
    }
  }

  return (
    <PageBody>
      <PageHeader
        title="Menu"
        subtitle={
          <>
            {data.menu.items.length} items · {soldOut} sold out
            {!isOwner && ' · You can mark items sold out or back in stock.'}
          </>
        }
        actions={
          isOwner && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setCatsOpen(true)}>Categories</Button>
              <Button size="sm" onClick={() => setEditing('new')}>
                <IconPlus size={16} /> Add item
              </Button>
            </>
          )
        }
      />

      {isOwner && missing.length > 0 && (
        <Banner
          tone="warning"
          className="mb-4"
          title={`${missing.length} ${missing.length === 1 ? 'item has' : 'items have'} no cost`}
          action={
            <Button size="sm" variant={missingOnly ? 'dark' : 'secondary'} aria-pressed={missingOnly} onClick={() => setMissingOnly((v) => !v)}>
              {missingOnly ? 'Show all' : 'Show them'}
            </Button>
          }
        >
          Add what each item costs you to make, so Profit & loss can show your real margins.
        </Banner>
      )}

      <div className="relative">
        <IconSearch className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-subtle" />
        <input type="search" aria-label="Search items" className="field-input pl-11" placeholder="Search items" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {categories.map((c) => {
        const list = items.filter((i) => i.category_id === c.id)
        if (list.length === 0 && (q || missingOnly)) return null
        return (
          <section key={c.id} className="mt-6" aria-labelledby={`mc-${c.id}`}>
            <h2 id={`mc-${c.id}`} className="mb-2 text-sm font-extrabold tracking-wide text-ink-2 uppercase">{c.name}</h2>
            {list.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">No items in this category.</p>
            ) : (
              <ul className="card divide-y divide-line overflow-hidden">
                {list.map((item) => (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="size-14 shrink-0 overflow-hidden rounded-xl ring-1 ring-line">
                        <FoodImage name={item.name} category={c.name} path={item.image_path} className={`size-full ${item.is_available ? '' : 'grayscale'}`} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 font-bold">
                          <VegMark veg={item.is_veg} /> <span className="truncate">{item.name}</span>
                        </p>
                        <p className="tabular text-sm text-muted">
                          {money(item.price)}
                          {costs && <CostNote price={item.price} cost={costs.items[item.id]} />}
                          {item.addons.length > 0 && ` · ${item.addons.length} add-on${item.addons.length > 1 ? 's' : ''}`}
                          {item.is_popular && ' · Popular'}
                          {stockOf(item.id) && ` · ${stockOf(item.id)!.on_hand} in stock`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`hidden text-xs font-bold sm:inline ${item.is_available ? 'text-ready' : 'text-danger'}`}>
                          {item.is_available ? 'In stock' : 'Sold out'}
                        </span>
                        <Switch
                          checked={item.is_available}
                          disabled={pending.has(item.id)}
                          label={`${item.name} available`}
                          onChange={(v) => void toggle(item.id, () => backend.setItemAvailability(item.id, v), `${item.name} ${v ? 'back in stock' : 'marked sold out'}`)}
                        />
                        {isOwner && (
                          <Button size="sm" variant="ghost" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item)}>
                            <IconEdit size={18} />
                          </Button>
                        )}
                      </div>
                    </div>
                    {item.addons.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-2 pl-[4.25rem]">
                        {item.addons.map((a) => (
                          <li key={a.id}>
                            <button
                              type="button"
                              disabled={pending.has(a.id)}
                              aria-pressed={a.is_available}
                              onClick={() => void toggle(a.id, () => backend.setAddonAvailability(a.id, !a.is_available), `${a.name} ${a.is_available ? 'marked sold out' : 'back in stock'}`)}
                              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-bold ${
                                a.is_available ? 'border-line-strong bg-surface text-ink-2' : 'border-danger/30 bg-danger-soft text-danger line-through'
                              }`}
                              title={a.is_available ? 'Tap to mark sold out' : 'Tap to mark available'}
                            >
                              {a.name} +{money(a.price)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
      {items.length === 0 && (q || missingOnly) && <EmptyState title={q ? `No items match “${query.trim()}”` : 'Every item has a cost'} />}

      {isOwner && (
        <ItemEditor
          key={editing === 'new' ? 'new' : editing?.id ?? 'none'}
          open={!!editing}
          item={editing === 'new' ? null : editing}
          categories={categories}
          costs={costs}
          ingredients={ingredients}
          recipe={editing && editing !== 'new' && recipes ? recipes[editing.id] ?? [] : []}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            await Promise.all([refresh(), loadCosts()])
            setEditing(null)
            toast(msg, 'success')
          }}
        />
      )}
      {isOwner && <CategoryManager open={catsOpen} onClose={() => setCatsOpen(false)} categories={categories} items={data.menu.items} onChanged={refresh} />}
    </PageBody>
  )
}

function CostNote({ price, cost }: { price: number; cost: number | undefined }) {
  if (cost === undefined) return <span className="font-semibold text-[#8a4b00]"> · No cost set</span>
  const margin = price - cost
  return (
    <span className={margin < 0 ? 'font-semibold text-danger' : ''}>
      {' '}· cost {money(cost)} · {percent(price ? margin / price : null, 0)} margin
    </span>
  )
}

interface RecipeDraft {
  ingredient_id: string
  qty: string
  unit: Unit
}

interface AddonDraft {
  id?: string
  name: string
  price: string
  cost: string
  is_available: boolean
}

function ItemEditor({
  open, item, categories, costs, onClose, onSaved,
  ingredients, recipe,
}: {
  open: boolean
  item: MenuItem | null
  categories: Category[]
  costs: Costs | null
  ingredients: Ingredient[] | null
  recipe: { ingredient_id: string; quantity: number }[]
  onClose: () => void
  onSaved: (msg: string) => Promise<void>
}) {
  const toast = useToast()
  const [name, setName] = useState(item?.name ?? '')
  const [categoryId, setCategoryId] = useState(item?.category_id ?? categories[0]?.id ?? '')
  const [price, setPrice] = useState(item ? String(item.price) : '')
  const initialCost = item && costs ? costs.items[item.id] : undefined
  const [cost, setCost] = useState(initialCost === undefined ? '' : String(initialCost))
  const [description, setDescription] = useState(item?.description ?? '')
  const [isVeg, setIsVeg] = useState(item?.is_veg ?? true)
  const [available, setAvailable] = useState(item?.is_available ?? true)
  const [popular, setPopular] = useState(item?.is_popular ?? false)
  const [imagePath, setImagePath] = useState<string | null>(item?.image_path ?? null)
  const [addons, setAddons] = useState<AddonDraft[]>(
    item?.addons.map((a) => ({
      id: a.id, name: a.name, price: String(a.price), is_available: a.is_available,
      cost: costs?.addons[a.id] === undefined ? '' : String(costs.addons[a.id]),
    })) ?? [],
  )
  const showCosts = costs !== null
  const ingById = new Map((ingredients ?? []).map((i) => [i.id, i]))
  const toDrafts = () =>
    recipe
      .filter((l) => ingById.has(l.ingredient_id))
      .map((l) => ({ ingredient_id: l.ingredient_id, qty: String(l.quantity), unit: ingById.get(l.ingredient_id)!.base_unit as Unit }))
  // null until raw materials and recipes have loaded; until then a save leaves the recipe untouched.
  const [draftRows, setRecipeRows] = useState<RecipeDraft[] | null>(() => (ingredients ? toDrafts() : null))
  useEffect(() => {
    if (draftRows === null && ingredients) setRecipeRows(toDrafts())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredients])
  const showRecipe = draftRows !== null
  const recipeRows = draftRows ?? []
  const recipeCost = recipeRows.reduce<number | null>((sum, r) => {
    const ing = ingById.get(r.ingredient_id)
    const q = Number(r.qty)
    if (sum === null || !ing || !(q > 0)) return sum
    if (ing.cost_per_unit === null) return null
    return sum + toBase(q, r.unit) * ing.cost_per_unit
  }, 0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploaded = useRef<string[]>([])
  const ids = { name: useId(), cat: useId(), price: useId(), desc: useId(), cost: useId() }
  const priceN = Number(price)
  const costN = cost.trim() === '' ? null : Number(cost)

  const closeAndCleanup = () => {
    // Drop photos uploaded in this session but never saved.
    for (const p of uploaded.current) if (p !== item?.image_path) void backend.removeImage(p)
    uploaded.current = []
    onClose()
  }

  async function onPickPhoto(file: File | undefined) {
    if (!file) return
    setUploading(true)
    try {
      const blob = await prepareMenuPhoto(file)
      const path = await backend.uploadImage(blob)
      uploaded.current.push(path)
      setImagePath(path)
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function validate(): MenuItemInput | null {
    const e: Record<string, string> = {}
    const cleanName = cleanText(name)
    if (!cleanName) e.name = 'Enter a name.'
    else if (cleanName.length > 60) e.name = 'Keep the name under 60 characters.'
    const p = Number(price)
    if (!/^\d+$/.test(price.trim()) || p < 1 || p > 5000) e.price = 'Enter a whole-rupee price between 1 and 5000.'
    if (!categoryId) e.category = 'Choose a category.'
    if (description.length > 200) e.description = 'Keep the description under 200 characters.'
    if (cost.trim() !== '' && (!/^\d+$/.test(cost.trim()) || Number(cost) > 5000)) e.cost = 'Enter a whole-rupee cost up to 5000, or leave it empty.'
    const seenIng = new Set<string>()
    recipeRows.forEach((r, i) => {
      const q = Number(r.qty)
      if (!r.ingredient_id) e[`recipe-${i}`] = 'Choose a raw material or remove the line.'
      else if (seenIng.has(r.ingredient_id)) e[`recipe-${i}`] = 'This raw material is already in the recipe.'
      else if (!(q > 0) || toBase(q, r.unit) > 100000) e[`recipe-${i}`] = 'Enter a quantity above zero.'
      seenIng.add(r.ingredient_id)
    })
    const seen = new Set<string>()
    addons.forEach((a, i) => {
      const n = cleanText(a.name)
      if (!n) e[`addon-${i}`] = 'Name the add-on or remove it.'
      else if (n.length > 40) e[`addon-${i}`] = 'Keep add-on names under 40 characters.'
      else if (seen.has(n.toLowerCase())) e[`addon-${i}`] = 'Two add-ons have the same name.'
      seen.add(n.toLowerCase())
      if (!/^\d+$/.test(a.price.trim()) || Number(a.price) > 1000) e[`addon-${i}`] = e[`addon-${i}`] ?? 'Add-on price must be 0–1000.'
      if (a.cost.trim() !== '' && (!/^\d+$/.test(a.cost.trim()) || Number(a.cost) > 1000)) e[`addon-${i}`] = e[`addon-${i}`] ?? 'Add-on cost must be 0–1000, or empty.'
    })
    setErrors(e)
    if (Object.keys(e).length) return null
    return {
      id: item?.id,
      category_id: categoryId,
      name: cleanName,
      description: cleanText(description),
      price: p,
      is_veg: isVeg,
      is_available: available,
      is_popular: popular,
      image_path: imagePath,
      ...(showCosts ? { cost: cost.trim() === '' ? null : Number(cost) } : {}),
      ...(showRecipe ? { recipe: recipeRows.map((r) => ({ ingredient_id: r.ingredient_id, quantity: toBase(Number(r.qty), r.unit) })) } : {}),
      addons: addons.map((a) => ({
        id: a.id, name: cleanText(a.name), price: Number(a.price), is_available: a.is_available,
        ...(showCosts ? { cost: a.cost.trim() === '' ? null : Number(a.cost) } : {}),
      })),
    }
  }

  async function save(ev: FormEvent) {
    ev.preventDefault()
    const input = validate()
    if (!input) return
    setSaving(true)
    try {
      await backend.saveMenuItem(input)
      // Remove the previous photo once the new one is saved.
      if (item?.image_path && isRemovableImage(item.image_path) && item.image_path !== imagePath) void backend.removeImage(item.image_path)
      for (const p of uploaded.current) if (p !== imagePath) void backend.removeImage(p)
      uploaded.current = []
      await onSaved(item ? `${input.name} updated` : `${input.name} added to the menu`)
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!item) return
    setSaving(true)
    try {
      await backend.deleteMenuItem(item.id)
      if (item.image_path && isRemovableImage(item.image_path)) void backend.removeImage(item.image_path)
      await onSaved(`${item.name} deleted`)
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setSaving(false)
      setConfirmDelete(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={closeAndCleanup}
      title={item ? `Edit ${item.name}` : 'Add menu item'}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center gap-3">
          {item && !confirmDelete && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              <IconTrash size={16} /> Delete
            </Button>
          )}
          {item && confirmDelete && (
            <span className="flex items-center gap-2 text-sm font-semibold">
              Delete permanently?
              <Button size="sm" variant="danger" loading={saving} onClick={() => void remove()}>Yes, delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>No</Button>
            </span>
          )}
          <div className="ml-auto flex gap-3">
            <Button variant="secondary" onClick={closeAndCleanup}>Cancel</Button>
            <Button type="submit" form="item-form" loading={saving} disabled={uploading}>Save</Button>
          </div>
        </div>
      }
    >
      <form id="item-form" onSubmit={save} noValidate className="grid gap-5 px-5 py-5 sm:grid-cols-[180px_1fr]">
        <div>
          <span className="label">Photo</span>
          <div className="relative aspect-square overflow-hidden rounded-2xl ring-1 ring-line">
            <FoodImage name={name || 'item'} path={imagePath} className="size-full" />
            {uploading && <div className="absolute inset-0 grid place-items-center bg-white/70"><Spinner label="Uploading photo" /></div>}
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="photo-input" onChange={(e) => void onPickPhoto(e.target.files?.[0])} />
          <div className="mt-2 flex gap-2">
            <label htmlFor="photo-input" className="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-field bg-surface px-2 text-sm font-bold hover:bg-sunken">
              <IconImage size={16} /> {imagePath ? 'Change' : 'Upload'}
            </label>
            {imagePath && (
              <Button size="sm" variant="ghost" onClick={() => setImagePath(null)}>Remove</Button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">Resized on this device before upload.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor={ids.name} className="label">Name</label>
            <input id={ids.name} className="field-input" maxLength={60} value={name} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
            {errors.name && <p className="mt-1 text-sm font-semibold text-danger">{errors.name}</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={ids.cat} className="label">Category</label>
              <select id={ids.cat} className="field-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {errors.category && <p className="mt-1 text-sm font-semibold text-danger">{errors.category}</p>}
            </div>
            <div>
              <label htmlFor={ids.price} className="label">Price (₹)</label>
              <input id={ids.price} className="field-input tabular" inputMode="numeric" value={price} aria-invalid={!!errors.price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, '').slice(0, 4))} />
              {errors.price && <p className="mt-1 text-sm font-semibold text-danger">{errors.price}</p>}
            </div>
          </div>
          {showCosts && (
            <div className="rounded-xl border border-line bg-sunken p-3">
              <div className="grid items-end gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={ids.cost} className="label">Cost to make (₹) <span className="font-normal text-muted">· only you see this</span></label>
                  <input id={ids.cost} className="field-input tabular" inputMode="numeric" placeholder="e.g. 12" value={cost} aria-invalid={!!errors.cost} onChange={(e) => setCost(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                </div>
                <p className="pb-3 text-sm" aria-live="polite">
                  {costN === null || !priceN ? (
                    <span className="text-muted">Ingredients + packaging for one. Leave empty if you don’t know yet.</span>
                  ) : (
                    <span className={priceN - costN < 0 ? 'font-semibold text-danger' : ''}>
                      Profit per sale <span className="tabular font-bold">{money(priceN - costN)}</span> · margin <span className="tabular font-bold">{percent((priceN - costN) / priceN, 0)}</span>
                      {priceN - costN < 0 && ' — this item loses money'}
                    </span>
                  )}
                </p>
              </div>
              {errors.cost && <p className="mt-1 text-sm font-semibold text-danger">{errors.cost}</p>}
            </div>
          )}
          <div>
            <label htmlFor={ids.desc} className="label">Description <span className="font-normal text-muted">(optional)</span></label>
            <textarea id={ids.desc} className="field-input min-h-20 resize-none" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <ToggleRow label="Vegetarian" checked={isVeg} onChange={setIsVeg} />
            <ToggleRow label="In stock" checked={available} onChange={setAvailable} />
            <ToggleRow label="Popular" checked={popular} onChange={setPopular} />
          </div>

          <fieldset>
            <legend className="label">Add-ons</legend>
            <div className="space-y-2">
              {addons.map((a, i) => (
                <div key={a.id ?? `new-${i}`}>
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`Add-on ${i + 1} name`}
                      className="field-input flex-1"
                      placeholder="e.g. Extra Cheese"
                      maxLength={40}
                      value={a.name}
                      aria-invalid={!!errors[`addon-${i}`]}
                      onChange={(e) => setAddons((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <div className="relative w-24">
                      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">+₹</span>
                      <input
                        aria-label={`Add-on ${i + 1} price`}
                        className="field-input tabular pl-8"
                        inputMode="numeric"
                        value={a.price}
                        onChange={(e) => setAddons((list) => list.map((x, j) => (j === i ? { ...x, price: e.target.value.replace(/\D/g, '').slice(0, 4) } : x)))}
                      />
                    </div>
                    {showCosts && (
                      <input
                        aria-label={`Add-on ${i + 1} cost`}
                        title="Cost to you (optional)"
                        className="field-input tabular w-20"
                        inputMode="numeric"
                        placeholder="cost"
                        value={a.cost}
                        onChange={(e) => setAddons((list) => list.map((x, j) => (j === i ? { ...x, cost: e.target.value.replace(/\D/g, '').slice(0, 4) } : x)))}
                      />
                    )}
                    <Button variant="ghost" size="sm" aria-label={`Remove add-on ${a.name || i + 1}`} onClick={() => setAddons((list) => list.filter((_, j) => j !== i))}>
                      <IconTrash size={16} />
                    </Button>
                  </div>
                  {errors[`addon-${i}`] && <p className="mt-1 text-sm font-semibold text-danger">{errors[`addon-${i}`]}</p>}
                </div>
              ))}
              {addons.length < 12 && (
                <Button variant="secondary" size="sm" onClick={() => setAddons((list) => [...list, { name: '', price: '0', cost: '', is_available: true }])}>
                  <IconPlus size={16} /> Add-on
                </Button>
              )}
            </div>
          </fieldset>
          {showRecipe && (
            <fieldset>
              <legend className="label">Recipe <span className="font-normal text-muted">(optional) · raw materials used for one</span></legend>
              {ingredients!.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line-strong px-4 py-3 text-sm text-muted">
                  Add raw materials in <Link to="/staff/inventory" className="font-semibold underline">Inventory</Link> first. Then each sale can use them up automatically.
                </p>
              ) : (
                <div className="space-y-2">
                  {recipeRows.map((r, i) => {
                    const ing = ingById.get(r.ingredient_id)
                    return (
                      <div key={i}>
                        <div className="flex items-center gap-2">
                          <select
                            aria-label={`Recipe line ${i + 1} raw material`}
                            className="field-input min-w-0 flex-1"
                            value={r.ingredient_id}
                            onChange={(e) => {
                              const next = ingById.get(e.target.value)
                              setRecipeRows((rows) => (rows ?? []).map((x, j) => (j === i ? { ...x, ingredient_id: e.target.value, unit: (next?.base_unit ?? x.unit) as Unit } : x)))
                            }}
                          >
                            <option value="">Choose…</option>
                            {ingredients!.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                          <input
                            aria-label={`Recipe line ${i + 1} quantity`}
                            className="field-input tabular w-20"
                            inputMode="decimal"
                            placeholder="0"
                            value={r.qty}
                            onChange={(e) => setRecipeRows((rows) => (rows ?? []).map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '').slice(0, 9) } : x)))}
                          />
                          <select
                            aria-label={`Recipe line ${i + 1} unit`}
                            className="field-input !w-auto"
                            value={r.unit}
                            disabled={!ing}
                            onChange={(e) => setRecipeRows((rows) => (rows ?? []).map((x, j) => (j === i ? { ...x, unit: e.target.value as Unit } : x)))}
                          >
                            {(ing ? unitsFor(ing.base_unit) : UNITS).map((u) => <option key={u.value} value={u.value}>{u.value}</option>)}
                          </select>
                          <Button variant="ghost" size="sm" aria-label={`Remove recipe line ${i + 1}`} onClick={() => setRecipeRows((rows) => (rows ?? []).filter((_, j) => j !== i))}>
                            <IconTrash size={16} />
                          </Button>
                        </div>
                        {errors[`recipe-${i}`] && <p className="mt-1 text-sm font-semibold text-danger">{errors[`recipe-${i}`]}</p>}
                      </div>
                    )
                  })}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {recipeRows.length < 30 && (
                      <Button variant="secondary" size="sm" onClick={() => setRecipeRows((rows) => [...(rows ?? []), { ingredient_id: '', qty: '', unit: 'g' }])}>
                        <IconPlus size={16} /> Raw material
                      </Button>
                    )}
                    {recipeRows.length > 0 && (
                      <p className="text-sm text-muted">
                        {recipeCost === null ? (
                          'Cost: record a purchase price for every raw material to see it.'
                        ) : (
                          <>
                            Ingredients cost about <span className="tabular font-bold text-ink">{money(Math.round(recipeCost * 100) / 100)}</span>
                            {showCosts && (
                              <button type="button" className="ml-2 font-semibold text-ink underline" onClick={() => setCost(String(Math.round(recipeCost)))}>
                                Use as cost
                              </button>
                            )}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted">Each sale uses these up; a cancelled order puts them back. Low stock never stops a student from ordering.</p>
                </div>
              )}
            </fieldset>
          )}
          {Object.keys(errors).length > 0 && <Banner tone="danger">Please fix the highlighted fields.</Banner>}
        </div>
      </form>
    </Dialog>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
      <span className="text-sm font-semibold">{label}</span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

function CategoryManager({
  open, onClose, categories, items, onChanged,
}: { open: boolean; onClose: () => void; categories: Category[]; items: MenuItem[]; onChanged: () => Promise<void> }) {
  const toast = useToast()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  async function run(key: string, fn: () => Promise<unknown>, msg: string) {
    setBusy(key)
    try {
      await fn()
      await onChanged()
      toast(msg, 'success')
      return true
    } catch (err) {
      toast(friendlyError(err), 'error')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function move(index: number, dir: -1 | 1) {
    const a = categories[index]
    const b = categories[index + dir]
    if (!a || !b) return
    await run(a.id, async () => {
      await backend.updateCategory(a.id, { sort_order: b.sort_order })
      await backend.updateCategory(b.id, { sort_order: a.sort_order })
    }, 'Order updated')
  }

  return (
    <Dialog open={open} onClose={onClose} title="Categories" size="md">
      <div className="space-y-4 px-5 py-4">
        <ul className="divide-y divide-line rounded-2xl ring-1 ring-line">
          {categories.map((c, i) => {
            const count = items.filter((x) => x.category_id === c.id).length
            return (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2">
                {renaming?.id === c.id ? (
                  <form
                    className="flex flex-1 gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      if (await run(c.id, () => backend.updateCategory(c.id, { name: renaming.name }), 'Category renamed')) setRenaming(null)
                    }}
                  >
                    <input aria-label="Category name" className="field-input py-2" maxLength={40} value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} />
                    <Button type="submit" size="sm" loading={busy === c.id}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1 font-semibold">
                      {c.name} <span className="text-sm text-muted">· {count}</span>
                    </span>
                    <Button size="sm" variant="ghost" aria-label={`Move ${c.name} up`} disabled={i === 0 || !!busy} onClick={() => void move(i, -1)}>↑</Button>
                    <Button size="sm" variant="ghost" aria-label={`Move ${c.name} down`} disabled={i === categories.length - 1 || !!busy} onClick={() => void move(i, 1)}>↓</Button>
                    <Button size="sm" variant="ghost" aria-label={`Rename ${c.name}`} onClick={() => setRenaming({ id: c.id, name: c.name })}><IconEdit size={16} /></Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${c.name}`}
                      disabled={count > 0 || !!busy}
                      title={count > 0 ? 'Move or delete its items first' : 'Delete category'}
                      onClick={() => void run(c.id, () => backend.deleteCategory(c.id), 'Category deleted')}
                    >
                      <IconTrash size={16} />
                    </Button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            const n = cleanText(newName)
            if (!n) return
            if (await run('new', () => backend.createCategory(n), `${n} added`)) setNewName('')
          }}
        >
          <input aria-label="New category name" className="field-input" maxLength={40} placeholder="New category, e.g. Desserts" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button type="submit" loading={busy === 'new'} disabled={!cleanText(newName)}>Add</Button>
        </form>
        <p className="text-xs text-muted">A category can only be deleted when it has no items.</p>
      </div>
    </Dialog>
  )
}
