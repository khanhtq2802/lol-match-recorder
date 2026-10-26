# LOL Match Recorder

Desktop app (Electron, system tray) that records your League of Legends matches to review them: from champ select to the end of the game, with your microphone, so your own commentary during the draft and the game is in the video.

## Features

- Starts recording when champ select starts, keeps recording through the loading screen and the match, and stops when the match ends (from the League Client's gameflow phase)
- If champ select ends without a match (you or someone else dodged, or the client closed), the recording is deleted
- Matches without champ select (Practice Tool, custom games without draft) are recorded from the loading screen
- Main screen at 30 fps, encoded on the GPU (NVIDIA NVENC, AMD AMF or Intel Quick Sync, else x264 on the CPU), plus the microphone. The game sound is not recorded.
- Saved as `YYYY-MM-DD_HH-mm_<Queue>_<Champion>.mp4` in `Videos\LOL Match Recorder` by default
- Records to `.mkv` while the match runs, so a crash or a power cut still leaves a playable file, then turns it into `.mp4` at the end

## How to use

1. Run the app. It sits in the system tray (red dot on the icon while recording). The packaged app starts with Windows (untick "Start with Windows" in the tray menu to stop it).
2. Pick your microphone in the tray menu (`Microphone`). By default it uses the first one found.
3. Play. Recording starts and stops by itself, a notification tells you when a recording is saved or deleted.

Tray menu:

- `Stop and keep the recording` / `Stop and delete the recording` while recording. The current match is then not recorded again.
- `Auto record` turns the automatic recording off and on
- `Quality`: 6, 8 (default) or 12 Mbps. 8 Mbps is about 60 MB per minute, about 2 GB for a 35 minute match.
- `Open the recordings folder`, `Change the folder...`

Quitting the app while recording saves the recording.

## Notes

- The screen is captured with the Desktop Duplication API, it works with the game in Borderless, Windowed and Fullscreen mode.
- `ffmpeg.exe` (from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)) is not signed: Windows Smart App Control may block it.
- When a recording fails, the ffmpeg output of the last recording is in `%APPDATA%\lol-match-recorder\ffmpeg-last.log`.

## Getting started

Requires Node >= 18.

```sh
# install dependencies (downloads ffmpeg)
npm i

# start the app
npm start

# package the app into dist/win-unpacked ("LOL Match Recorder.exe")
npm run dist

# build the release zip (dist/LOL-Match-Recorder-<version>-portable.zip)
npm run release
```
