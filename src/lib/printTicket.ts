// Prints a kitchen ticket sized for 58/80 mm receipt printers (also fine on A4).
// Uses a hidden iframe, so no pop-up is opened and nothing else on the page prints.
import { money, orderCode, timeOfDay } from './format'
import { slotLabel } from './schedule'
import type { StaffOrder } from './types'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function ticketHtml(order: StaffOrder, cafeName: string): string {
  const where = order.table_label ? `TABLE ${esc(order.table_label)}` : 'COUNTER PICKUP'
  const lines = order.items
    .map((l) => `
      <div class="line"><b>${l.quantity}×</b> <span>${esc(l.name)}</span></div>
      ${l.addons.length ? `<div class="sub">+ ${esc(l.addons.map((a) => a.name).join(', '))}</div>` : ''}
      ${l.note ? `<div class="note">NOTE: ${esc(l.note)}</div>` : ''}`)
    .join('')
  const paid = order.payment_status === 'paid' ? 'PAID' : `${order.payment_method === 'cash' ? 'CASH' : 'UPI'} · NOT PAID`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${orderCode(order.order_no)}</title>
<style>
  @page { margin: 4mm; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 72mm; font: 14px/1.35 ui-monospace, "Courier New", monospace; color: #000; }
  .c { text-align: center; }
  .no { font-size: 30px; font-weight: 800; letter-spacing: -0.5px; }
  .where { font-size: 20px; font-weight: 800; border: 2px solid #000; padding: 2px 6px; display: inline-block; margin: 4px 0; }
  .pre { font-size: 16px; font-weight: 800; }
  hr { border: 0; border-top: 1px dashed #000; margin: 8px 0; }
  .line { font-size: 17px; margin-top: 4px; }
  .sub { padding-left: 26px; }
  .note { padding-left: 26px; font-weight: 800; }
  .small { font-size: 12px; }
</style></head><body>
  <div class="c small">${esc(cafeName)}</div>
  <div class="c no">${orderCode(order.order_no)}</div>
  <div class="c"><span class="where">${where}</span></div>
  ${order.scheduled_for ? `<div class="c pre">PRE-ORDER FOR ${esc(slotLabel(order.scheduled_for))}</div>` : ''}
  <div class="c small">${esc(order.customer_name)} · ${timeOfDay(order.created_at)}</div>
  <hr>${lines}<hr>
  <div class="small">${order.item_count} item(s) · ${money(order.total)} · ${paid}</div>
</body></html>`
}

export function printTicket(order: StaffOrder, cafeName: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open()
  doc.write(ticketHtml(order, cafeName))
  doc.close()
  const done = () => setTimeout(() => frame.remove(), 1000)
  frame.contentWindow!.addEventListener('afterprint', done, { once: true })
  setTimeout(() => {
    frame.contentWindow!.focus()
    frame.contentWindow!.print()
    // Some browsers never fire afterprint for iframes.
    setTimeout(done, 60000)
  }, 50)
}
