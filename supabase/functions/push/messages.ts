// What each notification says. Staff messages are in English; students get
// their chosen language (the same three the app offers).

export type Lang = 'en' | 'hi' | 'te'

export interface PushEvent {
  event: 'order_placed' | 'order_ready' | 'order_cancelled' | 'upi_reported' | 'service_request'
  order_id?: string
  order_no?: number
  total?: number
  payment_method?: 'cash' | 'upi'
  table_label?: string | null
  scheduled_for?: string | null
  items?: string | null
  cancel_reason?: string | null
  kind?: 'water' | 'cutlery' | 'clean' | 'bill' | 'help'
}

/** Read by the service worker. */
export interface Notice {
  title: string
  body: string
  /** Same tag replaces the earlier notification instead of stacking. */
  tag: string
  url: string
  /** Keep on screen until tapped (staff alerts). */
  sticky?: boolean
}

const time = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso))

const HELP: Record<NonNullable<PushEvent['kind']>, string> = {
  water: 'Water, please',
  cutlery: 'Spoon / plate, please',
  clean: 'Please clean the table',
  bill: 'Wants to pay',
  help: 'Needs help',
}

export function staffNotice(e: PushEvent): Notice | null {
  const no = `BS-${e.order_no}`
  switch (e.event) {
    case 'order_placed': {
      const where = e.table_label ? `Table ${e.table_label}` : 'Counter pickup'
      const when = e.scheduled_for ? ` · pre-order for ${time(e.scheduled_for)}` : ''
      return {
        title: `New order ${no} · ₹${e.total} ${e.payment_method === 'upi' ? 'UPI' : 'cash'}`,
        body: `${where}${when}\n${e.items ?? ''}`.trim(),
        tag: `order-${e.order_no}`,
        url: '/staff',
        sticky: true,
      }
    }
    case 'upi_reported':
      return {
        title: `${no} says paid ₹${e.total} by UPI`,
        body: 'Check your UPI app, then confirm the payment on the board.',
        tag: `upi-${e.order_no}`,
        url: '/staff',
        sticky: true,
      }
    case 'service_request':
      return {
        title: `Table ${e.table_label}: ${HELP[e.kind ?? 'help']}`,
        body: 'Tap to open the orders board.',
        tag: `help-${e.table_label}-${e.kind}`,
        url: '/staff',
        sticky: true,
      }
    default:
      return null
  }
}

const READY_TITLE: Record<Lang, (no: string) => string> = {
  en: (no) => `Your order ${no} is ready`,
  hi: (no) => `आपका ऑर्डर ${no} तैयार है`,
  te: (no) => `మీ ఆర్డర్ ${no} సిద్ధంగా ఉంది`,
}
const READY_COUNTER: Record<Lang, string> = {
  en: 'Please collect it at the counter.',
  hi: 'कृपया काउंटर से ले लें।',
  te: 'దయచేసి కౌంటర్ వద్ద తీసుకోండి.',
}
const READY_TABLE: Record<Lang, (t: string) => string> = {
  en: (t) => `We’re bringing it to table ${t}.`,
  hi: (t) => `हम इसे टेबल ${t} पर ला रहे हैं।`,
  te: (t) => `మేము దీన్ని టేబుల్ ${t} కు తీసుకొస్తున్నాం.`,
}
const CANCEL_TITLE: Record<Lang, (no: string) => string> = {
  en: (no) => `Order ${no} was cancelled`,
  hi: (no) => `ऑर्डर ${no} रद्द कर दिया गया`,
  te: (no) => `ఆర్డర్ ${no} రద్దు చేయబడింది`,
}
const CANCEL_BODY: Record<Lang, string> = {
  en: 'Tap to see why.',
  hi: 'कारण देखने के लिए टैप करें।',
  te: 'కారణం చూడటానికి నొక్కండి.',
}

export function studentNotice(e: PushEvent, lang: Lang): Notice | null {
  const no = `BS-${e.order_no}`
  const url = `/order/${e.order_id}`
  if (e.event === 'order_ready') {
    return {
      title: READY_TITLE[lang](no),
      body: e.table_label ? READY_TABLE[lang](e.table_label) : READY_COUNTER[lang],
      tag: `order-${e.order_no}`,
      url,
    }
  }
  if (e.event === 'order_cancelled') {
    return {
      title: CANCEL_TITLE[lang](no),
      body: e.cancel_reason ? `${e.cancel_reason}` : CANCEL_BODY[lang],
      tag: `order-${e.order_no}`,
      url,
    }
  }
  return null
}
