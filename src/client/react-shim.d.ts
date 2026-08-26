// DSH Web seeds `react` into its shared browser platform module table.
// This package intentionally does not ship a second React runtime; the small
// ambient face keeps standalone plugin typecheck aligned with the APIs used by
// this client contribution while the built client.js resolves `react` from DSH.
declare module 'react' {
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void]
}
