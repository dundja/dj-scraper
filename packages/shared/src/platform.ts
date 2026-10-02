import * as z from 'zod'

export const PlatformSchema = z.enum(['youtube', 'soundcloud', 'other'])
export type Platform = z.infer<typeof PlatformSchema>
