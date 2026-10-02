// The few WHATWG globals packages/shared uses. This package gets neither lib.dom nor @types/node
// (tsconfig.base.json), so these are declared by hand; browsers and Node both provide them.
// Never import this file: the server and web programs bring their own, richer declarations, and
// code here must only use members declared below.

declare class URL {
  constructor(url: string, base?: string)
  static canParse(url: string, base?: string): boolean
  readonly hash: string
  readonly host: string
  /** Writable, as in WHATWG: classifyUrl drops a trailing dot through it. */
  hostname: string
  readonly href: string
  readonly origin: string
  readonly password: string
  readonly pathname: string
  readonly port: string
  readonly protocol: string
  readonly search: string
  readonly searchParams: URLSearchParams
  readonly username: string
  toString(): string
}

declare class URLSearchParams {
  constructor(init?: string)
  get(name: string): string | null
  getAll(name: string): string[]
  has(name: string): boolean
  toString(): string
}
