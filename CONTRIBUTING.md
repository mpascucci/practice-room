# Contributing

Thanks for your interest in Practice Room! Bug reports, suggestions and pull requests are welcome. The app is meant to stay simple, so please open an issue to discuss larger features before writing code.

## License of contributions

Practice Room is released under the [PolyForm Noncommercial License 1.0.0](LICENSE) and the author also offers separate commercial licenses.

By submitting a contribution (pull request, patch or any other code, text or asset), you agree that:

1. you wrote it yourself, or you have the right to submit it, and it does not include code or assets under terms that conflict with this project's license;
2. you license it to the project under the same PolyForm Noncommercial License 1.0.0;
3. you also grant the project author (Marco Pascucci) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, sublicense and relicense your contribution, including under commercial or different license terms.

If you are not comfortable with this, please do not submit code, but feel free to open an issue instead.

## Third-party material

- The app has no third-party code dependencies, and we'd like to keep it that way. Please do not add libraries without discussing it first.
- Any new sound, image or font must come with its source and license, which must allow redistribution and non-commercial use. Add it to [app/CREDITS.md](app/CREDITS.md) in the same pull request.
- Do not copy code from projects whose license is incompatible with this one (for example GPL code).

## Practicalities

- Keep the offline behavior working: new files must be listed in `app/sw.js`.
- Settings stay on the device: no tracking, no analytics, no external requests.
