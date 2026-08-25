declare module 'react' {
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void]
}
