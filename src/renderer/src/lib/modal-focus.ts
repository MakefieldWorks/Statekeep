/** Shared modal policy: contain focus, make background inert, restore the opener. */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
const inertOwners = new WeakMap<HTMLElement, { count: number; original: boolean }>()

export function modalFocus(element: HTMLElement) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const background: HTMLElement[] = []
  // Inert sibling branches, never an ancestor of the dialog. This works for
  // dialogs nested in panels as well as overlays mounted directly in App.
  for (let branch: HTMLElement = element; branch.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.tagName === 'SCRIPT') continue
      const owner = inertOwners.get(sibling) ?? { count: 0, original: sibling.inert }
      owner.count++
      inertOwners.set(sibling, owner)
      sibling.inert = true
      background.push(sibling)
    }
    if (branch.parentElement === document.body) break
  }
  const candidates = () => [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(node => node.getClientRects().length > 0 && !node.closest('[inert]'))
  const focusInitial = () => {
    const target = element.querySelector<HTMLElement>('[data-initial-focus]')
      ?? candidates().find(node => node.matches('input, select, textarea'))
      ?? candidates()[0]
    ;(target ?? element).focus()
  }
  if (!element.hasAttribute('tabindex')) element.tabIndex = -1
  queueMicrotask(() => { if (element.isConnected && !element.contains(document.activeElement)) focusInitial() })
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const nodes = candidates()
    const first = nodes[0], last = nodes.at(-1)
    if (!first) { event.preventDefault(); element.focus(); return }
    if (!element.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }
  function focusin(event: FocusEvent) {
    if (!element.contains(event.target as Node)) focusInitial()
  }
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('focusin', focusin)
  return {
    destroy() {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      for (const node of background) {
        const owner = inertOwners.get(node)
        if (owner && --owner.count === 0) { node.inert = owner.original; inertOwners.delete(node) }
      }
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    },
  }
}
