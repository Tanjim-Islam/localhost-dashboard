# Desktop releases

Windows x64 and universal macOS share one version, one tag on `master` and one GitHub release. The Rust app reads `latest.json`. Windows installs a signed NSIS update. Both Mac architectures install the same signed application archive.

## Signing configuration

Set the repository Actions variable `TAURI_UPDATER_PUBLIC_KEY` to the full base64 public key produced by the Tauri signer. Set the corresponding repository secret `TAURI_SIGNING_PRIVATE_KEY` and, for a password-protected key, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a private backup outside this repository. An installed Tauri application trusts the verifier embedded at build time. Changing that verifier requires an update that existing clients can authenticate.

The existing `SPARKLE_ED_PRIVATE_KEY` secret signs the ZIP for installed Electron Mac clients. Its verifier remains in `src-tauri/Info.plist`. Tauri and Sparkle use independent keys. The release workflow supplies Tauri signing as a release-only override. Local development and packaging need no signing secrets. The Mac application uses ad hoc Apple code signing. First-time installation can still show Gatekeeper prompts.

## Publish a version

1. Increment the version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`. Refresh `src-tauri/Cargo.lock` and verify the local-dashboard package entry. The first Tauri release must be newer than the last published Electron version. Use a new patch version for a Mac-only correction too. Tauri compares semantic versions.
2. Write changes-only notes in `docs/releases/vVERSION.md`, replacing VERSION with the release version. Run the project checks and the release feed test, then integrate the release commit into `master`.
3. Tag the exact verified commit as `vVERSION` and push the tag. The workflow validates the manifests, lockfiles, notes and ancestry, then creates or reuses a draft.
4. The Windows runner builds the installer and portable executable. On a disposable runner, the upgrade test installs the checksum-pinned 1.13.0 package, upgrades it with the new installer and checks that the new executable starts and imports the previous settings. The Mac runner builds for arm64 and x86_64, checks the code signature and bundled architectures, verifies the DMG and extracted updater archive, and signs a ZIP for Sparkle.
5. The publishing job waits for both builds. It verifies the two Tauri signatures and their signed version, the Sparkle signature and the Windows SHA-512 metadata. It uploads all files to the draft, downloads them again and compares their contents before publishing. It then fetches the three public feeds and compares them with the verified files. A prepublication failure leaves the draft unpublished. Rerun the failed job after addressing the cause.

## Updating existing installations

| Installed build | Discovery feed | Download |
| --- | --- | --- |
| Tauri, Windows x64 | latest.json | Localhost-Dashboard-Setup-VERSION.exe |
| Tauri, Apple Silicon or Intel | latest.json | Localhost-Dashboard-VERSION-universal.app.tar.gz |
| Electron, installed Windows app | latest.yml | The NSIS installer with SHA-512 and blockmap |
| Electron, Sparkle-enabled Mac app | appcast.xml | Localhost-Dashboard-VERSION-universal.zip with its Ed25519 signature |
| Mac before 1.8.1, or a manually managed portable installation | Manual download | Universal DMG or portable Windows EXE |

The [Tauri feed](https://github.com/Tanjim-Islam/localhost-dashboard/releases/latest/download/latest.json), [legacy Windows feed](https://github.com/Tanjim-Islam/localhost-dashboard/releases/latest/download/latest.yml) and [Sparkle feed](https://github.com/Tanjim-Islam/localhost-dashboard/releases/latest/download/appcast.xml) point to assets in versioned releases. The portable Windows EXE uses the installed WebView2 runtime. The installer can provision that runtime on a clean machine.

The installer recognizes the standard per-user Windows installation under `%LOCALAPPDATA%\Programs\local-dashboard` by its registry key, executable and app.asar. It calls the shipped uninstaller in upgrade mode and leaves profile data for first-launch migration. Retire a custom or machine-wide installation manually after checking the new app. Keep the old profile until the new app shows the expected settings and projects.

## Verify before a public rollout

Run the release test with npm dependencies installed.

~~~sh
node --test scripts/release.test.mjs
~~~

The fixture creates temporary Ed25519 keys, signs files with the real Tauri CLI, verifies the Mac and Windows entries, and checks that altered files fail validation. To verify a release candidate end to end, exercise an upgrade on a disposable Windows profile and on a Mac with the prior version installed. Check the version inside the launched app and verify settings, projects and recent scripts. On macOS, exercise both the Sparkle transition and a subsequent Tauri-to-Tauri update.
