# Desktop releases

Mac and Windows use one source branch, `master`, one version, and one GitHub release. Windows reads `latest.yml` through `electron-updater`. Mac reads `appcast.xml` through Sparkle. The Mac ZIP in the appcast is signed with this app's Sparkle Ed25519 key. The app bundle itself uses free ad hoc signing.

## First Sparkle release

Version 1.8.1 is the first Mac build with Sparkle. People using a Mac build from 1.8.0 or earlier must install the 1.8.1 DMG once. Later releases can update in the app. The ad hoc signature does not remove macOS Gatekeeper warnings during the first install.

## Publish a new version

1. Update `package.json` and `package-lock.json` together, for example `npm version patch --no-git-tag-version`.
2. Commit and push the change to `master`.
3. Tag that exact commit with `v<version>` and push the tag.

The `Release desktop apps` workflow builds a universal Mac DMG and ZIP and both Windows EXEs. It signs the Mac update ZIP, creates `appcast.xml`, and stages all files on a draft GitHub release. It publishes the release only after both platform builds and asset checks pass. If a build fails, the draft remains unpublished. Rerun the failed workflow after fixing the problem. Do not publish an incomplete draft by hand.

The public Mac feed is `https://github.com/Tanjim-Islam/localhost-dashboard/releases/latest/download/appcast.xml`. Windows continues to use `latest.yml` from the same latest release. The Mac appcast uses a versioned GitHub URL for each ZIP, so older update entries stay available.

## Signing key

`SPARKLE_ED_PRIVATE_KEY` is stored as a GitHub Actions repository secret. Its local backup is `~/Library/Application Support/LocalhostDashboardRelease/sparkle-ed25519.private`, with owner-only file permissions. Keep that backup safe. Never commit or paste the private key into an issue or release. Its public key is in `package.json` as `SUPublicEDKey`.

No Apple Team ID or paid Developer ID certificate is used. Sparkle validates the signed update ZIP with the Ed25519 key. The build workflow verifies the app's ad hoc code signature, both bridge architectures, the DMG, and the generated appcast before publishing.

## Verify an update

For the first release, install the 1.8.1 DMG on a Mac and check that the app opens. For the next release, use that installed app to check, download, and install the update. Verify the new version in the running app. A successful build and valid appcast alone do not prove that a real installation updated.
