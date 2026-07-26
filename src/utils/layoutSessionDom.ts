/**
 * DOM-side resolution of "the layout session the user is looking at".
 *
 * With the layout-session host mounted (`LayoutSessionHost`), several warm
 * sessions coexist in the DOM — each subtree carries a
 * `data-layout-session-id`, the ACTIVE one's wrapper additionally carries
 * `data-layout-session-active` (and hidden wrappers are `inert`). A bare
 * `document.querySelector('[data-layout-session-id]')` is therefore
 * first-match-wins over N candidates and can land on a hidden session.
 *
 * The fallback preserves single-session behavior byte-for-byte: when the
 * host never rendered (today's default), no active marker exists and the
 * only `data-layout-session-id` in the DOM is the one LayoutRenderer puts
 * on its layout root — exactly what call sites matched before.
 */
export const activeLayoutSessionElement = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null
  return (
    document.querySelector<HTMLElement>('[data-layout-session-active]') ??
    document.querySelector<HTMLElement>('[data-layout-session-id]')
  )
}
