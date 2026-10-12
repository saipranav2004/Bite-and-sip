import { useNavigate } from 'react-router-dom'
import { useToast } from '../../components/ui'
import { useT } from '../../i18n'
import { planReorder } from '../../lib/reorder'
import type { CustomerOrder } from '../../lib/types'
import { useCart } from '../../state/cart'
import { useStudentData } from '../../state/publicData'

/** Adds a past order's items (as they are on today's menu) to the cart and opens it. */
export function useReorder() {
  const { data } = useStudentData()
  const cart = useCart()
  const toast = useToast()
  const navigate = useNavigate()
  const { t } = useT()
  return (order: Pick<CustomerOrder, 'items'>) => {
    if (!data) return
    const plan = planReorder(order, data.menu.items, data.stock)
    if (plan.lines.length === 0) {
      toast(t('again.none'), 'error')
      return
    }
    for (const l of plan.lines) cart.add(l.menu_item_id, l.addon_ids, l.quantity, l.note)
    toast(plan.skipped ? t('again.partial', { count: plan.skipped }) : t('again.added'), plan.skipped ? 'default' : 'success')
    navigate('/cart', { viewTransition: true })
  }
}
