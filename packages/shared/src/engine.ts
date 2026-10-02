// The engine versions DJ Scraper needs. The server checks them; the server log and the UI word
// what falls short with healthProblems (health-problems.ts).

/**
 * First yt-dlp release with --js-runtimes (EJS solver), which we always pass: older builds reject
 * it, so every real call would fail. A zero-padded ISO day, so it compares correctly as a string.
 */
export const YTDLP_MIN_RELEASE = '2025-11-12'

/** YouTube changes often and the fix is usually a newer yt-dlp, so warn past this age. */
export const YTDLP_STALE_AFTER_DAYS = 60

/** ffmpeg and ffprobe: since 8, plain releases need none of yt-dlp's FFmpeg-Builds patches. */
export const FFMPEG_MIN_MAJOR = 8

/** yt-dlp's MIN_SUPPORTED_VERSION for deno (yt_dlp/utils/_jsruntime.py); it skips older ones. */
export const DENO_MIN_VERSION = [2, 3, 0] as const

/** yt-dlp's MIN_SUPPORTED_VERSION for node (yt_dlp/utils/_jsruntime.py); it skips older ones. */
export const NODE_MIN_VERSION = [22, 0, 0] as const
