# LOL Match Recorder

Desktop app (Electron, system tray) that records your League of Legends matches to review them: from champ select to the end of the game, with your microphone and optionally your Discord voice chat, so the commentary during the draft and the game is in the video.

## Features

- Starts recording when champ select starts, keeps recording through the loading screen and the match, and stops when the match ends (from the League Client's gameflow phase)
- If champ select ends without a match (you or someone else dodged, or the client closed), the recording is deleted
- Matches without champ select (Practice Tool, custom games without draft) are recorded from the loading screen
- Main screen at 30 fps, encoded on the GPU (NVIDIA NVENC, AMD AMF or Intel Quick Sync, else x264 on the CPU), plus the microphone. The game sound is not recorded.
- Optionally records your Discord voice chat, without the game or other apps, mixed with your microphone into one audio track
- Saved as `YYYY-MM-DD_HH-mm_<Queue>_<Champion>.mp4` in `Videos\LOL Match Recorder` by default
- Records to `.mkv` while the match runs, so a crash or a power cut still leaves a playable file, then turns it into `.mp4` at the end

## Install

1. Download `LOL-Match-Recorder-Setup-<version>.exe` from the [latest release](https://github.com/khanhtq2802/lol-match-recorder/releases/latest).
2. Run it. It installs the app for your Windows user (no admin rights needed), adds a desktop and Start menu shortcut, and starts the app.
3. Windows may show "Windows protected your PC" because the installer is not signed: click `More info`, then `Run anyway`.

To update, run the setup of the new version, your settings are kept. To uninstall, use `Settings > Apps > Installed apps > LOL Match Recorder`.

## How to use

1. Run the app. It sits in the system tray (red dot on the icon while recording). The packaged app starts with Windows (untick "Start with Windows" in the tray menu to stop it).
2. Pick your microphone in the tray menu (`Microphone`). By default it uses the first one found.
3. To record your Discord voice chat, tick `Record Discord voice chat` in the tray menu. It is off by default.
4. Play. Recording starts and stops by itself, a notification tells you when a recording is saved or deleted.

Tray menu:

- `Stop and keep the recording` / `Stop and delete the recording` while recording. The current match is then not recorded again.
- `Auto record` turns the automatic recording off and on
- `Record Discord voice chat` turns the Discord audio on and off, from the next recording on
- `Quality`: 6, 8 (default) or 12 Mbps. 8 Mbps is about 60 MB per minute, about 2 GB for a 35 minute match.
- `Open the recordings folder`, `Change the folder...`

Quitting the app while recording saves the recording.

## Notes

- The screen is captured with the Desktop Duplication API, it works with the game in Borderless, Windowed and Fullscreen mode.
- `ffmpeg.exe` (from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)) and `process-audio.exe` are not signed: Windows Smart App Control may block them.
- Discord recording needs the Discord desktop app (not the browser version) and Windows 10 version 2004 or newer. It records whatever Discord plays, including its notification sounds. It can start up to 2 seconds late when Discord is opened during a recording.
- Use headphones with Discord recording: on speakers your microphone also picks up the voices, so they are recorded twice.
- Discord recording records other people: tell them, the law may require their consent where you or they live.
- When a recording fails, the ffmpeg output of the last recording is in `%APPDATA%\lol-match-recorder\ffmpeg-last.log`.

## Getting started

Requires Node >= 18 and Windows (the Discord audio helper in `native/` is compiled with the C# compiler that comes with Windows).

```sh
# install dependencies (downloads ffmpeg)
npm i

# start the app
npm start

# package the app into dist/win-unpacked ("LOL Match Recorder.exe")
npm run dist

# build the installer (dist/LOL-Match-Recorder-Setup-<version>.exe)
npm run release
```
