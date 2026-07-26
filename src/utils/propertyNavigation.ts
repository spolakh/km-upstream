export const PROPERTY_CREATE_REQUEST_EVENT = 'tm:property-create-request'

export interface PropertyCreateRequestDetail {
  blockId: string
  initialName: string
  seq: number
}

let propertyCreateRequestSeq = 0
const pendingCreateRequests = new Map<string, PropertyCreateRequestDetail>()

export const requestPropertyCreate = (args: {
  blockId: string
  initialName?: string
}): PropertyCreateRequestDetail => {
  const detail: PropertyCreateRequestDetail = {
    blockId: args.blockId,
    initialName: args.initialName ?? '',
    seq: ++propertyCreateRequestSeq,
  }
  pendingCreateRequests.set(args.blockId, detail)

  if (typeof window !== 'undefined') {
    // eslint-disable-next-line no-restricted-syntax -- genuine broadcast: per-block create request consumed by whichever property row is mounted (with a pendingCreateRequests fallback), not a singleton dialog/toggle
    window.dispatchEvent(new CustomEvent(PROPERTY_CREATE_REQUEST_EVENT, {detail}))
  }

  return detail
}

export const consumePendingPropertyCreateRequest = (
  blockId: string,
): PropertyCreateRequestDetail | undefined => {
  const detail = pendingCreateRequests.get(blockId)
  if (detail) pendingCreateRequests.delete(blockId)
  return detail
}

export const subscribePropertyCreateRequests = (
  blockId: string,
  handler: (detail: PropertyCreateRequestDetail) => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => {}

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PropertyCreateRequestDetail>).detail
    if (!detail || detail.blockId !== blockId) return
    pendingCreateRequests.delete(blockId)
    handler(detail)
  }

  window.addEventListener(PROPERTY_CREATE_REQUEST_EVENT, listener)
  return () => window.removeEventListener(PROPERTY_CREATE_REQUEST_EVENT, listener)
}

const PROPERTY_ROW_SELECTOR = '[data-property-row="true"]'
const PROPERTY_LABEL_SELECTOR = '[data-property-label="true"]'
const PROPERTY_VALUE_SELECTOR = '[data-property-value="true"]'
const PROPERTY_ROW_CONTROL_SELECTOR = '[data-property-row-control="true"]'
const PROPERTY_FOCUSABLE_SELECTOR = [
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[contenteditable="true"]',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const isVisibleElement = (element: HTMLElement): boolean => {
  if (typeof window === 'undefined' || !window.getComputedStyle) return true
  // Prefer checkVisibility: it walks ANCESTORS, so a property row inside a
  // warm-but-hidden layout session (display:none on some ancestor wrapper,
  // not the row itself — see LayoutSessionHost/layoutSessionDom.ts) reports
  // correctly invisible. The own-element style check below only ever saw
  // the row's own computed style, which is unaffected by an ancestor's
  // display:none and so falsely reported "visible". visibilityProperty
  // extends the ancestor walk to visibility:hidden too, matching the old
  // check's own-element visibility test. Fall back for environments
  // without checkVisibility (older browsers) — own-element check only,
  // exactly the prior behavior.
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({visibilityProperty: true})
  }
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

const isFocusableElement = (element: HTMLElement): boolean => {
  if (!isVisibleElement(element)) return false
  if ('disabled' in element && element.disabled === true) return false
  return true
}

const focusableWithin = (row: HTMLElement, selector: string): HTMLElement[] => {
  const root = row.querySelector<HTMLElement>(selector)
  if (!root) return []

  const rootIsFocusable = root.matches(PROPERTY_FOCUSABLE_SELECTOR) || root.hasAttribute('tabindex')
  const candidates = [
    ...(rootIsFocusable ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(PROPERTY_FOCUSABLE_SELECTOR)),
  ]
  return candidates.filter(isFocusableElement)
}

const focusableFallbacks = (row: HTMLElement): HTMLElement[] =>
  Array.from(row.querySelectorAll<HTMLElement>(PROPERTY_FOCUSABLE_SELECTOR))
    .filter(element => !element.closest(PROPERTY_ROW_CONTROL_SELECTOR))
    .filter(isFocusableElement)

export const getPropertyRows = (blockId: string): HTMLElement[] => {
  if (typeof document === 'undefined') return []
  return Array.from(document.querySelectorAll<HTMLElement>(PROPERTY_ROW_SELECTOR))
    .filter(row => row.dataset.blockId === blockId && isVisibleElement(row))
}

export const getPropertyRowFocusTarget = (
  row: HTMLElement,
  edge: 'start' | 'end' = 'end',
): HTMLElement | null => {
  const labelTargets = focusableWithin(row, PROPERTY_LABEL_SELECTOR)
  const valueTargets = focusableWithin(row, PROPERTY_VALUE_SELECTOR)
  const orderedTargets = edge === 'start'
    ? [...labelTargets, ...valueTargets]
    : [...valueTargets, ...labelTargets]

  return orderedTargets[0] ?? focusableFallbacks(row)[0] ?? null
}

const placeCaret = (target: HTMLElement, edge: 'start' | 'end') => {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const pos = edge === 'start' ? 0 : target.value.length
    try {
      target.setSelectionRange(pos, pos)
    } catch {
      // Some input types (date, number) do not support text selection.
    }
  }
}

export const focusPropertyRowElement = (
  row: HTMLElement,
  edge: 'start' | 'end' = 'end',
): boolean => {
  const target = getPropertyRowFocusTarget(row, edge)
  if (!target) return false
  target.focus()
  placeCaret(target, edge)
  return true
}

export const focusPropertyRow = (
  blockId: string,
  position: 'first' | 'last',
): boolean => {
  const rows = getPropertyRows(blockId)
  const row = position === 'first' ? rows[0] : rows.at(-1)
  return row ? focusPropertyRowElement(row, position === 'first' ? 'start' : 'end') : false
}

export const focusPropertyRowByName = (
  blockId: string,
  name: string,
): boolean => {
  const row = getPropertyRows(blockId)
    .find(candidate => candidate.dataset.propertyName === name)
  return row ? focusPropertyRowElement(row) : false
}

export const focusPropertyRowByNameWhenReady = (
  blockId: string,
  name: string,
  attempts = 8,
): void => {
  if (focusPropertyRowByName(blockId, name)) return
  if (attempts <= 0 || typeof requestAnimationFrame === 'undefined') return
  requestAnimationFrame(() => focusPropertyRowByNameWhenReady(blockId, name, attempts - 1))
}

export const focusAdjacentPropertyRow = (
  blockId: string,
  currentRow: HTMLElement,
  direction: -1 | 1,
): boolean => {
  const rows = getPropertyRows(blockId)
  const index = rows.indexOf(currentRow)
  if (index < 0) return false
  const next = rows[index + direction]
  return next ? focusPropertyRowElement(next, direction < 0 ? 'end' : 'start') : false
}
