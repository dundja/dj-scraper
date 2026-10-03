import { createFileRoute } from '@tanstack/react-router'
import { ResolvePage } from '@/features/resolve/resolve-page.tsx'

/** Home: paste a link, then the track card or the collection it resolves to. */
export const Route = createFileRoute('/')({ component: ResolvePage })
