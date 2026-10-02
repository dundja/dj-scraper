# Engine version fixtures

Recorded 2026-10-02 on macOS 26.5.1 (arm64), stdout only unless noted.

| File | Command | Build |
|---|---|---|
| `ytdlp-version-2026.08.19.txt` | `yt-dlp --ignore-config --no-update --version` | Homebrew yt-dlp 2026.08.19 (stable, variant `pip`) |
| `ytdlp-version-2026.09.27.232945.txt` | same | nightly `yt-dlp_macos.zip` (variant `darwin_dir`) |
| `ffmpeg-version-8.0-brew.txt`, `ffprobe-version-8.0-brew.txt` | `ffmpeg -version`, `ffprobe -version` | Homebrew ffmpeg 8.0_1 |
| `ffmpeg-version-9.0.2-tessus.txt` | `ffmpeg -version` | evermeet.cx release 9.0.2 (x86_64) |
| `ffmpeg-version-N-127085-tessus.txt` | `ffmpeg -version` | evermeet.cx snapshot N-127085-g0eb6a369c69 (x86_64) |
| `deno-version-2.9.7.txt` | `deno --version` | Homebrew deno 2.9.7 |
